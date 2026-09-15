/**
 * Pure WebCrypto AES-256-GCM string helpers used to protect credentials at
 * rest. Wire format: `v1.<base64(iv)>.<base64(ciphertext+tag)>` — the `v1.`
 * prefix lets the envelope layout evolve without misreading old rows. Every
 * encryption draws a fresh 12-byte random IV, so encrypting the same
 * plaintext twice yields different ciphertexts. The 128-bit GCM
 * authentication tag (appended to the ciphertext by WebCrypto) makes any
 * tampering fail decryption instead of returning garbage.
 *
 * These helpers are environment-agnostic: they only use `globalThis.crypto`,
 * which exists in the Tauri webview and in Node >= 20 (vitest).
 */

const AES_GCM_ALGORITHM = "AES-GCM"
const IV_BYTE_LENGTH = 12
const ENVELOPE_VERSION = "v1"

/** Thrown when a ciphertext does not match the expected envelope shape. */
export class CipherFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CipherFormatError"
  }
}

/**
 * Web Crypto accepts BufferSource (ArrayBuffer | ArrayBufferView), but the
 * TypeScript DOM lib is strict about Uint8Array<ArrayBufferLike> vs
 * ArrayBufferView<ArrayBuffer>. This cast satisfies the type checker while
 * passing the Uint8Array to the API unchanged.
 */
export function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource
}

/** Standard padded base64, chunked so large payloads stay stack-safe. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

/** Inverse of bytesToBase64; throws on input that is not valid base64. */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** Encrypt a string into the `v1.<iv>.<ciphertext>` envelope. */
export async function encryptString(
  key: CryptoKey,
  plaintext: string
): Promise<string> {
  const iv = new Uint8Array(IV_BYTE_LENGTH)
  crypto.getRandomValues(iv)

  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_GCM_ALGORITHM, iv: asBufferSource(iv) },
    key,
    asBufferSource(encoded)
  )

  return [
    ENVELOPE_VERSION,
    bytesToBase64(iv),
    bytesToBase64(new Uint8Array(ciphertext)),
  ].join(".")
}

/**
 * Decrypt an envelope produced by encryptString. Malformed input throws
 * CipherFormatError; a wrong key or tampered ciphertext fails WebCrypto's
 * GCM authentication and rejects — this never returns partial output.
 */
export async function decryptString(
  key: CryptoKey,
  envelope: string
): Promise<string> {
  const parts = envelope.split(".")
  if (parts.length !== 3) {
    throw new CipherFormatError(
      'invalid envelope: expected "v1.<iv>.<ciphertext>"'
    )
  }

  const [version, ivBase64, ciphertextBase64] = parts
  if (version !== ENVELOPE_VERSION) {
    throw new CipherFormatError(
      `unsupported envelope version: ${JSON.stringify(version)}`
    )
  }

  let iv: Uint8Array
  let ciphertext: Uint8Array
  try {
    iv = base64ToBytes(ivBase64)
    ciphertext = base64ToBytes(ciphertextBase64)
  } catch {
    throw new CipherFormatError("invalid envelope: payload is not base64")
  }
  if (iv.length !== IV_BYTE_LENGTH) {
    throw new CipherFormatError("invalid envelope: iv must be 12 bytes")
  }

  const plaintext = await crypto.subtle.decrypt(
    { name: AES_GCM_ALGORITHM, iv: asBufferSource(iv) },
    key,
    asBufferSource(ciphertext)
  )
  return new TextDecoder().decode(plaintext)
}
