// @vitest-environment node
/**
 * Task 18.5 unit tests (design D11): the PGP/MIME transforms produce
 * RFC 3156 output that PARSES and ROUND-TRIPS — the detached signature
 * verifies over the exact payload bytes, the encrypted wrapper decrypts
 * back to the original entity with every recipient key (encrypt-to-self
 * included), and sign+encrypt nests them the standard way. The builder
 * hook (buildMimeMessagePgp) is exercised end-to-end with real keys.
 *
 * Node environment (not jsdom) for the same reason as pgp-keys.test.ts:
 * openpgp's Uint8Array prototype checks span two realms under jsdom and
 * break its module init — a test-env artifact only, since the Tauri
 * webview has a single realm. Nothing here needs the DOM.
 *
 * The test file imports openpgp statically for fixtures/assertions; the
 * service under test must only ever load it dynamically (source scan at
 * the bottom).
 */

import { beforeAll, describe, expect, it } from "vitest"

import * as openpgp from "openpgp"

import { buildMimeMessage, buildMimeMessagePgp } from "../../email/mime-builder"
import type { SendEmailInput } from "../../email/types"
import {
  encryptMime,
  PgpTransformError,
  signAndEncryptMime,
  signMime,
} from "../pgp-transform"
import pgpTransformSource from "../pgp-transform.ts?raw"

const CRLF = "\r\n"
const PASSPHRASE = "transform test passphrase 🔐"

let senderPrivate: openpgp.PrivateKey
let senderPublic: openpgp.PublicKey
let recipientPrivate: openpgp.PrivateKey

beforeAll(async () => {
  const sender = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [{ name: "Ada Lovelace", email: "ada@example.com" }],
    passphrase: PASSPHRASE,
    format: "armored",
  })
  senderPrivate = await openpgp.decryptKey({
    privateKey: await openpgp.readPrivateKey({ armoredKey: sender.privateKey }),
    passphrase: PASSPHRASE,
  })
  senderPublic = senderPrivate.toPublic()
  const recipient = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [{ name: "Grace Hopper", email: "grace@example.com" }],
    format: "armored",
  })
  recipientPrivate = await openpgp.readPrivateKey({
    armoredKey: recipient.privateKey,
  })
})

function baseInput(overrides: Partial<SendEmailInput> = {}): SendEmailInput {
  return {
    from: { name: "Me User", email: "me@example.com" },
    to: [{ name: "Grace", email: "grace@example.com" }],
    subject: "Hello",
    textBody: "plain text",
    messageId: "<my-id@example.com>",
    ...overrides,
  }
}

/** The built message's top-level Content-Type line. */
function builtContentType(mime: string): string {
  const match = mime.match(/^Content-Type: [^\r\n]*/m)
  if (!match) throw new Error("built message has no Content-Type")
  return match[0]
}

/** The built message's body (the builder's trailing CRLF stripped) —
 * exactly what the transforms wrap into the payload entity. */
function builtBody(mime: string): string {
  return mime.slice(mime.indexOf(`${CRLF}${CRLF}`) + 4).replace(/\r\n$/, "")
}

/** The built message as the transforms see it: Content-Type header +
 * blank line + body (the MIME entity RFC 3156 moves into the payload). */
function builtEntity(mime: string): string {
  return `${builtContentType(mime)}${CRLF}${CRLF}${builtBody(mime)}`
}

/** The boundary of the message's top-level multipart. */
function topBoundary(mime: string): string {
  const match = mime.match(/^Content-Type: [^\r\n]*boundary="([^"]+)"/m)
  if (!match) throw new Error("no top-level multipart boundary")
  return match[1]
}

/** The raw body of the FIRST part of the top-level multipart (headers +
 * blank line + content, exactly as stored between the delimiters). */
