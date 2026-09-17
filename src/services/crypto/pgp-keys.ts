import type { SqlExecutor } from "@/services/db/executor"
import { getSetting, setSetting } from "@/services/db/settings"
import type * as OpenPGP from "openpgp"

import { decryptCredentials, encryptCredentials } from "./credentials"

/**
 * PGP key management (task 18.4, design D11): generate/import per-account
 * identities, protect private keys with a passphrase, and store them at
 * rest wrapped with the EXISTING AES-256-GCM credentials envelope.
 *
 * Storage model — there is NO PGP table. Like the delivery schedules and
 * splits, keys persist as JSON rows in the settings table, PER ACCOUNT:
 *
 * - `mail.pgp.privateKeys:<accountId>` — array of StoredPrivateKeyEntry.
 *   `armor` is the OPENPGP passphrase-protected armored private key
 *   ("-----BEGIN PGP PRIVATE KEY BLOCK-----" whose secret-key packets are
 *   encrypted by openpgp under the user's passphrase); `wrappedArmor` is
 *   the AES-256-GCM credentials envelope of that same armor — the at-rest
 *   layer, so the SQLite file only ever shows opaque ciphertext for the
 *   key material (the same guarantee account credentials have).
 * - `mail.pgp.publicKeys:<accountId>` — array of StoredPublicKeyEntry
 *   (correspondents' keys plus the public halves derived from the user's
 *   own private keys), NOT wrapped: public keys are not secret.
 *
 * Passphrase discipline: the passphrase is provided PER USE as a function
 * argument and is NEVER persisted — not in the settings rows, not in the
 * envelope, not in error messages. Every private-key operation that needs
 * secret material goes through getDecryptedPrivateKey(keyId, passphrase).
 *
 * Lazy loading (D11): openpgp.js is large and PGP is opt-in, so this
 * module NEVER imports openpgp statically — every openpgp call site goes
 * through loadOpenpgp()'s dynamic import(), which vite isolates into its
 * own chunk that is fetched only when a PGP flow runs. The `OpenPGP`
 * import is type-only (erased at build time). Task 18.7 verifies the
 * chunk is not pulled when the feature is off.
 */

/** Settings key holding one account's private-key array (JSON). */
export function privateKeysSettingKey(accountId: string): string {
  return `mail.pgp.privateKeys:${accountId}`
}

/** Settings key holding one account's public-key array (JSON). */
export function publicKeysSettingKey(accountId: string): string {
  return `mail.pgp.publicKeys:${accountId}`
}

/** Thrown for PGP key-management failures the caller can act on: a wrong
 * passphrase, an unusable armored key, a duplicate import, an unknown key
 * id, or a corrupt stored entry. Underlying errors ride as `cause`; the
 * message never contains key material or the passphrase. */
export class PgpKeyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "PgpKeyError"
  }
}

/**
 * One stored private key. `armor` holds the passphrase-PROTECTED armored
 * private key (openpgp layer), `wrappedArmor` the credentials envelope of
 * exactly that armor string (AES-256-GCM layer) — the redundancy is the
 * integrity check: unwrapping must reproduce `armor` or the row is corrupt.
 */
interface StoredPrivateKeyEntry {
  /** Lowercase hex SHA-1 fingerprint (openpgp getFingerprint()). */
  id: string
  /** Passphrase-protected armored private key (openpgp layer). */
  armor: string
  /** `encryptCredentials(armor)` — the at-rest envelope. */
  wrappedArmor: string
  /** Identity from the key's first self-certified user id. */
  name: string
  email: string
  /** unix seconds. */
  createdAt: number
  /** Marks the account's sign/default key (exactly one when any exist). */
  isDefault: boolean
}

/** One stored public key (correspondents' keys are secret-less, so no
 * wrapping — the settings row holds the armored key directly). */
interface StoredPublicKeyEntry {
  id: string
  armor: string
  /** Identity from the key's first self-certified user id, when present. */
  name?: string
  email?: string
  /** All email addresses across the key's user ids: a key can certify
   * several identities, and the composer lookup must recognize it under
   * any address it was imported for. Optional so older rows still read. */
  emails?: string[]
  /** imported = user-provided; from-private = derived from the account's
   * own generated/imported private key (kept so the send path can encrypt
   * to self without a round trip). */
  source: "imported" | "from-private"
  /** unix seconds. */
  createdAt: number
}

