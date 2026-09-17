// @vitest-environment node
/**
 * Task 18.4 lifecycle tests (design D11): generate/import per identity,
 * passphrase protection (the passphrase is per-use, never stored), the
 * AES-256-GCM credentials envelope as the at-rest layer, and the full
 * sign/encrypt → decrypt/verify round-trip through a stored key.
 *
 * Node environment (not jsdom) on purpose: openpgp's Uint8Array prototype
 * checks span two realms under jsdom (Node's TextEncoder produces Node-
 * realm arrays while the jsdom window installs its own Uint8Array), which
 * breaks its module init — a test-env artifact only, since the Tauri
 * webview has a single realm. Nothing here needs the DOM.
 *
 * The test file itself imports openpgp statically — that is the TEST's
 * choice for fixtures/assertions; the service under test must only ever
 * load it dynamically (asserted by the source scan at the bottom).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import * as openpgp from "openpgp"

import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { getSetting } from "../../db/settings"
import { CredentialDecryptError, decryptCredentials } from "../credentials"
import { setDefaultKeyStore } from "../key-management"
import {
  PgpKeyError,
  deletePrivateKey,
  deletePublicKey,
  findEncryptionKeysByEmails,
  generateKey,
  getDefaultPrivateKey,
  getDecryptedPrivateKey,
  getPublicKeyArmor,
  importPrivateKey,
  importPublicKey,
  listPrivateKeys,
  listPublicKeys,
  privateKeysSettingKey,
  publicKeysSettingKey,
  setDefaultPrivateKey,
} from "../pgp-keys"
import { createInMemoryKeyStore } from "./in-memory-key-store"
// Vite's ?raw import (typed by vite/client): the service module's source
// text, for the lazy-load structural guard below.
import pgpKeysSource from "../pgp-keys.ts?raw"

const PASSPHRASE = "correct horse battery staple 🔐"
const WRONG_PASSPHRASE = "wrong-passphrase"
const IDENTITY = { name: "Ada Lovelace", email: "ada@example.com" }

let executor: TestExecutor
let accountId: string

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor, "gmail")
  setDefaultKeyStore(createInMemoryKeyStore())
})

afterEach(() => {
  setDefaultKeyStore(null)
  executor.close()
})

/** A key generated OUTSIDE the service (import fixture); `id` is its
 * fingerprint (openpgp v6's generateKey result does not carry one). */
async function makeExternalKey(passphrase?: string) {
  const generated = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [{ name: "Grace Hopper", email: "grace@example.com" }],
    ...(passphrase === undefined ? {} : { passphrase }),
    format: "armored",
  })
  const id = (
    await openpgp.readKey({ armoredKey: generated.publicKey })
  ).getFingerprint()
  return { ...generated, id }
}

/** The raw stored private-key row (what actually sits in SQLite). */
async function readRawPrivateRow(): Promise<Array<Record<string, unknown>>> {
  return getSetting<Array<Record<string, unknown>>>(
    executor,
    privateKeysSettingKey(accountId),
    []
  )
}

const FINGERPRINT = /^[0-9a-f]{40}$/

// ---- Generation + lifecycle round-trip ------------------------------------

