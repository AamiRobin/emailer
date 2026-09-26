/**
 * Per-install key management for credential encryption.
 *
 * A 256-bit key is generated once from WebCrypto randomness, persisted
 * base64-encoded through a `KeyStore` (production: the Tauri fs plugin, at
 * `<appDataDir>/credentials.key`), and cached in memory as a
 * non-extractable CryptoKey. `getOrCreateEncryptionKey` is single-flight:
 * concurrent callers share one get-or-create promise and repeat calls
 * return the cached key.
 *
 * Persistence sits behind the `KeyStore` interface so non-Tauri
 * environments (vitest) can inject an in-memory store via
 * `setDefaultKeyStore`. Key material is never logged and never embedded in
 * error messages.
 */

import { invoke } from "@tauri-apps/api/core"

import { asBufferSource, base64ToBytes, bytesToBase64 } from "./aes-gcm"

/** Storage contract for the raw key material (base64 string). */
export interface KeyStore {
  /** The stored base64 key material, or null when nothing is stored yet. */
  read(): Promise<string | null>
  /** Persists the base64 key material. */
  write(value: string): Promise<void>
}

/** The key file exists but its contents are unusable (not regenerating —
 * that would silently make every stored credential undecryptable). */
export class KeyMaterialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KeyMaterialError"
  }
}

/** The key store itself failed (I/O, permissions, …). */
export class KeyStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "KeyStoreError"
  }
}

const KEY_FILE_NAME = "credentials.key"
const KEY_FILE_TMP_NAME = "credentials.key.tmp"
const KEY_BYTE_LENGTH = 32 // 256 bits

let defaultKeyStore: KeyStore | null = null

/**
 * Replace the process-wide key store (primarily for tests). Passing null
 * restores the Tauri fs store as the default.
 */
export function setDefaultKeyStore(keyStore: KeyStore | null): void {
  defaultKeyStore = keyStore
}

/** The store used when none is passed explicitly. */
export function getDefaultKeyStore(): KeyStore {
  defaultKeyStore ??= createTauriKeyStore()
  return defaultKeyStore
}

// One single-flight get-or-create promise per store instance. Failed
// attempts evict themselves so a transient store error can be retried.
const keyCache = new WeakMap<KeyStore, Promise<CryptoKey>>()

/**
 * Get the cached per-install encryption key, or create and persist a new
 * one on first use. Safe to call concurrently: all callers of a given
 * store share the same promise.
 */
export function getOrCreateEncryptionKey(
  keyStore: KeyStore = getDefaultKeyStore()
): Promise<CryptoKey> {
  let cached = keyCache.get(keyStore)
  if (!cached) {
    cached = loadOrCreateKey(keyStore).catch((error: unknown) => {
      keyCache.delete(keyStore)
      throw error
    })
    keyCache.set(keyStore, cached)
  }
  return cached
}

async function loadOrCreateKey(keyStore: KeyStore): Promise<CryptoKey> {
  let stored: string | null
  try {
    stored = await keyStore.read()
  } catch (error) {
    throw new KeyStoreError("failed to read the credential encryption key", {
      cause: error,
    })
  }

  if (stored === null) {
    const raw = new Uint8Array(KEY_BYTE_LENGTH)
    crypto.getRandomValues(raw)
    try {
      await keyStore.write(bytesToBase64(raw))
    } catch (error) {
      throw new KeyStoreError(
        "failed to persist the credential encryption key",
        { cause: error }
      )
    }
    return importAesKey(raw)
  }

  return importAesKey(decodeStoredKey(stored))
}

function decodeStoredKey(stored: string): Uint8Array {
  let raw: Uint8Array
  try {
    raw = base64ToBytes(stored.trim())
  } catch {
    throw new KeyMaterialError(
      "stored credential key is not valid base64; " +
        "stored credentials can no longer be decrypted"
    )
  }
  if (raw.length !== KEY_BYTE_LENGTH) {
    throw new KeyMaterialError(
      "stored credential key has an unexpected length; " +
        "stored credentials can no longer be decrypted"
    )
  }
  return raw
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  // Non-extractable: once imported, the CryptoKey cannot be exported again.
  return crypto.subtle.importKey(
    "raw",
    asBufferSource(raw),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  )
}