/** Metadata summary for UI lists — NO armored or wrapped material. */
export interface PgpPrivateKeySummary {
  id: string
  name: string
  email: string
  /** unix seconds. */
  createdAt: number
  isDefault: boolean
}

/** Metadata summary for UI lists — NO armored material. */
export interface PgpPublicKeySummary {
  id: string
  name?: string
  email?: string
  source: "imported" | "from-private"
  /** unix seconds. */
  createdAt: number
}

/** Input for generateKey; the passphrase is required (design: keys are
 * always passphrase-protected) and never stored. */
export interface GenerateKeyInput {
  name: string
  email: string
  passphrase: string
}

// ---------------------------------------------------------------------------
// Lazy openpgp access
// ---------------------------------------------------------------------------

/**
 * The single openpgp entry point: a dynamic import so the openpgp chunk
 * only loads when a PGP flow actually runs (module doc). Awaiting this
 * repeatedly is free after the first call (module cache).
 */
function loadOpenpgp(): Promise<typeof import("openpgp")> {
  return import("openpgp")
}

// ---------------------------------------------------------------------------
// Storage helpers (the settings-row CRUD of the delivery-schedules pattern)
// ---------------------------------------------------------------------------

function isStoredPrivateKeyEntry(
  value: unknown
): value is StoredPrivateKeyEntry {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === "string" &&
    typeof entry.armor === "string" &&
    typeof entry.wrappedArmor === "string" &&
    typeof entry.name === "string" &&
    typeof entry.email === "string" &&
    typeof entry.createdAt === "number" &&
    typeof entry.isDefault === "boolean"
  )
}

function isStoredPublicKeyEntry(value: unknown): value is StoredPublicKeyEntry {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  const optionalString = (v: unknown) =>
    v === undefined || typeof v === "string"
  const optionalStringArray = (v: unknown) =>
    v === undefined ||
    (Array.isArray(v) && v.every((item) => typeof item === "string"))
  return (
    typeof entry.id === "string" &&
    typeof entry.armor === "string" &&
    optionalString(entry.name) &&
    optionalString(entry.email) &&
    optionalStringArray(entry.emails) &&
    (entry.source === "imported" || entry.source === "from-private") &&
    typeof entry.createdAt === "number"
  )
}

async function readStoredPrivateKeys(
  executor: SqlExecutor,
  accountId: string
): Promise<StoredPrivateKeyEntry[]> {
  const stored = await getSetting<unknown>(
    executor,
    privateKeysSettingKey(accountId),
    []
  )
  if (!Array.isArray(stored)) return []
  // Read-time drop (the delivery-schedules guard): one corrupt entry
  // degrades to "that key is gone", never a broken settings page.
  return stored.filter(isStoredPrivateKeyEntry)
}

async function readStoredPublicKeys(
  executor: SqlExecutor,
  accountId: string
): Promise<StoredPublicKeyEntry[]> {
  const stored = await getSetting<unknown>(
    executor,
    publicKeysSettingKey(accountId),
    []
  )
  if (!Array.isArray(stored)) return []
  return stored.filter(isStoredPublicKeyEntry)
}

async function writeStoredPrivateKeys(
  executor: SqlExecutor,
  accountId: string,
  entries: StoredPrivateKeyEntry[]
): Promise<void> {
  await setSetting(executor, privateKeysSettingKey(accountId), entries)
}

async function writeStoredPublicKeys(
  executor: SqlExecutor,
  accountId: string,
  entries: StoredPublicKeyEntry[]
): Promise<void> {
  await setSetting(executor, publicKeysSettingKey(accountId), entries)
}

function toPrivateSummary(entry: StoredPrivateKeyEntry): PgpPrivateKeySummary {
  return {
    id: entry.id,
    name: entry.name,
    email: entry.email,
    createdAt: entry.createdAt,
    isDefault: entry.isDefault,
  }
}

function toPublicSummary(entry: StoredPublicKeyEntry): PgpPublicKeySummary {
  const summary: PgpPublicKeySummary = {
    id: entry.id,
    source: entry.source,
    createdAt: entry.createdAt,
  }
  if (entry.name !== undefined) summary.name = entry.name
  if (entry.email !== undefined) summary.email = entry.email
  return summary
}

// ---------------------------------------------------------------------------
// openpgp helpers
// ---------------------------------------------------------------------------