describe("generateKey + key lifecycle", () => {
  it("generates a passphrase-protected key and lists metadata only", async () => {
    const summary = await generateKey(executor, accountId, {
      ...IDENTITY,
      passphrase: PASSPHRASE,
    })

    expect(summary.id).toMatch(FINGERPRINT)
    expect(summary.name).toBe(IDENTITY.name)
    expect(summary.email).toBe(IDENTITY.email)
    expect(summary.isDefault).toBe(true) // first key becomes the default
    expect(summary.createdAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))

    const listed = await listPrivateKeys(executor, accountId)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(summary)
    // Metadata must not leak armored or envelope material.
    expect(JSON.stringify(listed)).not.toContain("BEGIN PGP")
    expect(Object.keys(listed[0])).not.toContain("armor")
    expect(Object.keys(listed[0])).not.toContain("wrappedArmor")
  })

  it("round-trips sign+encrypt → decrypt+verify through the stored key", async () => {
    const summary = await generateKey(executor, accountId, {
      ...IDENTITY,
      passphrase: PASSPHRASE,
    })

    // Unlock with the per-use passphrase (the send/receive paths' entry
    // point), take the public half from the derived public-keys row.
    const decryptedKey = await getDecryptedPrivateKey(
      executor,
      accountId,
      summary.id,
      PASSPHRASE
    )
    expect(decryptedKey.isDecrypted()).toBe(true)

    const publicEntry = (await listPublicKeys(executor, accountId)).find(
      (entry) => entry.id === summary.id
    )
    expect(publicEntry?.source).toBe("from-private")
    const rawPublicRow = await getSetting<Array<{ id: string; armor: string }>>(
      executor,
      publicKeysSettingKey(accountId),
      []
    )
    const publicArmor = rawPublicRow.find((entry) => entry.id === summary.id)
      ?.armor as string
    const publicKey = await openpgp.readKey({ armoredKey: publicArmor })

    const payload = "pgp lifecycle payload 🔐"
    const encrypted = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: payload }),
      encryptionKeys: publicKey,
      signingKeys: decryptedKey,
      format: "armored",
    })
    const decrypted = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: encrypted }),
      decryptionKeys: decryptedKey,
      verificationKeys: publicKey,
      expectSigned: true,
    })
    expect(decrypted.data).toBe(payload)
    await expect(decrypted.signatures[0].verified).resolves.toBe(true)
  })

  it("rejects getDecryptedPrivateKey with the wrong passphrase and for unknown ids", async () => {
    const summary = await generateKey(executor, accountId, {
      ...IDENTITY,
      passphrase: PASSPHRASE,
    })

    const wrong = await getDecryptedPrivateKey(
      executor,
      accountId,
      summary.id,
      WRONG_PASSPHRASE
    ).catch((error: unknown) => error)
    expect(wrong).toBeInstanceOf(PgpKeyError)
    expect((wrong as Error).message).not.toContain(PASSPHRASE)

    const unknown = await getDecryptedPrivateKey(
      executor,
      accountId,
      "f".repeat(40),
      PASSPHRASE
    ).catch((error: unknown) => error)
    expect(unknown).toBeInstanceOf(PgpKeyError)
  })

  it("requires a non-empty passphrase and identity on generate", async () => {
    await expect(
      generateKey(executor, accountId, { ...IDENTITY, passphrase: "" })
    ).rejects.toThrow(PgpKeyError)
    await expect(
      generateKey(executor, accountId, {
        name: "  ",
        email: IDENTITY.email,
        passphrase: PASSPHRASE,
      })
    ).rejects.toThrow(PgpKeyError)
    await expect(listPrivateKeys(executor, accountId)).resolves.toEqual([])
  })
})

// ---- At-rest storage (the AES-256-GCM credentials envelope) ---------------

describe("at-rest storage", () => {
  it("stores wrappedArmor as an envelope that decrypts to the passphrase-protected armor", async () => {
    const summary = await generateKey(executor, accountId, {
      ...IDENTITY,
      passphrase: PASSPHRASE,
    })

    const row = await readRawPrivateRow()
    expect(row).toHaveLength(1)
    const stored = row[0]

    // The openpgp layer: the stored armor is a PRIVATE key block whose
    // secret material is locked under the passphrase — reading it gives a
    // key that is NOT decrypted, and no passphrase/wrong passphrase can
    // decrypt its secret packets.
    expect(stored.armor).toContain("BEGIN PGP PRIVATE KEY BLOCK")
    const locked = await openpgp.readPrivateKey({
      armoredKey: stored.armor as string,
    })
    expect(locked.isDecrypted()).toBe(false)
    expect(locked.getFingerprint()).toBe(summary.id)
    await expect(
      openpgp.decryptKey({ privateKey: locked, passphrase: WRONG_PASSPHRASE })
    ).rejects.toThrow()

    // The at-rest layer: wrappedArmor is a credentials envelope whose
    // plaintext is exactly the stored armor.
    expect(stored.wrappedArmor).toMatch(/^v1\./)
    await expect(
      decryptCredentials<string>(stored.wrappedArmor as string)
    ).resolves.toBe(stored.armor)
  })

  it("never persists the passphrase anywhere in the settings rows", async () => {
    await generateKey(executor, accountId, {
      ...IDENTITY,
      passphrase: PASSPHRASE,
    })
    const privateRaw = await executor.select<{ value: string }>(
      "SELECT value FROM settings WHERE key = $1",
      [privateKeysSettingKey(accountId)]
    )
    const publicRaw = await executor.select<{ value: string }>(
      "SELECT value FROM settings WHERE key = $1",
      [publicKeysSettingKey(accountId)]
    )
    for (const { value } of [...privateRaw, ...publicRaw]) {
      expect(value).not.toContain(PASSPHRASE)
    }
  })

  it("fails cleanly when the envelope was encrypted by a different install key", async () => {
    const summary = await generateKey(executor, accountId, {
      ...IDENTITY,
      passphrase: PASSPHRASE,
    })

    // Simulate a lost/rotated credentials key: swap the store AFTER the
    // key was wrapped (the credentials.test.ts pattern).
    const otherStore = createInMemoryKeyStore()
    setDefaultKeyStore(otherStore)

    const failure = await getDecryptedPrivateKey(
      executor,
      accountId,
      summary.id,
      PASSPHRASE
    ).catch((error: unknown) => error)
    // decryptCredentials throws CredentialDecryptError; the service wraps
    // what it can — either way the unlock must fail loudly, not garbage.
    expect(
      failure instanceof PgpKeyError ||
        failure instanceof CredentialDecryptError
    ).toBe(true)
  })
})

