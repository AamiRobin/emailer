// @vitest-environment node
/**
 * Task 18.6 receive-path tests (design D11): detection of the three PGP
 * shapes (PGP/MIME encrypted, PGP/MIME signed, inline armored blocks),
 * decryption against stored keys, signature trust classification
 * (valid / invalid / unknown-signer), and the failure kinds the render
 * path shows next to the original content (no private key, wrong
 * passphrase, no matching key, unreadable armor).
 *
 * Node environment (not jsdom) for the same reason as pgp-keys.test.ts:
 * openpgp's Uint8Array prototype checks span two realms under jsdom and
 * break its module init — a test-env artifact only, since the Tauri
 * webview has a single realm. Nothing here needs the DOM.
 *
 * Fixtures are REAL openpgp material: the account key is generated through
 * the 18.4 service (stored + wrapped exactly like production), send-side
 * fixtures reuse the 18.5 transforms so the receive path is proven against
 * the exact bytes the send path produces. The test file imports openpgp
 * statically for fixtures/assertions; the service under test must only
 * ever load it dynamically (source scan at the bottom).
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import * as openpgp from "openpgp"

import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { buildMimeMessage } from "../../email/mime-builder"
import { encryptMime, signAndEncryptMime } from "../pgp-transform"
import { importPrivateKey, importPublicKey } from "../pgp-keys"
import {
  combineSignatureStatuses,
  decryptArmored,
  decryptArmoredForAccount,
  detectPgpContent,
  extractArmoredMessage,
  findInlineArmoredBlocks,
  isPgpEncryptedPayloadAttachment,
  isPgpSignatureAttachment,
  loadDecryptionKeys,
  loadVerificationKeys,
  NO_SIGNATURE,
  parseDecryptedEntity,
  PgpReceiveError,
  spliceInlineBlocks,
  verifyClearSignedBlock,
  verifyClearSignedForAccount,
  verifyDetachedSignature,
  type SignatureStatus,
} from "../pgp-receive"
import pgpReceiveSource from "../pgp-receive.ts?raw"
import { setDefaultKeyStore } from "../key-management"
import { createInMemoryKeyStore } from "./in-memory-key-store"

const PASSPHRASE = "receive test passphrase 🔐"
const WRONG_PASSPHRASE = "not the passphrase"

const CRLF = "\r\n"

let executor: TestExecutor
let accountId: string
/** Second account with NO keys (the no-private-key fixture). */
let keylessAccountId: string

/** The protected account-key armor (generated once in beforeAll and
 * imported for the account in every beforeEach — the STORED key must be
 * the same key the send-side fixtures encrypt to). */
let meProtectedArmor: string

let mePrivate: openpgp.PrivateKey
let adaPrivate: openpgp.PrivateKey
let adaPublic: openpgp.PublicKey
let malloryPrivate: openpgp.PrivateKey
let malloryPublic: openpgp.PublicKey

/** A clear-signed block signed by Ada (imported signer). */
let adaClearSigned: string
/** A clear-signed block signed by Mallory (unimported signer). */
let malloryClearSigned: string

beforeAll(async () => {
  // The account key, generated ONCE: the beforeAll armor is both the
  // send-side fixture target and the key imported into storage below.
  const me = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [{ name: "Me User", email: "me@example.com" }],
    passphrase: PASSPHRASE,
    format: "armored",
  })
  meProtectedArmor = me.privateKey
  mePrivate = await openpgp.decryptKey({
    privateKey: await openpgp.readPrivateKey({ armoredKey: me.privateKey }),
    passphrase: PASSPHRASE,
  })

  // Known signer: public key is imported; private kept for signing.
  adaPrivate = await openpgp
    .generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: "Ada Lovelace", email: "ada@example.com" }],
      format: "armored",
    })
    .then((generated) =>
      openpgp.readPrivateKey({ armoredKey: generated.privateKey })
    )
  adaPublic = adaPrivate.toPublic()

  // Unknown signer: never imported.
  malloryPrivate = await openpgp
    .generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [{ name: "Mallory", email: "mallory@example.net" }],
      format: "armored",
    })
    .then((generated) =>
      openpgp.readPrivateKey({ armoredKey: generated.privateKey })
    )
  malloryPublic = malloryPrivate.toPublic()

  adaClearSigned = await openpgp.sign({
    message: await openpgp.createCleartextMessage({ text: "signed body" }),
    signingKeys: adaPrivate,
    format: "armored",
  })
  malloryClearSigned = await openpgp.sign({
    message: await openpgp.createCleartextMessage({
      text: "mallory's body",
    }),
    signingKeys: malloryPrivate,
    format: "armored",
  })
})

