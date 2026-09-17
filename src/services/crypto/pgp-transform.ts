import type { BuiltMime } from "../email/mime-builder"
import type * as OpenPGP from "openpgp"

/**
 * PGP/MIME transforms (task 18.5, design D11): turn a message built by
 * buildMimeMessage into RFC 3156 PGP/MIME — a multipart/signed wrapper
 * (detached application/pgp-signature part) and/or a multipart/encrypted
 * wrapper (application/pgp-encrypted version part + octet-stream payload).
 * signAndEncryptMime composes the two the standard way: the SIGNED entity
 * is what gets encrypted, so recipients verify inside their decryption.
 *
 * The payload entity is the COMPLETE built message body plus its
 * top-level Content-Type header (moved from the top level into the part —
 * RFC 3156 §5), so attachments (multipart/mixed) ride inside the
 * signature/encryption exactly like the alternative body. Top-level
 * headers (From/To/Subject/Message-ID/…) stay in place: PGP/MIME keeps
 * them plaintext, and the unchanged Message-ID keeps the provisional Sent
 * row's reconciliation working.
 *
 * Dash-escaping note: RFC 3156 requires payload lines starting with "- "
 * to be escaped. The builder's boundaries all start with "emailer_" and
 * its bodies are base64, so a built message can never contain such a
 * line and the payload is emitted verbatim.
 *
 * Lazy loading (D11, same discipline as pgp-keys.ts): openpgp.js is NEVER
 * imported statically — every call site goes through loadOpenpgp()'s
 * dynamic import(), isolated by vite into its own chunk fetched only when
 * a PGP flow runs. The `OpenPGP` import is type-only (erased at build
 * time).
 */

const CRLF = "\r\n"

/**
 * The single openpgp entry point: a dynamic import so the openpgp chunk
 * only loads when a PGP flow actually runs (module doc). Awaiting this
 * repeatedly is free after the first call (module cache).
 */
function loadOpenpgp(): Promise<typeof import("openpgp")> {
  return import("openpgp")
}

/** PGP/MIME boundaries follow the builder's `emailer_` prefix + random
 * hex convention (never "- " at line start, so no dash-escaping). */
function randomBoundary(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  return `emailer_pgp_${hex}`
}

/** Thrown for PGP/MIME structural failures the caller surfaces as a send
 * error: malformed built input or an unreadable public-key armor.
 * Underlying errors ride as `cause`; messages never contain key material. */
export class PgpTransformError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "PgpTransformError"
  }
}

/** The PGP operation a send asked for. */
export type PgpMode = "sign" | "encrypt" | "sign+encrypt"

/** Inputs for the sign (or sign+encrypt) transforms: the built plaintext
 * message and the UNLOCKED account private key (getDecryptedPrivateKey). */
export interface SignMimeInput {
  built: BuiltMime
  signingKey: OpenPGP.PrivateKey
}

/** Inputs for the encrypt (or sign+encrypt) transforms: the built
 * plaintext message and every recipient's armored public key (plus the
 * sender's own for encrypt-to-self, resolved by the caller). */
export interface EncryptMimeInput {
  built: BuiltMime
  encryptionArmors: readonly string[]
}

// ---------------------------------------------------------------------------
// Built-message splitting + PGP/MIME assembly
// ---------------------------------------------------------------------------

/** A built message split at its header/body separator: the top-level
 * header lines, the Content-Type line among them, and the body (the
 * builder's trailing CRLF stripped — the transforms place the CRLF that
 * precedes each boundary delimiter themselves). */
interface SplitMessage {
  headers: string[]
  contentTypeLine: string | null
  body: string
}

function splitBuiltMessage(mime: string): SplitMessage {
  const separator = mime.indexOf(`${CRLF}${CRLF}`)
  if (separator === -1) {
    throw new PgpTransformError(
      "the built message has no header/body separator"
    )
  }
  // buildMimeMessage always appends one trailing CRLF after the body.
  const body = mime.slice(separator + CRLF.length * 2).replace(/\r\n$/, "")
  const headers = mime.slice(0, separator).split(CRLF)
  const contentTypeLine =
    headers.find((line) => /^content-type:/i.test(line)) ?? null
  return { headers, contentTypeLine, body }
}

/** The MIME entity a transform wraps: the built body plus its top-level
 * Content-Type header, which RFC 3156 moves from the message level into
 * the payload part. */
function payloadEntity(message: SplitMessage, built: BuiltMime): string {
  if (!message.contentTypeLine) {
    throw new PgpTransformError(
      `the built message (${built.messageId}) has no Content-Type header to wrap in PGP/MIME`
    )
  }
  return `${message.contentTypeLine}${CRLF}${CRLF}${message.body}`
}

/** Top-level headers with the Content-Type line replaced by the PGP/MIME
 * wrapper's (kept last, where the builder puts it). */
function wrapperHeaders(
  message: SplitMessage,
  wrapperContentType: string
): string[] {
  return [
    ...message.headers.filter((line) => !/^content-type:/i.test(line)),
    wrapperContentType,
  ]
}

/** One multipart part (headers + blank line + body, NO trailing newline);
 * the caller joins parts with exactly one CRLF, which is the CRLF that
 * "precedes the next boundary delimiter" — the RFC 3156 §5 byte the
 * signature covers and every parser strips from the part body. */
function multipartBody(boundary: string, parts: string[]): string {
  return (
    parts.map((part) => `--${boundary}${CRLF}${part}`).join(CRLF) +
    CRLF +
    `--${boundary}--`
  )
}