/** Non-empty passphrase required — an empty one would leave the private
 * key's secret packets UNPROTECTED in storage. The value is used as given
 * (no trimming); only emptiness is rejected. */
function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new PgpKeyError("a passphrase is required to protect the key")
  }
}

/** The key's display identity: name/email of the first self-certified
 * user id packet, falling back to parsing the first userID string. */
function extractIdentity(key: OpenPGP.Key): { name: string; email: string } {
  const userIDPacket = key.users.find((user) => user.userID)?.userID
  if (userIDPacket) {
    return { name: userIDPacket.name, email: userIDPacket.email }
  }
  const first = key.getUserIDs()[0]
  const match = first?.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/)
  if (match) return { name: match[1] ?? "", email: match[2] ?? "" }
  return { name: "", email: "" }
}

/** Every email address across the key's user ids (the first self-certified
 * one is also `extractIdentity().email`): a correspondent may address any
 * identity the key certifies, so the composer lookup must match them all. */
function extractEmails(key: OpenPGP.Key): string[] {
  const emails: string[] = []
  for (const user of key.users) {
    const email = user.userID?.email?.trim()
    if (email && email.includes("@") && !emails.includes(email)) {
      emails.push(email)
    }
  }
  return emails
}

/**
 * Read an armored PRIVATE key. `readPrivateKey` on public armor throws
 * (wrapped here with an actionable message); the result is still locked
 * when passphrase-protected — openpgp reads locked keys fine, and the
 * lockedness is what decryptKey tests.
 */
async function readProtectedPrivateKey(
  armoredKey: string
): Promise<OpenPGP.PrivateKey> {
  const openpgp = await loadOpenpgp()
  try {
    return await openpgp.readPrivateKey({ armoredKey })
  } catch (error) {
    throw new PgpKeyError(
      "the armored key is not a valid OpenPGP private key",
      { cause: error }
    )
  }
}

/** Normalize a stored/imported private key into a storage entry, WITHOUT
 * writing it: unlocks with `passphrase` to validate the passphrase (and
 * to re-protect an unprotected key, which the design forbids storing),
 * then wraps the protected armor through the credentials envelope. Also
 * returns the DERIVED PUBLIC armor for the public-keys row. */
async function buildPrivateKeyEntry(input: {
  armoredKey: string
  passphrase: string
  sourceArmor: string
  isDefault: boolean
}): Promise<{
  entry: StoredPrivateKeyEntry
  publicKeyArmor: string
  emails: string[]
}> {
  assertPassphrase(input.passphrase)
  const openpgp = await loadOpenpgp()
  const locked = await readProtectedPrivateKey(input.armoredKey)

  // Whether the SOURCE armor already carries passphrase protection —
  // read BEFORE decryptKey (which returns a separate decrypted clone and
  // leaves `locked` untouched, openpgp v6 semantics).
  const wasProtected = !locked.isDecrypted()

  // Validate the passphrase by unlocking. A wrong passphrase throws here,
  // so nothing invalid ever reaches storage.
  let unlocked: OpenPGP.PrivateKey
  if (wasProtected) {
    // Validate the passphrase by unlocking. A wrong passphrase throws
    // here, so nothing invalid ever reaches storage.
    try {
      unlocked = await openpgp.decryptKey({
        privateKey: locked,
        passphrase: input.passphrase,
      })
    } catch (error) {
      throw new PgpKeyError("the passphrase does not unlock this private key", {
        cause: error,
      })
    }
  } else {
    // Unprotected import: there is nothing to unlock (decryptKey would
    // reject with "already decrypted") — the given passphrase becomes the
    // key's protection in the re-arm below.
    unlocked = locked
  }

  // Storage invariant: the persisted armor is ALWAYS passphrase-protected.
  // An imported key without one is re-protected with the passphrase the
  // user just provided (the secret packets are re-armed in place — the
  // fingerprint and public half are unchanged).
  let protectedArmor = input.sourceArmor
  if (!wasProtected) {
    // getKeys() may carry public packets in its union type; only secret
    // packets accept a passphrase (re-checked at runtime via `in`).
    for (const { keyPacket } of unlocked.getKeys()) {
      if (!("encrypt" in keyPacket)) continue
      await keyPacket.encrypt(input.passphrase)
    }
    protectedArmor = unlocked.armor()
  }

  const wrappedArmor = await encryptCredentials(protectedArmor)
  const identity = extractIdentity(locked)
  return {
    entry: {
      id: locked.getFingerprint(),
      armor: protectedArmor,
      wrappedArmor,
      name: identity.name,
      email: identity.email,
      createdAt: Math.floor(Date.now() / 1000),
      isDefault: input.isDefault,
    },
    publicKeyArmor: locked.toPublic().armor(),
    emails: extractEmails(locked),
  }
}