beforeEach(async () => {
  executor = createTestExecutor()
  setDefaultKeyStore(createInMemoryKeyStore())
  accountId = await createAccount(executor, "gmail")
  keylessAccountId = await createAccount(executor, "gmail")
  // Store the SAME key the fixtures encrypt to (the 18.4 import path —
  // generateKey here would create an unrelated key every test).
  await importPrivateKey(executor, accountId, meProtectedArmor, PASSPHRASE)
  await importPublicKey(executor, accountId, adaPublic.armor())
})

afterEach(() => {
  setDefaultKeyStore(null)
  vi.restoreAllMocks()
  executor.close()
})

/** The unlocked key pair the receive helpers consume, from storage. */
async function myKeys() {
  return {
    decryption: await loadDecryptionKeys(executor, accountId, PASSPHRASE),
    verification: await loadVerificationKeys(executor, accountId),
  }
}

/** A PGP/MIME-encrypted payload built by the SEND side (18.5): the exact
 * armored octet-stream part a receiver fetches from the attachment row. */
async function sendSideEncryptedArmor(options?: {
  signer?: openpgp.PrivateKey
  recipient?: openpgp.PublicKey
}): Promise<string> {
  const built = buildMimeMessage({
    from: { name: "Ada Lovelace", email: "ada@example.com" },
    to: [{ name: "Me User", email: "me@example.com" }],
    subject: "Hello",
    textBody: "plain text",
    messageId: "<enc@example.com>",
  })
  const transformed = options?.signer
    ? await signAndEncryptMime({
        built,
        signingKey: options.signer,
        encryptionArmors: [(options.recipient ?? mePrivate.toPublic()).armor()],
      })
    : await encryptMime({
        built,
        encryptionArmors: [
          (options?.recipient ?? mePrivate.toPublic()).armor(),
        ],
      })
  return extractArmoredMessage(transformed.mime)!
}

// ---- Detection -------------------------------------------------------------