// ---- Private-key import -----------------------------------------------------

describe("importPrivateKey", () => {
  it("imports a passphrase-protected key and unlocks it later", async () => {
    const generated = await makeExternalKey(PASSPHRASE)
    const summary = await importPrivateKey(
      executor,
      accountId,
      generated.privateKey,
      PASSPHRASE
    )
    expect(summary.id).toMatch(FINGERPRINT)
    expect(summary.email).toBe("grace@example.com")
    expect(summary.isDefault).toBe(true)

    const unlocked = await getDecryptedPrivateKey(
      executor,
      accountId,
      summary.id,
      PASSPHRASE
    )
    expect(unlocked.getFingerprint()).toBe(summary.id)
  })

  it("rejects the wrong passphrase and stores nothing", async () => {
    const generated = await makeExternalKey(PASSPHRASE)
    await expect(
      importPrivateKey(
        executor,
        accountId,
        generated.privateKey,
        WRONG_PASSPHRASE
      )
    ).rejects.toThrow(PgpKeyError)
    await expect(listPrivateKeys(executor, accountId)).resolves.toEqual([])
    await expect(listPublicKeys(executor, accountId)).resolves.toEqual([])
  })

  it("re-protects an imported UNPROTECTED key with the given passphrase", async () => {
    const generated = await makeExternalKey(undefined) // no passphrase
    const summary = await importPrivateKey(
      executor,
      accountId,
      generated.privateKey,
      PASSPHRASE
    )

    const row = await readRawPrivateRow()
    const locked = await openpgp.readPrivateKey({
      armoredKey: row[0]?.armor as string,
    })
    expect(locked.isDecrypted()).toBe(false) // stored armor is protected
    expect(locked.getFingerprint()).toBe(summary.id) // same key, re-armed

    const unlocked = await getDecryptedPrivateKey(
      executor,
      accountId,
      summary.id,
      PASSPHRASE
    )
    expect(unlocked.isDecrypted()).toBe(true)
  })

  it("rejects public armor, duplicate imports, and invalid armor", async () => {
    const generated = await makeExternalKey(PASSPHRASE)

    await expect(
      importPrivateKey(executor, accountId, generated.publicKey, PASSPHRASE)
    ).rejects.toThrow(PgpKeyError)

    await importPrivateKey(
      executor,
      accountId,
      generated.privateKey,
      PASSPHRASE
    )
    await expect(
      importPrivateKey(executor, accountId, generated.privateKey, PASSPHRASE)
    ).rejects.toThrow(/already stored/)

    await expect(
      importPrivateKey(executor, accountId, "not armor", PASSPHRASE)
    ).rejects.toThrow(PgpKeyError)
  })
})

// ---- Public-key import ------------------------------------------------------