function firstPartBody(mime: string, boundary: string): string {
  const start = mime.indexOf(`--${boundary}${CRLF}`) + boundary.length + 4
  const end = mime.indexOf(`${CRLF}--${boundary}`, start)
  if (end === -1) throw new Error("multipart has no second boundary")
  return mime.slice(start, end)
}

function armorOf(mime: string, block: "SIGNATURE" | "MESSAGE"): string {
  const match = mime.match(
    new RegExp(
      `-----BEGIN PGP ${block}-----[\\s\\S]*?-----END PGP ${block}-----`
    )
  )
  if (!match) throw new Error(`no armored PGP ${block} in the output`)
  return match[0]
}

/**
 * Decrypt an armored message to the exact literal bytes (as UTF-8). The
 * binary format matters: openpgp's "utf8" decrypt normalizes CRLF to LF,
 * while the payload entity's CRLFs are part of the round-trip contract.
 */
async function decryptExact(
  armored: string,
  keys: openpgp.PrivateKey | openpgp.PrivateKey[]
): Promise<string> {
  const decrypted = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: armored }),
    decryptionKeys: keys,
    format: "binary",
  })
  return new TextDecoder().decode(decrypted.data)
}

describe("signMime", () => {
  it("wraps the built message in RFC 3156 multipart/signed", async () => {
    const built = buildMimeMessage(baseInput())
    const signed = await signMime({ built, signingKey: senderPrivate })

    // Top-level structure: same headers, Content-Type replaced last-position.
    expect(signed.messageId).toBe(built.messageId)
    expect(signed.mime).toContain("From: Me User <me@example.com>")
    expect(signed.mime).toContain("To: Grace <grace@example.com>")
    expect(signed.mime).toContain("Subject: Hello")
    expect(signed.mime).toContain("Message-ID: <my-id@example.com>")
    expect(signed.mime).toMatch(
      /^Content-Type: multipart\/signed; protocol="application\/pgp-signature"; micalg=pgp-[a-z0-9]+; boundary="[^"]+"\r\n$/m
    )
    // The signature attachment part (RFC 3156 §5).
    expect(signed.mime).toContain(
      'Content-Type: application/pgp-signature; name="signature.asc"'
    )
    expect(signed.mime).toContain(
      'Content-Disposition: attachment; filename="signature.asc"'
    )
    expect(signed.mime).toContain("-----BEGIN PGP SIGNATURE-----")
    // The original multipart/alternative body is preserved verbatim.
    expect(signed.mime).toContain(builtBody(built.mime))
    // MIME parts are CRLF-only (the armor is normalized).
    expect(signed.mime).not.toMatch(/(?<!\r)\n/)
  })

  it("signs the exact payload bytes (headers + body + delimiter CRLF)", async () => {
    const built = buildMimeMessage(baseInput())
    const signed = await signMime({ built, signingKey: senderPrivate })

    // The first part IS the original entity (Content-Type moved inside).
    const boundary = topBoundary(signed.mime)
    const payloadPart = firstPartBody(signed.mime, boundary)
    expect(payloadPart).toBe(builtEntity(built.mime))

    // RFC 3156 §5: the signature covers the payload part INCLUDING the
    // CRLF that precedes the next boundary delimiter.
    const armored = armorOf(signed.mime, "SIGNATURE")
    const verification = await openpgp.verify({
      message: await openpgp.createMessage({
        binary: new TextEncoder().encode(`${payloadPart}${CRLF}`),
      }),
      signature: await openpgp.readSignature({ armoredSignature: armored }),
      verificationKeys: senderPublic,
    })
    await expect(verification.signatures[0].verified).resolves.toBe(true)
  })

  it("declares the micalg the signature actually used", async () => {
    const built = buildMimeMessage(baseInput())
    const signed = await signMime({ built, signingKey: senderPrivate })

    const armored = armorOf(signed.mime, "SIGNATURE")
    const read = await openpgp.readSignature({ armoredSignature: armored })
    const packet = read.packets[0]
    expect(packet).toBeTruthy()
    const declared = signed.mime.match(/micalg=(pgp-[a-z0-9]+);/)?.[1]
    expect(declared).toBe(
      `pgp-${openpgp.enums.read(openpgp.enums.hash, packet!.hashAlgorithm!)}`
    )
  })
})