/** openpgp armor uses LF line endings; MIME parts are CRLF (RFC 3156 §6:
 * armored data inside a MIME part carries CRLF). Trimmed so the part body
 * ends exactly at the delimiter-preceding CRLF. */
function armorToCrlf(armor: string): string {
  return armor.trim().replace(/\r?\n/g, CRLF)
}

/** The RFC 3156 micalg token ("pgp-sha256" …) for the hash the produced
 * signature actually used — read from the signature packet rather than
 * assumed (openpgp's default depends on the key type; e.g. ed25519
 * signs with sha512). */
async function micalgOf(armoredSignature: string): Promise<string> {
  const openpgp = await loadOpenpgp()
  let signature: OpenPGP.Signature
  try {
    signature = await openpgp.readSignature({ armoredSignature })
  } catch (error) {
    throw new PgpTransformError("the produced signature is unreadable", {
      cause: error,
    })
  }
  const packet = signature.packets[0]
  const name =
    packet?.hashAlgorithm !== undefined && packet.hashAlgorithm !== null
      ? openpgp.enums.read(openpgp.enums.hash, packet.hashAlgorithm)
      : "sha256"
  // RFC 3156 §5 token names; ripemd is the one spelling the enum gets
  // wrong ("ripemd" vs the registry's "pgp-ripemd160").
  if (name === "ripemd") return "pgp-ripemd160"
  return `pgp-${name}`
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/**
 * Wrap the built message in RFC 3156 multipart/signed: the original
 * entity (Content-Type header + body) becomes part one, the detached
 * OpenPGP signature over `entity + CRLF` (the delimiter-preceding CRLF
 * the RFC includes in the signed data) becomes an
 * application/pgp-signature attachment part. Top-level headers are kept;
 * the Message-ID is untouched so Sent-row reconciliation still matches.
 */
export async function signMime(input: SignMimeInput): Promise<BuiltMime> {
  const openpgp = await loadOpenpgp()
  const message = splitBuiltMessage(input.built.mime)
  const entity = payloadEntity(message, input.built)

  let armored: string
  try {
    armored = await openpgp.sign({
      message: await openpgp.createMessage({
        binary: new TextEncoder().encode(`${entity}${CRLF}`),
      }),
      signingKeys: input.signingKey,
      format: "armored",
      detached: true,
    })
  } catch (error) {
    throw new PgpTransformError("the message could not be signed", {
      cause: error,
    })
  }

  const boundary = randomBoundary()
  const headers = wrapperHeaders(
    message,
    `Content-Type: multipart/signed; protocol="application/pgp-signature"; micalg=${await micalgOf(armored)}; boundary="${boundary}"`
  )
  const signaturePart = [
    'Content-Type: application/pgp-signature; name="signature.asc"',
    "Content-Description: OpenPGP digital signature",
    'Content-Disposition: attachment; filename="signature.asc"',
    "",
    armorToCrlf(armored),
  ].join(CRLF)
  const mime =
    headers.join(CRLF) +
    CRLF +
    CRLF +
    multipartBody(boundary, [entity, signaturePart]) +
    CRLF
  return { mime, messageId: input.built.messageId }
}

/**
 * Wrap the built message in RFC 3156 multipart/encrypted: a
 * application/pgp-encrypted "Version: 1" part, then the OpenPGP message
 * (armored, octet-stream) whose literal data is the original entity —
 * decrypting hands back exactly `Content-Type: … CRLF CRLF body` for the
 * render path (18.6) to parse. Encrypts to every given key; the caller
 * includes the sender's own public key for encrypt-to-self.
 */
export async function encryptMime(input: EncryptMimeInput): Promise<BuiltMime> {
  const openpgp = await loadOpenpgp()
  const message = splitBuiltMessage(input.built.mime)
  const entity = payloadEntity(message, input.built)

  let keys: OpenPGP.Key[]
  try {
    keys = await Promise.all(
      input.encryptionArmors.map((armor) =>
        openpgp.readKey({ armoredKey: armor })
      )
    )
  } catch (error) {
    throw new PgpTransformError("a recipient public key could not be read", {
      cause: error,
    })
  }

  let armored: string
  try {
    armored = await openpgp.encrypt({
      message: await openpgp.createMessage({
        binary: new TextEncoder().encode(entity),
      }),
      encryptionKeys: keys,
      format: "armored",
    })
  } catch (error) {
    throw new PgpTransformError("the message could not be encrypted", {
      cause: error,
    })
  }

  const boundary = randomBoundary()
  const headers = wrapperHeaders(
    message,
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`
  )
  const versionPart = [
    "Content-Type: application/pgp-encrypted",
    "Content-Description: OpenPGP encrypted data",
    "",
    "Version: 1",
  ].join(CRLF)
  const payloadPart = [
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    "Content-Description: OpenPGP encrypted data",
    'Content-Disposition: inline; filename="encrypted.asc"',
    "",
    armorToCrlf(armored),
  ].join(CRLF)
  const mime =
    headers.join(CRLF) +
    CRLF +
    CRLF +
    multipartBody(boundary, [versionPart, payloadPart]) +
    CRLF
  return { mime, messageId: input.built.messageId }
}

/**
 * Sign, then encrypt the SIGNED entity (the standard PGP/MIME nesting):
 * recipients decrypt first and verify the inner multipart/signed.
 */
export async function signAndEncryptMime(
  input: SignMimeInput & EncryptMimeInput
): Promise<BuiltMime> {
  const signed = await signMime({
    built: input.built,
    signingKey: input.signingKey,
  })
  return encryptMime({
    built: signed,
    encryptionArmors: input.encryptionArmors,
  })
}