describe("detectPgpContent", () => {
  it("finds inline encrypted armor in the text body", () => {
    const body = `hello\n-----BEGIN PGP MESSAGE-----\nbody\n-----END PGP MESSAGE-----\nbye`
    expect(
      detectPgpContent({ bodyText: body, bodyHtml: null, attachments: [] })
    ).toEqual({ kind: "inline-encrypted", source: "text" })
  })

  it("finds inline clear-signed blocks and prefers the text body over html", () => {
    const text = `see below\n-----BEGIN PGP SIGNED MESSAGE-----\nhi\n-----END PGP SIGNATURE-----`
    expect(
      detectPgpContent({
        bodyText: text,
        bodyHtml: "<p>no armor here</p>",
        attachments: [],
      })
    ).toEqual({ kind: "inline-signed", source: "text" })
    // Both bodies carry armor — the text body wins (the render path
    // decrypts from the text lane).
    expect(
      detectPgpContent({
        bodyText: text,
        bodyHtml: `-----BEGIN PGP MESSAGE-----\nx\n-----END PGP MESSAGE-----`,
        attachments: [],
      })
    ).toEqual({ kind: "inline-signed", source: "text" })
    expect(
      detectPgpContent({
        bodyText: null,
        bodyHtml: `-----BEGIN PGP MESSAGE-----\nx\n-----END PGP MESSAGE-----`,
        attachments: [],
      })
    ).toEqual({ kind: "inline-encrypted", source: "html" })
  })

  it("classifies RFC 3156 shapes from the attachment rows", () => {
    const encryptedPart = {
      filename: "encrypted.asc",
      mimeType: "application/octet-stream",
    }
    const signaturePart = {
      filename: "signature.asc",
      mimeType: "application/pgp-signature",
    }
    expect(
      detectPgpContent({
        bodyText: "no armor",
        bodyHtml: null,
        attachments: [encryptedPart],
      })
    ).toEqual({ kind: "pgp-mime-encrypted", source: "attachments" })
    expect(
      detectPgpContent({
        bodyText: "signed content",
        bodyHtml: null,
        attachments: [signaturePart],
      })
    ).toEqual({ kind: "pgp-mime-signed", source: "attachments" })
  })

  it("reports none for ordinary mail and for bare .asc attachments (public keys)", () => {
    expect(
      detectPgpContent({
        bodyText: "plain",
        bodyHtml: "<p>html</p>",
        attachments: [
          { filename: "key.asc", mimeType: "application/octet-stream" },
        ],
      })
    ).toEqual({ kind: "none", source: "attachments" })
    expect(
      detectPgpContent({ bodyText: null, bodyHtml: null, attachments: [] })
    ).toEqual({ kind: "none", source: "attachments" })
  })

  it("skips an incomplete inline block (missing END marker)", () => {
    const body = `-----BEGIN PGP MESSAGE-----\nnever closed`
    expect(
      detectPgpContent({ bodyText: body, bodyHtml: null, attachments: [] })
    ).toEqual({ kind: "none", source: "attachments" })
  })

  it("matches the RFC 3156 attachment conventions", () => {
    expect(
      isPgpEncryptedPayloadAttachment({
        filename: "encrypted.asc",
        mimeType: "application/octet-stream",
      })
    ).toBe(true)
    expect(
      isPgpEncryptedPayloadAttachment({
        filename: "secret.pgp",
        mimeType: null,
      })
    ).toBe(true)
    expect(
      isPgpEncryptedPayloadAttachment({
        filename: "encrypted.asc",
        mimeType: "application/pgp-encrypted",
      })
    ).toBe(true)
    // A bare key.asc is NOT an encrypted payload (public keys ride .asc too).
    expect(
      isPgpEncryptedPayloadAttachment({ filename: "key.asc", mimeType: null })
    ).toBe(false)
    expect(
      isPgpSignatureAttachment({
        filename: "signature.asc",
        mimeType: "application/pgp-signature",
      })
    ).toBe(true)
    expect(
      isPgpSignatureAttachment({ filename: "signature.asc", mimeType: null })
    ).toBe(true)
    expect(
      isPgpSignatureAttachment({ filename: "notes.asc", mimeType: null })
    ).toBe(false)
  })
})

// ---- Inline block surgery ----------------------------------------------------

describe("findInlineArmoredBlocks + spliceInlineBlocks", () => {
  it("locates blocks left-to-right across both kinds", () => {
    const encrypted =
      "-----BEGIN PGP MESSAGE-----\na\n-----END PGP MESSAGE-----"
    const signed =
      "-----BEGIN PGP SIGNED MESSAGE-----\nb\n-----END PGP SIGNATURE-----"
    const blocks = findInlineArmoredBlocks(`x ${signed} y ${encrypted} z`)
    expect(blocks.map((block) => block.kind)).toEqual(["signed", "encrypted"])
    expect(blocks.map((block) => block.block)).toEqual([signed, encrypted])
  })

  it("skips a truncated block that has no END marker anywhere after it", () => {
    expect(
      findInlineArmoredBlocks("start -----BEGIN PGP MESSAGE-----\ncut off")
    ).toEqual([])
  })

  it("splices replacements and keeps the original armor for null (failed) blocks", () => {
    const source = `before\n-----BEGIN PGP MESSAGE-----\na\n-----END PGP MESSAGE-----\nmid\n-----BEGIN PGP MESSAGE-----\na\n-----END PGP MESSAGE-----\nafter`
    const block = "-----BEGIN PGP MESSAGE-----\na\n-----END PGP MESSAGE-----"
    const spliced = spliceInlineBlocks(
      source,
      new Map([
        [block, "DECRYPTED"],
        ["-----BEGIN PGP MESSAGE-----\nother\n-----END PGP MESSAGE-----", null],
      ])
    )
    expect(spliced).toBe("before\nDECRYPTED\nmid\nDECRYPTED\nafter")
    // A failed block with no replacement entry leaves the source verbatim.
    expect(spliceInlineBlocks(source, new Map())).toBe(source)
  })
})