describe("encryptMime", () => {
  it("wraps the built message in RFC 3156 multipart/encrypted", async () => {
    const built = buildMimeMessage(baseInput())
    const encrypted = await encryptMime({
      built,
      encryptionArmors: [senderPublic.armor()],
    })

    expect(encrypted.messageId).toBe(built.messageId)
    expect(encrypted.mime).toContain("Subject: Hello")
    expect(encrypted.mime).toMatch(
      /^Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted"; boundary="[^"]+"\r\n$/m
    )
    // The version part precedes the armored payload part.
    expect(encrypted.mime).toContain("Content-Type: application/pgp-encrypted")
    expect(encrypted.mime).toContain("Version: 1")
    expect(encrypted.mime).toContain(
      'Content-Type: application/octet-stream; name="encrypted.asc"'
    )
    expect(encrypted.mime).toContain("-----BEGIN PGP MESSAGE-----")
    // The plaintext body must NOT survive outside the armor.
    expect(encrypted.mime).not.toContain("plain text")
    expect(encrypted.mime).not.toMatch(/(?<!\r)\n/)
  })

  it("decrypts back to the original entity with the recipient key", async () => {
    const built = buildMimeMessage(baseInput())
    const encrypted = await encryptMime({
      built,
      encryptionArmors: [recipientPrivate.toPublic().armor()],
    })

    await expect(
      decryptExact(armorOf(encrypted.mime, "MESSAGE"), recipientPrivate)
    ).resolves.toBe(builtEntity(built.mime))
  })

  it("is decryptable by every given key (encrypt-to-self)", async () => {
    const built = buildMimeMessage(baseInput())
    const encrypted = await encryptMime({
      built,
      encryptionArmors: [
        senderPublic.armor(),
        recipientPrivate.toPublic().armor(),
      ],
    })

    for (const key of [recipientPrivate, senderPrivate]) {
      await expect(
        decryptExact(armorOf(encrypted.mime, "MESSAGE"), key)
      ).resolves.toBe(builtEntity(built.mime))
    }
  })

  it("carries attachments inside the encrypted entity", async () => {
    const built = buildMimeMessage(
      baseInput({
        htmlBody: "<p>report attached</p>",
        attachments: [
          {
            filename: "notes.txt",
            mimeType: "text/plain",
            contentBase64: btoa("attached notes"),
          },
        ],
      })
    )
    const encrypted = await encryptMime({
      built,
      encryptionArmors: [recipientPrivate.toPublic().armor()],
    })

    const decrypted = await decryptExact(
      armorOf(encrypted.mime, "MESSAGE"),
      recipientPrivate
    )
    // The whole multipart/mixed — body AND attachment — is the payload.
    expect(decrypted).toBe(builtEntity(built.mime))
    expect(decrypted).toContain('filename="notes.txt"')
  })
})

describe("signAndEncryptMime", () => {
  it("encrypts the SIGNED entity: decrypt first, then verify inside", async () => {
    const built = buildMimeMessage(baseInput())
    const both = await signAndEncryptMime({
      built,
      signingKey: senderPrivate,
      encryptionArmors: [recipientPrivate.toPublic().armor()],
    })

    // Outer shape: encrypted; the plaintext is nowhere at the top level.
    expect(both.mime).toMatch(
      /^Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted"/m
    )
    expect(both.mime).not.toContain("plain text")
    expect(both.messageId).toBe(built.messageId)

    // Inner shape: the decrypted entity is the multipart/signed message.
    const signedMime = await decryptExact(
      armorOf(both.mime, "MESSAGE"),
      recipientPrivate
    )
    expect(signedMime).toMatch(
      /^Content-Type: multipart\/signed; protocol="application\/pgp-signature"; micalg=pgp-[a-z0-9]+; boundary="[^"]+"/
    )

    // And the inner signature verifies over its payload part.
    const boundary = topBoundary(signedMime)
    const payloadPart = firstPartBody(signedMime, boundary)
    const verification = await openpgp.verify({
      message: await openpgp.createMessage({
        binary: new TextEncoder().encode(`${payloadPart}${CRLF}`),
      }),
      signature: await openpgp.readSignature({
        armoredSignature: armorOf(signedMime, "SIGNATURE"),
      }),
      verificationKeys: senderPublic,
    })
    await expect(verification.signatures[0].verified).resolves.toBe(true)
  })
})