/** Upsert the public half of the account's own private key into the
 * public-keys row with source "from-private", so the send path (18.5) can
 * encrypt to self and the test/lifecycle tooling can read the account's
 * public key without re-deriving it. First source wins: an "imported"
 * entry with the same fingerprint is never overwritten. */
async function upsertFromPrivatePublicKey(
  executor: SqlExecutor,
  accountId: string,
  publicKeyArmor: string,
  id: string,
  identity: { name: string; email: string; emails: string[] }
): Promise<void> {
  const existing = await readStoredPublicKeys(executor, accountId)
  if (existing.some((entry) => entry.id === id)) return
  const entry: StoredPublicKeyEntry = {
    id,
    armor: publicKeyArmor.trim(),
    createdAt: Math.floor(Date.now() / 1000),
    source: "from-private",
  }
  if (identity.name) entry.name = identity.name
  if (identity.email) entry.email = identity.email
  if (identity.emails.length > 0) entry.emails = identity.emails
  await writeStoredPublicKeys(executor, accountId, [...existing, entry])
}

// ---------------------------------------------------------------------------
// Public API — every function takes the passphrase per use, stores nothing
// that can unlock a key, and is async so the openpgp chunk stays dynamic.
// ---------------------------------------------------------------------------

/**
 * Generate an ECC (curve25519) key pair for the account, passphrase-
 * protected by openpgp, and store it wrapped. The public half is stored
 * alongside as a "from-private" public entry. Returns the key's public
 * summary for the UI. The first stored private key becomes the account's
 * default automatically. The passphrase and unprotected key material are
 * never persisted.
 */
export async function generateKey(
  executor: SqlExecutor,
  accountId: string,
  input: GenerateKeyInput
): Promise<PgpPrivateKeySummary> {
  assertPassphrase(input.passphrase)
  const name = input.name.trim()
  const email = input.email.trim()
  if (name.length === 0 || email.length === 0) {
    throw new PgpKeyError("a name and email are required to generate a key")
  }

  const openpgp = await loadOpenpgp()
  const generated = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [{ name, email }],
    passphrase: input.passphrase,
    format: "armored",
  })

  const { entry, publicKeyArmor, emails } = await buildPrivateKeyEntry({
    armoredKey: generated.privateKey,
    passphrase: input.passphrase,
    sourceArmor: generated.privateKey,
    isDefault: false,
  })

  const existing = await readStoredPrivateKeys(executor, accountId)
  if (existing.some((key) => key.id === entry.id)) {
    throw new PgpKeyError("this key is already stored for the account")
  }

  // Exactly one default: flag this key only when the account has none.
  const isDefault = !existing.some((key) => key.isDefault)
  await writeStoredPrivateKeys(executor, accountId, [
    ...existing,
    { ...entry, isDefault },
  ])
  await upsertFromPrivatePublicKey(
    executor,
    accountId,
    publicKeyArmor,
    entry.id,
    { name: entry.name, email: entry.email, emails }
  )
  return toPrivateSummary({ ...entry, isDefault })
}

/**
 * Import an armored private key, validating that `passphrase` actually
 * unlocks it before anything is stored (design: never store a key whose
 * passphrase the user does not know). An unprotected key is re-protected
 * with the given passphrase before storage.
 */
export async function importPrivateKey(
  executor: SqlExecutor,
  accountId: string,
  armoredKey: string,
  passphrase: string
): Promise<PgpPrivateKeySummary> {
  const armor = armoredKey.trim()
  const { entry, publicKeyArmor, emails } = await buildPrivateKeyEntry({
    armoredKey: armor,
    passphrase,
    sourceArmor: armor,
    isDefault: false,
  })

  const existing = await readStoredPrivateKeys(executor, accountId)
  if (existing.some((key) => key.id === entry.id)) {
    throw new PgpKeyError("this key is already stored for the account")
  }
  const isDefault = !existing.some((key) => key.isDefault)
  await writeStoredPrivateKeys(executor, accountId, [
    ...existing,
    { ...entry, isDefault },
  ])
  await upsertFromPrivatePublicKey(
    executor,
    accountId,
    publicKeyArmor,
    entry.id,
    { name: entry.name, email: entry.email, emails }
  )
  return toPrivateSummary({ ...entry, isDefault })
}