describe("extractArmoredMessage", () => {
  it("pulls the first complete PGP MESSAGE armor out of fetched part text", () => {
    const armor = "-----BEGIN PGP MESSAGE-----\na\n-----END PGP MESSAGE-----"
    expect(extractArmoredMessage(`Version: 1\n\n${armor}\ntrailing`)).toBe(
      armor
    )
    expect(extractArmoredMessage("no armor here")).toBeNull()
    expect(
      extractArmoredMessage("-----BEGIN PGP MESSAGE-----\nopen")
    ).toBeNull()
  })
})

// ---- Decryption ------------------------------------------------------------

describe("decryptArmored (PGP/MIME encrypted)", () => {
  it("decrypts a message encrypted to the account key (encrypt-to-self)", async () => {
    const armor = await sendSideEncryptedArmor()
    const { decryption, verification } = await myKeys()
    const result = await decryptArmored(armor, decryption, verification)
    expect(result.text).toContain("plain text")
    expect(result.html).toBeNull()
    expect(result.signature).toEqual(NO_SIGNATURE)
  })

  it("parses the inner multipart/alternative and prefers the html part", async () => {
    const built = buildMimeMessage({
      from: { name: "Ada", email: "ada@example.com" },
      to: [{ name: "Me", email: "me@example.com" }],
      subject: "Rich",
      textBody: "plain",
      htmlBody: "<p>rich body</p>",
      messageId: "<alt@example.com>",
    })
    const transformed = await encryptMime({
      built,
      encryptionArmors: [mePrivate.toPublic().armor()],
    })
    const { decryption, verification } = await myKeys()
    const result = await decryptArmored(
      extractArmoredMessage(transformed.mime)!,
      decryption,
      verification
    )
    expect(result.html).toContain("rich body")
    expect(result.text).toBeNull()
  })

  it("decrypts and verifies a sign+encrypt message (inner multipart/signed)", async () => {
    const armor = await sendSideEncryptedArmor({ signer: adaPrivate })
    const { decryption, verification } = await myKeys()
    const result = await decryptArmored(armor, decryption, verification)
    expect(result.text).toContain("plain text")
    // Ada's public key is imported — the signature is valid.
    expect(result.signature.trust).toBe("valid")
    expect(result.signature.keyIds).toHaveLength(1)
  })

  it("reports unknown-signer when the embedded signer is not imported", async () => {
    // Sign+encrypt by Mallory, encrypted to me: I can read it but the
    // signer's key was never imported.
    const built = buildMimeMessage({
      from: { name: "Mallory", email: "mallory@example.net" },
      to: [{ name: "Me", email: "me@example.com" }],
      subject: "Hello",
      textBody: "from mallory",
      messageId: "<mallory@example.net>",
    })
    const transformed = await signAndEncryptMime({
      built,
      signingKey: malloryPrivate,
      encryptionArmors: [mePrivate.toPublic().armor()],
    })
    const { decryption, verification } = await myKeys()
    const result = await decryptArmored(
      extractArmoredMessage(transformed.mime)!,
      decryption,
      verification
    )
    expect(result.text).toContain("from mallory")
    expect(result.signature.trust).toBe("unknown-signer")
  })

  it("verifies an embedded (one-pass) signature inside encrypted data", async () => {
    const armored = await openpgp.encrypt({
      message: await openpgp.createMessage({
        binary: new TextEncoder().encode("inner secret"),
      }),
      encryptionKeys: mePrivate.toPublic(),
      signingKeys: adaPrivate,
      format: "armored",
    })
    const { decryption, verification } = await myKeys()
    const result = await decryptArmored(armored, decryption, verification)
    expect(result.text).toBe("inner secret")
    expect(result.signature.trust).toBe("valid")
  })

  it("throws no-matching-key when only someone else's key can open it", async () => {
    const armor = await sendSideEncryptedArmor({ recipient: malloryPublic })
    const { decryption, verification } = await myKeys()
    await expect(
      decryptArmored(armor, decryption, verification)
    ).rejects.toMatchObject({
      name: "PgpReceiveError",
      kind: "no-matching-key",
    })
  })

  it("throws bad-armor for an unreadable payload (corrupt fixture)", async () => {
    const { decryption, verification } = await myKeys()
    await expect(
      decryptArmored(
        "-----BEGIN PGP MESSAGE-----\ngarbage\n-----END PGP MESSAGE-----",
        decryption,
        verification
      )
    ).rejects.toBeInstanceOf(PgpReceiveError)
    await expect(
      decryptArmored("not armor at all", decryption, verification)
    ).rejects.toMatchObject({ kind: "bad-armor" })
  })
})