describe("buildMimeMessagePgp (builder hook, real crypto)", () => {
  it("builds + signs + encrypts a SendEmailInput end-to-end", async () => {
    const built = await buildMimeMessagePgp(baseInput(), {
      mode: "sign+encrypt",
      signingKey: senderPrivate,
      encryptionArmors: [recipientPrivate.toPublic().armor()],
    })

    const decrypted = await openpgp.decrypt({
      message: await openpgp.readMessage({
        armoredMessage: armorOf(built.mime, "MESSAGE"),
      }),
      decryptionKeys: [recipientPrivate],
      format: "utf8",
    })
    expect(decrypted.data).toContain("multipart/signed")

    const signedMime = decrypted.data.replace(/\n/g, CRLF)
    const boundary = topBoundary(signedMime)
    const verification = await openpgp.verify({
      message: await openpgp.createMessage({
        binary: new TextEncoder().encode(
          `${firstPartBody(signedMime, boundary)}${CRLF}`
        ),
      }),
      signature: await openpgp.readSignature({
        armoredSignature: armorOf(signedMime, "SIGNATURE"),
      }),
      verificationKeys: senderPublic,
    })
    await expect(verification.signatures[0].verified).resolves.toBe(true)
  })

  it("keeps the Message-ID stable across the transformation", async () => {
    const built = await buildMimeMessagePgp(baseInput(), {
      mode: "encrypt",
      encryptionArmors: [recipientPrivate.toPublic().armor()],
    })
    expect(built.messageId).toBe("<my-id@example.com>")
    expect(built.mime).toContain("Message-ID: <my-id@example.com>")
  })

  it("requires the signing key for sign modes and armors for encrypt", async () => {
    const input = baseInput()
    await expect(buildMimeMessagePgp(input, { mode: "sign" })).rejects.toThrow(
      /decrypted private key/
    )
    await expect(
      buildMimeMessagePgp(input, {
        mode: "sign+encrypt",
        encryptionArmors: [senderPublic.armor()],
      })
    ).rejects.toThrow(/decrypted private key/)
    await expect(
      buildMimeMessagePgp(input, { mode: "encrypt" })
    ).rejects.toThrow(/at least one recipient public key/)
    await expect(
      buildMimeMessagePgp(input, { mode: "encrypt", encryptionArmors: [] })
    ).rejects.toThrow(/at least one recipient public key/)
  })

  it("rejects an unreadable recipient armor with a PgpTransformError", async () => {
    await expect(
      buildMimeMessagePgp(baseInput(), {
        mode: "encrypt",
        encryptionArmors: ["not armor"],
      })
    ).rejects.toBeInstanceOf(PgpTransformError)
  })
})

// ---- Lazy-load discipline ------------------------------------------------------

describe("lazy loading", () => {
  it("module source has no static openpgp import (dynamic import only)", async () => {
    // Same structural guard as pgp-keys.test.ts (D11): the transform's
    // only openpgp dependency must be the dynamic import().
    const source = pgpTransformSource
    expect(source).not.toMatch(/^import\s(?!type\s)[^\n]*["']openpgp["']/m)
    expect(source).toContain('import("openpgp")')
    expect(source).toContain('import type * as OpenPGP from "openpgp"')
  })
})