describe("importPublicKey", () => {
  it("imports a correspondent's public key with metadata", async () => {
    const generated = await makeExternalKey(PASSPHRASE)
    const summary = await importPublicKey(
      executor,
      accountId,
      generated.publicKey
    )
    expect(summary.id).toMatch(FINGERPRINT)
    expect(summary.source).toBe("imported")
    expect(summary.email).toBe("grace@example.com")
    expect(summary.name).toBe("Grace Hopper")

    // Metadata only — no armored material in summaries.
    const listed = await listPublicKeys(executor, accountId)
    expect(Object.keys(listed[0])).not.toContain("armor")
  })

  it("dedupes by fingerprint: re-import is idempotent, first source wins", async () => {
    const generated = await makeExternalKey(PASSPHRASE)
    const first = await importPublicKey(
      executor,
      accountId,
      generated.publicKey
    )
    const second = await importPublicKey(
      executor,
      accountId,
      generated.publicKey
    )
    expect(second.id).toBe(first.id)
    await expect(listPublicKeys(executor, accountId)).resolves.toHaveLength(1)

    // The public half of an imported private key dedupes against an
    // existing entry rather than duplicating it.
    await importPrivateKey(
      executor,
      accountId,
      generated.privateKey,
      PASSPHRASE
    )
    await expect(listPublicKeys(executor, accountId)).resolves.toHaveLength(1)

    // And the reverse order: from-private first, imported second.
    const other = await makeExternalKey(PASSPHRASE)
    await importPrivateKey(executor, accountId, other.privateKey, PASSPHRASE)
    await importPublicKey(executor, accountId, other.publicKey)
    const listed = await listPublicKeys(executor, accountId)
    expect(listed).toHaveLength(2)
    expect(listed.find((entry) => entry.id === other.id)?.source).toBe(
      "from-private"
    )
  })

  it("rejects private armor and invalid armor", async () => {
    const generated = await makeExternalKey(PASSPHRASE)
    await expect(
      importPublicKey(executor, accountId, generated.privateKey)
    ).rejects.toThrow(/private key/)
    await expect(
      importPublicKey(executor, accountId, "garbage")
    ).rejects.toThrow(PgpKeyError)
    await expect(listPublicKeys(executor, accountId)).resolves.toEqual([])
  })

  it("deletes a public key by id", async () => {
    const generated = await makeExternalKey(PASSPHRASE)
    const summary = await importPublicKey(
      executor,
      accountId,
      generated.publicKey
    )
    await deletePublicKey(executor, accountId, summary.id)
    await expect(listPublicKeys(executor, accountId)).resolves.toEqual([])
    // Deleting an unknown id is a no-op.
    await expect(
      deletePublicKey(executor, accountId, "f".repeat(40))
    ).resolves.toBeUndefined()
  })

  it("imports armor with CRLF line endings and surrounding whitespace", async () => {
    const generated = await makeExternalKey(PASSPHRASE)
    const crlf = `  \r\n${generated.publicKey.split("\n").join("\r\n")}\r\n  `
    const summary = await importPublicKey(executor, accountId, crlf)
    expect(summary.id).toBe(generated.id)
    await expect(listPublicKeys(executor, accountId)).resolves.toHaveLength(1)
  })
})

// ---- Composer lookup + public-key sharing ------------------------------------

describe("findEncryptionKeysByEmails (composer seam)", () => {
  it("marks an imported correspondent address as encryption-capable", async () => {
    const generated = await makeExternalKey(PASSPHRASE)
    await importPublicKey(executor, accountId, generated.publicKey)

    // Case-insensitive; an address without a key is simply absent.
    const matches = await findEncryptionKeysByEmails(executor, accountId, [
      "Grace@Example.com",
      "nobody@example.com",
    ])
    expect(matches.size).toBe(1)
    const matched = matches.get("grace@example.com")
    expect(matched).toMatchObject({
      keyId: generated.id,
      email: "grace@example.com",
      source: "imported",
    })
    // The returned armor is the correspondent's real public key — usable
    // to encrypt (the send path's need) without a second lookup.
    const publicKey = await openpgp.readKey({ armoredKey: matched!.armor })
    expect(publicKey.getFingerprint()).toBe(generated.id)
  })

  it("matches a key under a secondary user-id address", async () => {
    const generated = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519Legacy",
      userIDs: [
        { name: "Duo Identity", email: "duo@example.com" },
        { email: "alt@example.com" },
      ],
      format: "armored",
    })
    await importPublicKey(executor, accountId, generated.publicKey)
    const matches = await findEncryptionKeysByEmails(executor, accountId, [
      "alt@example.com",
    ])
    expect(matches.get("alt@example.com")?.keyId).toBe(
      (
        await openpgp.readKey({ armoredKey: generated.publicKey })
      ).getFingerprint()
    )
  })

  it("matches the account's own key for encrypt-to-self", async () => {
    const summary = await generateKey(executor, accountId, {
      ...IDENTITY,
      passphrase: PASSPHRASE,
    })
    const matches = await findEncryptionKeysByEmails(executor, accountId, [
      IDENTITY.email,
    ])
    expect(matches.get(IDENTITY.email.toLowerCase())).toMatchObject({
      keyId: summary.id,
      source: "from-private",
    })
  })

  it("returns no matches for an account with no keys", async () => {
    await expect(
      findEncryptionKeysByEmails(executor, accountId, [IDENTITY.email])
    ).resolves.toEqual(new Map())
  })
})

