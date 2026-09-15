/**
 * Credentials-at-rest service — the integration point for account add/save
 * flows. `credentials_json` in the accounts table stores exactly one
 * envelope produced by encryptCredentials and NEVER plaintext; anyone
 * reading the SQLite file sees only opaque ciphertext.
 *
 * Threat model (honest version): this is encryption at rest against casual
 * access. It satisfies the accounts spec scenario that credentials are
 * "AES-256-GCM encrypted and not readable as plaintext in the app's data
 * files". The AES-256-GCM key lives in a separate file in the OS app data
 * directory rather than an OS keychain — a documented trade-off, so a
 * determined attacker with arbitrary file read access to the user's profile
 * could recover it. OS keychain integration is explicitly out of scope for
 * this change.
 */

import { decryptString, encryptString } from "./aes-gcm"
import { getOrCreateEncryptionKey } from "./key-management"

/** Thrown when a stored credentials envelope cannot be decrypted. Callers
 * should treat the account as needing re-authentication, never fall back
 * to the undecryptable value. */
export class CredentialDecryptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "CredentialDecryptError"
  }
}

/**
 * Serialize credentials to JSON and encrypt them into the single
 * `credentials_json` envelope. Accepts any JSON-serializable value: OAuth
 * token objects for gmail, `{ password }` (plus connection secrets) for
 * imap.
 */
export async function encryptCredentials(
  credentials: unknown
): Promise<string> {
  const key = await getOrCreateEncryptionKey()
  return encryptString(key, JSON.stringify(credentials))
}

/**
 * Decrypt a `credentials_json` envelope back into its original value.
 * Null/absent/blank envelopes decrypt to null (no credentials stored).
 * A corrupt, tampered, or wrong-key envelope throws CredentialDecryptError
 * — it never silently returns garbage — with the underlying failure
 * attached as `cause`. Error text never contains envelope or key material.
 */
export async function decryptCredentials<T>(
  envelope: string | null
): Promise<T | null> {
  if (envelope === null || envelope.trim() === "") {
    return null
  }
  try {
    const key = await getOrCreateEncryptionKey()
    const json = await decryptString(key, envelope.trim())
    return JSON.parse(json) as T
  } catch (error) {
    throw new CredentialDecryptError(
      "stored credentials could not be decrypted; " +
        "the envelope may be corrupt or the encryption key may have changed",
      { cause: error }
    )
  }
}