/**
 * Import a correspondent's armored PUBLIC key (dedupe by fingerprint:
 * re-importing or importing the public half of an already-known key
 * returns the existing summary unchanged). Private armor is rejected —
 * route it through importPrivateKey.
 */
export async function importPublicKey(
  executor: SqlExecutor,
  accountId: string,
  armoredKey: string
): Promise<PgpPublicKeySummary> {
  const openpgp = await loadOpenpgp()
  let key: OpenPGP.Key
  try {
    key = await openpgp.readKey({ armoredKey: armoredKey.trim() })
  } catch (error) {
    throw new PgpKeyError("the armored key is not a valid OpenPGP key", {
      cause: error,
    })
  }
  if (key.isPrivate()) {
    throw new PgpKeyError(
      "this is a private key; import it with importPrivateKey instead"
    )
  }

  const id = key.getFingerprint()
  const existing = await readStoredPublicKeys(executor, accountId)
  const already = existing.find((entry) => entry.id === id)
  if (already) return toPublicSummary(already)

  const identity = extractIdentity(key)
  const emails = extractEmails(key)
  const entry: StoredPublicKeyEntry = {
    id,
    armor: armoredKey.trim(),
    createdAt: Math.floor(Date.now() / 1000),
    source: "imported",
  }
  if (identity.name) entry.name = identity.name
  if (identity.email) entry.email = identity.email
  if (emails.length > 0) entry.emails = emails

  await writeStoredPublicKeys(executor, accountId, [...existing, entry])
  return toPublicSummary(entry)
}

/**
 * The account's private keys, metadata only — the summaries carry no
 * armor and no envelope material.
 */
export async function listPrivateKeys(
  executor: SqlExecutor,
  accountId: string
): Promise<PgpPrivateKeySummary[]> {
  const entries = await readStoredPrivateKeys(executor, accountId)
  return entries.map(toPrivateSummary)
}

/** The account's known public keys, metadata only. */
export async function listPublicKeys(
  executor: SqlExecutor,
  accountId: string
): Promise<PgpPublicKeySummary[]> {
  const entries = await readStoredPublicKeys(executor, accountId)
  return entries.map(toPublicSummary)
}

/**
 * The armored public key `keyId` for sharing/exporting — the share half of
 * the generate scenario ("the public key is available to share"). Unlike
 * the list summaries this returns key material, but only PUBLIC material,
 * which is safe to copy anywhere. Null when the id is unknown.
 */
export async function getPublicKeyArmor(
  executor: SqlExecutor,
  accountId: string,
  keyId: string
): Promise<string | null> {
  const entries = await readStoredPublicKeys(executor, accountId)
  return entries.find((entry) => entry.id === keyId)?.armor ?? null
}

/** A recipient's encryption-capable key as the composer/send paths (18.5)
 * consume it: the matched address plus the armored public key to encrypt
 * with. */
export interface RecipientEncryptionKey {
  keyId: string
  /** The matched recipient address (lowercased). */
  email: string
  /** The armored public key to encrypt with. */
  armor: string
  source: "imported" | "from-private"
}

/**
 * The composer lookup seam ("which recipients have keys"): for each given
 * address, the encryption-capable public key stored for it, keyed by the
 * LOWERCASED address — an absent entry means "no known key, cannot encrypt
 * to this recipient" (the import scenario's encryption-capable marking).
 * Matching is case-insensitive and covers every user id on a key, so a key
 * imported for a secondary address still marks that address capable. When
 * several stored keys cover one address, the first stored match wins.
 */
export async function findEncryptionKeysByEmails(
  executor: SqlExecutor,
  accountId: string,
  addresses: readonly string[]
): Promise<Map<string, RecipientEncryptionKey>> {
  const entries = await readStoredPublicKeys(executor, accountId)
  const lookupAddresses = (entry: StoredPublicKeyEntry): string[] => {
    const candidates = entry.email
      ? [entry.email, ...(entry.emails ?? [])]
      : (entry.emails ?? [])
    return candidates.map((email) => email.toLowerCase())
  }

  const matches = new Map<string, RecipientEncryptionKey>()
  for (const address of addresses) {
    const normalized = address.trim().toLowerCase()
    if (normalized.length === 0 || matches.has(normalized)) continue
    const entry = entries.find((candidate) =>
      lookupAddresses(candidate).includes(normalized)
    )
    if (entry) {
      matches.set(normalized, {
        keyId: entry.id,
        email: normalized,
        armor: entry.armor,
        source: entry.source,
      })
    }
  }
  return matches
}