describe("getPublicKeyArmor (sharing seam)", () => {
  it("exposes the generated public key for sharing", async () => {
    const summary = await generateKey(executor, accountId, {
      ...IDENTITY,
      passphrase: PASSPHRASE,
    })
    const armor = await getPublicKeyArmor(executor, accountId, summary.id)
    expect(armor).toContain("BEGIN PGP PUBLIC KEY BLOCK")
    const publicKey = await openpgp.readKey({ armoredKey: armor as string })
    expect(publicKey.isPrivate()).toBe(false)
    expect(publicKey.getFingerprint()).toBe(summary.id)
    expect(await getPublicKeyArmor(executor, accountId, "f".repeat(40))).toBe(
      null
    )
  })

  it("exposes an imported correspondent key too", async () => {
    const generated = await makeExternalKey(PASSPHRASE)
    const summary = await importPublicKey(
      executor,
      accountId,
      generated.publicKey
    )
    await expect(
      getPublicKeyArmor(executor, accountId, summary.id)
    ).resolves.toBe(generated.publicKey.trim())
  })
})

// ---- Default selection + deletion -------------------------------------------

describe("default selection", () => {
  it("keeps exactly one default across generate, set, and delete", async () => {
    const first = await generateKey(executor, accountId, {
      ...IDENTITY,
      passphrase: PASSPHRASE,
    })
    const second = await generateKey(executor, accountId, {
      name: "Second Key",
      email: "second@example.com",
      passphrase: PASSPHRASE,
    })
    expect(first.isDefault).toBe(true)
    expect(second.isDefault).toBe(false)
    await expect(
      getDefaultPrivateKey(executor, accountId)
    ).resolves.toMatchObject({ id: first.id })

    await setDefaultPrivateKey(executor, accountId, second.id)
    await expect(
      getDefaultPrivateKey(executor, accountId)
    ).resolves.toMatchObject({ id: second.id })

    await expect(
      setDefaultPrivateKey(executor, accountId, "f".repeat(40))
    ).rejects.toThrow(/not found/)

    // Deleting the default promotes the first remaining key.
    await deletePrivateKey(executor, accountId, second.id)
    await expect(
      getDefaultPrivateKey(executor, accountId)
    ).resolves.toMatchObject({ id: first.id })

    // Deleting the LAST key leaves no default.
    await deletePrivateKey(executor, accountId, first.id)
    await expect(getDefaultPrivateKey(executor, accountId)).resolves.toBeNull()
    await expect(listPrivateKeys(executor, accountId)).resolves.toEqual([])
  })

  it("deleting an unknown private key is a no-op", async () => {
    await generateKey(executor, accountId, {
      ...IDENTITY,
      passphrase: PASSPHRASE,
    })
    await deletePrivateKey(executor, accountId, "f".repeat(40))
    await expect(listPrivateKeys(executor, accountId)).resolves.toHaveLength(1)
  })
})

// ---- Account isolation --------------------------------------------------------

describe("per-account isolation", () => {
  it("keeps keys scoped to their account", async () => {
    const summary = await generateKey(executor, accountId, {
      ...IDENTITY,
      passphrase: PASSPHRASE,
    })
    const otherAccount = await createAccount(executor, "imap")
    await expect(listPrivateKeys(executor, otherAccount)).resolves.toEqual([])
    await expect(
      getDefaultPrivateKey(executor, otherAccount)
    ).resolves.toBeNull()
    await expect(
      getDecryptedPrivateKey(executor, otherAccount, summary.id, PASSPHRASE)
    ).rejects.toThrow(PgpKeyError)
  })
})

// ---- Lazy-load discipline ------------------------------------------------------

describe("lazy loading", () => {
  it("module source has no static openpgp import (dynamic import only)", async () => {
    // Cheap structural guard backing the D11 discipline: the service's
    // only openpgp dependency must be the dynamic import() (behavioral
    // chunk isolation is verified by task 18.7's settings-section test).
    const source = pgpKeysSource
    expect(source).not.toMatch(/^import\s(?!type\s)[^\n]*["']openpgp["']/m)
    expect(source).toContain('import("openpgp")')
    // The type-only import is erased at build time and fine.
    expect(source).toContain('import type * as OpenPGP from "openpgp"')
  })
})