// ---- Signature verification -------------------------------------------------

describe("verifyClearSignedBlock", () => {
  it("returns the signed text and a valid status for an imported signer", async () => {
    const { verification } = await myKeys()
    const result = await verifyClearSignedBlock(adaClearSigned, verification)
    expect(result.content).toContain("signed body")
    expect(result.signature.trust).toBe("valid")
    expect(result.signature.keyIds).toHaveLength(1)
  })

  it("reports unknown-signer (not invalid) for an unimported signer", async () => {
    const { verification } = await myKeys()
    const result = await verifyClearSignedBlock(
      malloryClearSigned,
      verification
    )
    expect(result.signature.trust).toBe("unknown-signer")
    // The content still comes back — trust is advisory, content is shown.
    expect(result.content).toContain("mallory's body")
  })

  it("reports invalid when an imported signer's content was tampered with", async () => {
    const { verification } = await myKeys()
    // Corrupt the signed payload between the armor markers.
    const tampered = adaClearSigned.replace("signed body", "tampered body")
    const result = await verifyClearSignedBlock(tampered, verification)
    expect(result.signature.trust).toBe("invalid")
  })

  it("throws bad-armor for an unreadable clear-signed block", async () => {
    const { verification } = await myKeys()
    await expect(
      verifyClearSignedBlock(
        "-----BEGIN PGP SIGNED MESSAGE-----\njunk",
        verification
      )
    ).rejects.toMatchObject({ kind: "bad-armor" })
  })

  it("returns content with an honest status when the verify machinery fails", async () => {
    // No verification keys at all: openpgp.verify throws; the content is
    // kept and the status degrades to unknown-signer (key not imported).
    const result = await verifyClearSignedBlock(adaClearSigned, [])
    expect(result.content).toContain("signed body")
    expect(result.signature.trust).toBe("unknown-signer")
  })
})

describe("verifyDetachedSignature", () => {
  /** The exact bytes an RFC 3156 signature covers: payload part + CRLF. */
  async function detachedFixture() {
    const data = "Content-Type: text/plain\r\n\r\nentity body"
    const armored = await openpgp.sign({
      message: await openpgp.createMessage({
        binary: new TextEncoder().encode(`${data}${CRLF}`),
      }),
      signingKeys: adaPrivate,
      format: "armored",
      detached: true,
    })
    return { data, armored }
  }

  it("verifies over the exact signed bytes (payload part + CRLF)", async () => {
    const { data, armored } = await detachedFixture()
    const { verification } = await myKeys()
    const status = await verifyDetachedSignature(
      `${data}${CRLF}`,
      armored,
      verification
    )
    expect(status.trust).toBe("valid")
  })

  it("reports invalid when the signed bytes changed", async () => {
    const { armored } = await detachedFixture()
    const { verification } = await myKeys()
    const status = await verifyDetachedSignature(
      `Content-Type: text/plain\r\n\r\ntampered${CRLF}`,
      armored,
      verification
    )
    expect(status.trust).toBe("invalid")
  })

  it("reports unknown-signer for an unimported signer", async () => {
    const data = "entity"
    const armored = await openpgp.sign({
      message: await openpgp.createMessage({
        binary: new TextEncoder().encode(`${data}${CRLF}`),
      }),
      signingKeys: malloryPrivate,
      format: "armored",
      detached: true,
    })
    const { verification } = await myKeys()
    expect(
      (await verifyDetachedSignature(`${data}${CRLF}`, armored, verification))
        .trust
    ).toBe("unknown-signer")
  })

  it("treats an unreadable signature armor as invalid, not unknown", async () => {
    const { verification } = await myKeys()
    expect(
      (await verifyDetachedSignature("x", "not armor", verification)).trust
    ).toBe("invalid")
  })
})