/**
 * The account's default (sign) key, or null when none is set. Writes keep
 * the one-default invariant, so a missing flag simply means no keys yet.
 */
export async function getDefaultPrivateKey(
  executor: SqlExecutor,
  accountId: string
): Promise<PgpPrivateKeySummary | null> {
  const entries = await readStoredPrivateKeys(executor, accountId)
  const found = entries.find((entry) => entry.isDefault)
  return found ? toPrivateSummary(found) : null
}

/**
 * Make `keyId` the account's default. Unknown ids throw — the UI can only
 * offer listed keys, so that is a stale-UI/programming error.
 */
export async function setDefaultPrivateKey(
  executor: SqlExecutor,
  accountId: string,
  keyId: string
): Promise<void> {
  const entries = await readStoredPrivateKeys(executor, accountId)
  if (!entries.some((entry) => entry.id === keyId)) {
    throw new PgpKeyError(`key ${keyId} not found`)
  }
  await writeStoredPrivateKeys(
    executor,
    accountId,
    entries.map((entry) => ({ ...entry, isDefault: entry.id === keyId }))
  )
}

/**
 * Delete a private key by id (no-op when unknown). Deleting the default
 * key promotes the first remaining key so the one-default invariant
 * survives whenever any keys remain. The passphrase is NOT needed — the
 * key material is dropped, not unlocked.
 */
export async function deletePrivateKey(
  executor: SqlExecutor,
  accountId: string,
  keyId: string
): Promise<void> {
  const entries = await readStoredPrivateKeys(executor, accountId)
  const remaining = entries.filter((entry) => entry.id !== keyId)
  if (remaining.length === entries.length) return
  if (entries.find((entry) => entry.id === keyId)?.isDefault) {
    for (const [index, entry] of remaining.entries()) {
      entry.isDefault = index === 0
    }
  }
  await writeStoredPrivateKeys(executor, accountId, remaining)
}

/** Delete a known public key by id (no-op when unknown). */
export async function deletePublicKey(
  executor: SqlExecutor,
  accountId: string,
  keyId: string
): Promise<void> {
  const entries = await readStoredPublicKeys(executor, accountId)
  await writeStoredPublicKeys(
    executor,
    accountId,
    entries.filter((entry) => entry.id !== keyId)
  )
}

/**
 * Unlock the account's private key `keyId` for use by the send path
 * (18.5) and the decrypt-on-render path (18.6): unwrap the envelope,
 * verify it matches the stored armor, and decrypt with the user's
 * passphrase. The result lives only in the caller's scope — never store,
 * cache, or log it. A wrong passphrase throws PgpKeyError.
 */
export async function getDecryptedPrivateKey(
  executor: SqlExecutor,
  accountId: string,
  keyId: string,
  passphrase: string
): Promise<OpenPGP.PrivateKey> {
  assertPassphrase(passphrase)
  const entries = await readStoredPrivateKeys(executor, accountId)
  const entry = entries.find((candidate) => candidate.id === keyId)
  if (!entry) {
    throw new PgpKeyError(`key ${keyId} not found`)
  }

  const armor = await decryptCredentials<string>(entry.wrappedArmor)
  if (armor === null || armor !== entry.armor) {
    throw new PgpKeyError(
      "the stored key envelope does not match its key; " +
        "the entry is corrupt or was tampered with"
    )
  }

  const openpgp = await loadOpenpgp()
  let locked: OpenPGP.PrivateKey
  try {
    locked = await openpgp.readPrivateKey({ armoredKey: armor })
  } catch (error) {
    throw new PgpKeyError("the stored key armor is not a valid private key", {
      cause: error,
    })
  }
  try {
    return await openpgp.decryptKey({
      privateKey: locked,
      passphrase,
    })
  } catch (error) {
    throw new PgpKeyError("the passphrase does not unlock this key", {
      cause: error,
    })
  }
}