/**
 * KeyStore backed by the Tauri fs plugin: base64 key material at
 * `<appDataDir>/credentials.key`. Plugin imports are dynamic so this module
 * loads cleanly in non-Tauri environments (vitest). Note: writing to
 * AppData requires the `fs:allow-appdata-write-recursive` capability in
 * addition to `fs:default`.
 */
export function createTauriKeyStore(): KeyStore {
  return {
    async read(): Promise<string | null> {
      const { exists, readTextFile, BaseDirectory } =
        await import("@tauri-apps/plugin-fs")
      const options = { baseDir: BaseDirectory.AppData }
      if (!(await exists(KEY_FILE_NAME, options))) {
        return null
      }
      const stored = await readTextFile(KEY_FILE_NAME, options)
      // L1 hardening also covers keys persisted before the permission
      // restriction existed — tighten on every load, best-effort.
      await restrictKeyFilePermissionsBestEffort()
      return stored
    },

    async write(value: string): Promise<void> {
      const { appDataDir } = await import("@tauri-apps/api/path")
      const { mkdir, writeTextFile, rename, remove, BaseDirectory } =
        await import("@tauri-apps/plugin-fs")

      // Resolve the app data dir and create it when missing. mkdir is not
      // idempotent on every platform, so an already-exists error is fine —
      // the write below is the authoritative step.
      const appData = await appDataDir()
      try {
        await mkdir(appData, { recursive: true })
      } catch {
        // app data directory already exists
      }
      const appDataOptions = { baseDir: BaseDirectory.AppData }
      await writeKeyFileAtomically(value, {
        writeTextFile: (path, contents) =>
          writeTextFile(path, contents, appDataOptions),
        rename: (from, to) =>
          rename(from, to, {
            oldPathBaseDir: BaseDirectory.AppData,
            newPathBaseDir: BaseDirectory.AppData,
          }),
        remove: (path) => remove(path, appDataOptions),
      })
      // Hardening (security review L1): tighten credentials.key to
      // owner-only on Unix. Best-effort by design — the key is already
      // correctly stored at this point, and a permission failure must not
      // fail credential storage; the Rust command takes no path argument
      // and always targets <appData>/credentials.key.
      await restrictKeyFilePermissionsBestEffort()
    },
  }
}

/**
 * Best-effort owner-only tightening of `<appData>/credentials.key` via the
 * `restrict_credentials_key_permissions` Rust command (Unix only; a no-op
 * elsewhere). Failures are swallowed deliberately: the key material is
 * already correctly stored or loaded at the call sites, and a permission
 * problem must never break credential storage or decryption. The command
 * takes no arguments — it always targets the fixed key-file path.
 */
async function restrictKeyFilePermissionsBestEffort(): Promise<void> {
  try {
    await invoke("restrict_credentials_key_permissions")
  } catch {
    // Non-Tauri environments (tests) or a failed chmod — see above.
  }
}

/** The file IO the atomic key write needs (the Tauri fs plugin surface,
 * narrowed and pre-bound to the app-data directory). */
export interface KeyFileIo {
  writeTextFile(path: string, contents: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
}

/**
 * Persist the key file crash-atomically: write the full contents to a
 * sibling tmp file first, then rename it over the real key file (an
 * atomic replace on every supported platform). A crash mid-write can
 * therefore only ever leave the PREVIOUS key intact plus a stray tmp
 * file — never a truncated credentials.key, which would make ALL stored
 * credentials permanently undecryptable (KeyMaterialError refuses to
 * regenerate by design). If the rename fails, the tmp file is removed
 * best-effort and the error propagates. Exported for unit tests — the
 * Tauri store path itself cannot run under vitest.
 */
export async function writeKeyFileAtomically(
  value: string,
  io: KeyFileIo
): Promise<void> {
  await io.writeTextFile(KEY_FILE_TMP_NAME, value)
  try {
    await io.rename(KEY_FILE_TMP_NAME, KEY_FILE_NAME)
  } catch (error) {
    try {
      await io.remove(KEY_FILE_TMP_NAME)
    } catch {
      // best-effort cleanup only — surface the rename failure instead
    }
    throw error
  }
}