describe("combineSignatureStatuses", () => {
  it("aggregates best-wins: valid beats invalid beats unknown beats none", () => {
    expect(combineSignatureStatuses([])).toEqual(NO_SIGNATURE)
    expect(combineSignatureStatuses([NO_SIGNATURE]).trust).toBe("none")
    expect(
      combineSignatureStatuses([
        { trust: "unknown-signer", keyIds: ["A"] },
        { trust: "invalid", keyIds: ["B"] },
      ]).trust
    ).toBe("invalid")
    expect(
      combineSignatureStatuses([
        { trust: "invalid", keyIds: ["B"] },
        { trust: "valid", keyIds: ["C"] },
      ]).trust
    ).toBe("valid")
    // Key ids union across statuses.
    expect(
      combineSignatureStatuses([
        { trust: "valid", keyIds: ["A"] },
        { trust: "valid", keyIds: ["B"] },
      ]).keyIds
    ).toEqual(["A", "B"])
  })
})

// ---- Decrypted-entity parsing (pure) ---------------------------------------

describe("parseDecryptedEntity", () => {
  it("reads a bare inline literal (no headers) as plain text", async () => {
    const result = await parseDecryptedEntity("just text\nline two")
    expect(result.text).toBe("just text\nline two")
    expect(result.html).toBeNull()
    expect(result.signature).toEqual(NO_SIGNATURE)
  })

  it("routes a text/html entity to the html lane", async () => {
    const result = await parseDecryptedEntity(
      `Content-Type: text/html; charset=utf-8${CRLF}${CRLF}<p>hello</p>`
    )
    expect(result.html).toBe("<p>hello</p>")
  })

  it("decodes base64 and quoted-printable leaf parts", async () => {
    // btoa (not Buffer): the app tsconfig has no node types.
    const base64 = btoa("decoded body")
    const result = await parseDecryptedEntity(
      `Content-Transfer-Encoding: base64${CRLF}${CRLF}${base64}`
    )
    expect(result.text).toBe("decoded body")

    const qp = await parseDecryptedEntity(
      `Content-Transfer-Encoding: quoted-printable${CRLF}${CRLF}caf=C3=A9=\r\nnext`
    )
    expect(qp.text).toBe("cafénext")
  })

  it("takes the html part of a multipart/alternative", async () => {
    const boundary = "bnd"
    const entity = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      "plain",
      `--${boundary}`,
      "Content-Type: text/html",
      "",
      "<p>html</p>",
      `--${boundary}--`,
    ].join(CRLF)
    const result = await parseDecryptedEntity(entity)
    expect(result.html).toContain("<p>html</p>")
  })

  it("renders the first part of a multipart/mixed (attachments stay rows)", async () => {
    const boundary = "bnd"
    const entity = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      "the body",
      `--${boundary}`,
      'Content-Type: text/plain; name="notes.txt"',
      "Content-Disposition: attachment",
      "",
      "attached",
      `--${boundary}--`,
    ].join(CRLF)
    const result = await parseDecryptedEntity(entity)
    expect(result.text).toContain("the body")
    expect(result.text).not.toContain("attached")
  })

  it("verifies an inner multipart/signed over the exact bytes and parses part one", async () => {
    const boundary = "bnd"
    const partOne = ["Content-Type: text/plain", "", "signed content"].join(
      CRLF
    )
    const entity = [
      `Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      partOne,
      `--${boundary}`,
      "Content-Type: application/pgp-signature",
      "",
      "-----BEGIN PGP SIGNATURE-----\nsig\n-----END PGP SIGNATURE-----",
      `--${boundary}--`,
    ].join(CRLF)

    const verifyDetached = vi
      .fn<
        (signedData: string, signatureArmor: string) => Promise<SignatureStatus>
      >()
      .mockResolvedValue({ trust: "valid", keyIds: ["ABC"] })

    const result = await parseDecryptedEntity(entity, verifyDetached)
    expect(result.text).toContain("signed content")
    // RFC 3156 §5: the signed data is the part PLUS the delimiter CRLF.
    expect(verifyDetached).toHaveBeenCalledWith(
      `${partOne}${CRLF}`,
      expect.stringContaining("BEGIN PGP SIGNATURE")
    )
    expect(result.signature.trust).toBe("valid")
  })
})

// ---- pgp-keys-backed orchestrators -----------------------------------------

describe("loadDecryptionKeys", () => {
  it("throws no-private-key when the account holds no key", async () => {
    await expect(
      loadDecryptionKeys(executor, keylessAccountId, PASSPHRASE)
    ).rejects.toMatchObject({ kind: "no-private-key" })
  })

  it("throws wrong-passphrase when no stored key unlocks", async () => {
    await expect(
      loadDecryptionKeys(executor, accountId, WRONG_PASSPHRASE)
    ).rejects.toMatchObject({ kind: "wrong-passphrase" })
  })

  it("unlocks the keys whose passphrase matches (several keys, mixed passphrases)", async () => {
    // A second key with a DIFFERENT passphrase on the same account: the
    // attempt with the first passphrase still returns the first key.
    await importPrivateKey(
      executor,
      accountId,
      malloryPrivate.armor(),
      "mallory-passphrase"
    )
    const unlocked = await loadDecryptionKeys(executor, accountId, PASSPHRASE)
    expect(unlocked).toHaveLength(1)
    expect(unlocked[0].getFingerprint()).toBe(mePrivate.getFingerprint())
  })
})

describe("decryptArmoredForAccount + verifyClearSignedForAccount (stored keys)", () => {
  it("decrypts end-to-end through the stored, wrapped account key", async () => {
    const armor = await sendSideEncryptedArmor()
    const result = await decryptArmoredForAccount({
      executor,
      accountId,
      passphrase: PASSPHRASE,
      armored: armor,
    })
    expect(result.text).toContain("plain text")
    expect(result.signature).toEqual(NO_SIGNATURE)
  })

  it("surfaces wrong-passphrase from the orchestrator", async () => {
    const armor = await sendSideEncryptedArmor()
    await expect(
      decryptArmoredForAccount({
        executor,
        accountId,
        passphrase: WRONG_PASSPHRASE,
        armored: armor,
      })
    ).rejects.toMatchObject({ kind: "wrong-passphrase" })
  })

  it("verifies a clear-signed block through the stored public keys", async () => {
    const result = await verifyClearSignedForAccount({
      executor,
      accountId,
      clearSigned: adaClearSigned,
    })
    expect(result.signature.trust).toBe("valid")
    expect(result.content).toContain("signed body")
  })
})

// ---- Lazy-load discipline ----------------------------------------------------

describe("lazy loading", () => {
  it("module source has no static openpgp import (dynamic import only)", () => {
    // Same structural guard as pgp-keys.test.ts / pgp-transform.test.ts
    // (D11): the receive path's only openpgp dependency must be the
    // dynamic import() plus the type-only import.
    expect(pgpReceiveSource).not.toMatch(
      /^import\s(?!type\s)[^\n]*["']openpgp["']/m
    )
    expect(pgpReceiveSource).toContain('import("openpgp")')
    expect(pgpReceiveSource).toContain(
      'import type * as OpenPGP from "openpgp"'
    )
  })
})
