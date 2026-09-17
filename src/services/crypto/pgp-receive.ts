import type { SqlExecutor } from "@/services/db/executor"
import type * as OpenPGP from "openpgp"

import {
  getDecryptedPrivateKey,
  getPublicKeyArmor,
  listPrivateKeys,
  listPublicKeys,
  PgpKeyError,
} from "./pgp-keys"

/**
 * PGP receive (task 18.6, design D11): detection, decryption and signature
 * verification for INCOMING mail, consumed by the render path
 * (mail-display.tsx). Covers the three shapes the spec names:
 *
 * - PGP/MIME encrypted (RFC 3156 multipart/encrypted): ingestion (Rust
 *   mail-parser) stores no body for such messages — the armored payload
 *   part surfaces as an attachment row instead. The render path fetches
 *   that part through the EXISTING attachment-cache seam
 *   (getAttachmentContent, D15) and hands the armor to decryptArmored.
 * - PGP/MIME signed (multipart/signed): the detached signature surfaces as
 *   an attachment row (signature.asc) while the signed content renders
 *   normally. DETACHED verification needs the exact signed entity bytes
 *   (part headers included), which the stored parsed body does not keep —
 *   so this module verifies the two shapes whose exact bytes ARE available
 *   (inline clear-signed bodies and signatures inside decrypted PGP/MIME)
 *   and leaves standalone multipart/signed detection-only (see the
 *   mail-display banner for the honest "cannot verify" notice).
 * - Inline PGP: armored blocks inside an otherwise-normal body —
 *   findInlineArmoredBlocks locates them and spliceInlineBlocks swaps the
 *   decrypted/verified text back in (operate on the plain source string
 *   BEFORE the render pipeline, then sanitize as usual — never bypass it).
 *
 * Decryption is DISPLAY-TIME only: nothing here writes to the database and
 * the stored message (parsed body + attachment rows) is never altered.
 *
 * Trust indication: SignatureStatus classifies every examined signature as
 * valid / invalid / unknown-signer (signer key not among the account's
 * imported public keys) / none — by comparing each signature's key id with
 * the imported keys BEFORE trusting openpgp's rejection reason, so an
 * unimported signer can never look like tampering.
 *
 * Failure behavior (spec "Offline and failure behavior"): every decrypt
 * failure throws a typed PgpReceiveError (no private key / wrong
 * passphrase / no matching key / unreadable armor) and the CALLER keeps
 * rendering the original encrypted content with the error — the thread
 * always opens.
 *
 * Passphrase discipline (same as pgp-keys.ts): the passphrase is a per-use
 * argument, nothing is cached, and unlocked PrivateKey objects live only
 * inside the call that requested them.
 *
 * Lazy loading (D11, same discipline as pgp-keys.ts / pgp-transform.ts):
 * openpgp.js is NEVER imported statically — every call site goes through
 * loadOpenpgp()'s dynamic import(). The `OpenPGP` import is type-only.
 */

/**
 * The single openpgp entry point: a dynamic import so the openpgp chunk
 * only loads when a PGP flow actually runs (module doc). Awaiting this
 * repeatedly is free after the first call (module cache).
 */
function loadOpenpgp(): Promise<typeof import("openpgp")> {
  return import("openpgp")
}

/** Thrown for receive-path failures the caller shows next to the original
 * encrypted content: no usable key, an unreadable message, or a decrypt
 * the account's keys cannot open. Signature results are NOT errors (they
 * ride as SignatureStatus); underlying errors ride as `cause` and the
 * message never contains key material or the passphrase. */
export class PgpReceiveError extends Error {
  readonly kind: PgpReceiveErrorKind
  constructor(
    kind: PgpReceiveErrorKind,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "PgpReceiveError"
    this.kind = kind
  }
}

export type PgpReceiveErrorKind =
  "no-private-key" | "wrong-passphrase" | "no-matching-key" | "bad-armor"

// ---------------------------------------------------------------------------
// Detection (pure — no openpgp, runs on the data the render path has)
// ---------------------------------------------------------------------------

export type PgpContentKind =
  | "pgp-mime-encrypted"
  | "pgp-mime-signed"
  | "inline-encrypted"
  | "inline-signed"
  | "none"

/** Where the PGP content was found: which body string carries inline
 * blocks, or that the shapes ride on attachment rows (PGP/MIME). */
export type PgpContentSource = "text" | "html" | "attachments"

export interface PgpDetection {
  kind: PgpContentKind
  source: PgpContentSource
}

export const NO_PGP_DETECTION: PgpDetection = {
  kind: "none",
  source: "attachments",
}

/** The attachment fields detection needs (AttachmentRow projects to it). */
export interface PgpAttachmentHint {
  filename: string | null
  mimeType: string | null
}

export interface PgpDetectionInput {
  bodyText: string | null
  bodyHtml: string | null
  attachments: readonly PgpAttachmentHint[]
}

/** RFC 3156 §5: the encrypted payload part is an octet-stream named
 * "encrypted.asc" (or .pgp/.gpg across clients); the version part is
 * application/pgp-encrypted. Bare ".asc" names are excluded on purpose —
 * armored PUBLIC keys are commonly attached as *.asc too. */
export function isPgpEncryptedPayloadAttachment(
  attachment: PgpAttachmentHint
): boolean {
  const mime = (attachment.mimeType ?? "").toLowerCase()
  if (mime === "application/pgp-encrypted") return true
  if (isPgpSignatureAttachment(attachment)) return false
  if (mime && mime !== "application/octet-stream") return false
  const name = (attachment.filename ?? "").toLowerCase()
  return /(^|_)encrypted\.asc$|\.pgp$|\.gpg$/.test(name)
}

/** The RFC 3156 §5 detached signature part: application/pgp-signature,
 * conventionally named "signature.asc". */
export function isPgpSignatureAttachment(
  attachment: PgpAttachmentHint
): boolean {
  const mime = (attachment.mimeType ?? "").toLowerCase()
  if (mime === "application/pgp-signature") return true
  const name = (attachment.filename ?? "").toLowerCase()
  return mime === "" && /signature\.asc$/.test(name)
}

/**
 * What PGP content the message carries, checked in the order the render
 * path can act on it: inline armored blocks in the body first (decryptable
 * from the body alone), then the PGP/MIME attachment-row shapes.
 * `bodyText` wins over `bodyHtml` — clients put inline PGP in the text
 * part, and the text path is the one the body renders from.
 */
export function detectPgpContent(input: PgpDetectionInput): PgpDetection {
  for (const [source, body] of [
    ["text", input.bodyText],
    ["html", input.bodyHtml],
  ] as const) {
    if (!body) continue
    const blocks = findInlineArmoredBlocks(body)
    if (blocks.length === 0) continue
    const kind = blocks.some((block) => block.kind === "encrypted")
      ? "inline-encrypted"
      : "inline-signed"
    return { kind, source }
  }
  if (input.attachments.some(isPgpEncryptedPayloadAttachment)) {
    return { kind: "pgp-mime-encrypted", source: "attachments" }
  }
  if (input.attachments.some(isPgpSignatureAttachment)) {
    return { kind: "pgp-mime-signed", source: "attachments" }
  }
  return NO_PGP_DETECTION
}

// ---------------------------------------------------------------------------
// Inline armored blocks (pure string surgery — see spliceInlineBlocks)
// ---------------------------------------------------------------------------

export interface InlinePgpBlock {
  kind: "encrypted" | "signed"
  /** The complete armor, from BEGIN to END marker inclusive. */
  block: string
}

const ARMOR_BEGIN_ENCRYPTED = "-----BEGIN PGP MESSAGE-----"
const ARMOR_END_ENCRYPTED = "-----END PGP MESSAGE-----"
const ARMOR_BEGIN_SIGNED = "-----BEGIN PGP SIGNED MESSAGE-----"
const ARMOR_END_SIGNED = "-----END PGP SIGNATURE-----"

/**
 * Locate inline armored blocks left-to-right. A block with a missing END
 * marker is skipped (nothing decryptable there) rather than swallowed —
 * later, complete blocks still count. A bare "-----BEGIN PGP
 * SIGNATURE-----" is NOT a block: a detached signature carries no signed
 * data of its own (that shape is PGP/MIME-signed territory).
 */
export function findInlineArmoredBlocks(source: string): InlinePgpBlock[] {
  const blocks: InlinePgpBlock[] = []
  let index = 0
  for (;;) {
    const encryptedAt = source.indexOf(ARMOR_BEGIN_ENCRYPTED, index)
    const signedAt = source.indexOf(ARMOR_BEGIN_SIGNED, index)
    if (encryptedAt === -1 && signedAt === -1) break
    const encrypted =
      encryptedAt !== -1 && (signedAt === -1 || encryptedAt < signedAt)
    const begin = encrypted ? ARMOR_BEGIN_ENCRYPTED : ARMOR_BEGIN_SIGNED
    const end = encrypted ? ARMOR_END_ENCRYPTED : ARMOR_END_SIGNED
    const start = encrypted ? encryptedAt : signedAt
    const endAt = source.indexOf(end, start + begin.length)
    if (endAt === -1) {
      index = start + begin.length
      continue
    }
    blocks.push({
      kind: encrypted ? "encrypted" : "signed",
      block: source.slice(start, endAt + end.length),
    })
    index = endAt + end.length
  }
  return blocks
}

/**
 * Substitute processed inline blocks back into the source string: each
 * occurrence of a block with a replacement string is swapped; a `null`
 * replacement (failed block) keeps the ORIGINAL armored text — the failure
 * path shows the raw content. Runs on the pre-sanitize source string; the
 * result goes through the normal sanitized pipeline.
 */
export function spliceInlineBlocks(
  source: string,
  replacements: ReadonlyMap<string, string | null>
): string {
  let result = source
  for (const [block, replacement] of replacements) {
    if (replacement === null) continue
    result = result.split(block).join(replacement)
  }
  return result
}

/** The first complete PGP MESSAGE armor in `text`, or null — used to pick
 * the armored payload out of a fetched attachment's bytes. */
export function extractArmoredMessage(text: string): string | null {
  const start = text.indexOf(ARMOR_BEGIN_ENCRYPTED)
  if (start === -1) return null
  const end = text.indexOf(ARMOR_END_ENCRYPTED, start)
  if (end === -1) return null
  return text.slice(start, end + ARMOR_END_ENCRYPTED.length)
}

// ---------------------------------------------------------------------------
// Signature status
// ---------------------------------------------------------------------------

export type SignatureTrust = "valid" | "invalid" | "unknown-signer" | "none"

export interface SignatureStatus {
  trust: SignatureTrust
  /** Hex key ids of every signature examined (openpgp KeyID.toHex()). */
  keyIds: string[]
}

export const NO_SIGNATURE: SignatureStatus = { trust: "none", keyIds: [] }

const TRUST_RANK: Record<SignatureTrust, number> = {
  none: 0,
  "unknown-signer": 1,
  invalid: 2,
  valid: 3,
}

/** The worst-wins... best-wins aggregate of several signatures: valid beats
 * invalid beats unknown-signer beats none — one valid signature makes the
 * message authenticated even if another signature is unimported. */
export function combineSignatureStatuses(
  statuses: readonly SignatureStatus[]
): SignatureStatus {
  const keyIds = [...new Set(statuses.flatMap((status) => status.keyIds))]
  let best: SignatureStatus = NO_SIGNATURE
  for (const status of statuses) {
    if (TRUST_RANK[status.trust] > TRUST_RANK[best.trust]) best = status
  }
  return { trust: best.trust, keyIds }
}

/** Hex key ids of every key packet in the given keys — the "is the signer
 * imported?" set. */
function knownKeyIds(keys: readonly OpenPGP.Key[]): Set<string> {
  return new Set(
    keys.flatMap((key) =>
      key.getKeys().map((packet) => packet.getKeyID().toHex())
    )
  )
}

/** Minimal structural view of openpgp's Verification result. */
interface SignatureVerification {
  keyID?: { toHex(): string }
  verified: Promise<boolean>
}

/**
 * Classify each signature WITHOUT trusting rejection reasons: a rejected
 * `verified` means tampering only when the signing key id is among the
 * imported keys; otherwise the signer is simply unknown (spec trust state)
 * — an unimported signer must never read as "invalid".
 */
async function classifySignatures(
  verifications: readonly SignatureVerification[],
  importedKeyIds: ReadonlySet<string>
): Promise<SignatureStatus> {
  const keyIds: string[] = []
  let trust: SignatureTrust = "none"
  for (const verification of verifications) {
    const keyId = verification.keyID?.toHex() ?? ""
    if (keyId) keyIds.push(keyId)
    try {
      const verified = await verification.verified
      if (verified && TRUST_RANK.valid > TRUST_RANK[trust]) trust = "valid"
    } catch {
      const rejection = importedKeyIds.has(keyId) ? "invalid" : "unknown-signer"
      if (TRUST_RANK[rejection] > TRUST_RANK[trust]) trust = rejection
    }
  }
  return { trust, keyIds }
}

// ---------------------------------------------------------------------------
// Key loading (the pgp-keys.ts reuse — nothing cached beyond the call)
// ---------------------------------------------------------------------------

/**
 * Every public key imported for the account, as openpgp Key objects — the
 * signature-verification candidate set. Corrupt stored armor is skipped
 * (degrades to a smaller candidate set, never breaks the render).
 */
export async function loadVerificationKeys(
  executor: SqlExecutor,
  accountId: string
): Promise<OpenPGP.Key[]> {
  const openpgp = await loadOpenpgp()
  const summaries = await listPublicKeys(executor, accountId)
  const keys: OpenPGP.Key[] = []
  for (const summary of summaries) {
    const armor = await getPublicKeyArmor(executor, accountId, summary.id)
    if (!armor) continue
    try {
      keys.push(await openpgp.readKey({ armoredKey: armor }))
    } catch {
      // Unreadable stored key — skip it rather than fail the message.
    }
  }
  return keys
}

/**
 * Unlock the account's private keys for one decrypt attempt: every stored
 * key is tried with the given passphrase (accounts may hold several keys
 * with different passphrases; the ones that unlock are candidates).
 * No keys at all → "no-private-key"; none unlocks → "wrong-passphrase".
 * The unlocked objects live only in the caller's scope (pgp-keys doc).
 */
export async function loadDecryptionKeys(
  executor: SqlExecutor,
  accountId: string,
  passphrase: string
): Promise<OpenPGP.PrivateKey[]> {
  const summaries = await listPrivateKeys(executor, accountId)
  if (summaries.length === 0) {
    throw new PgpReceiveError(
      "no-private-key",
      "this account has no private PGP key; generate or import one in settings to decrypt this message"
    )
  }
  const unlocked: OpenPGP.PrivateKey[] = []
  for (const summary of summaries) {
    try {
      unlocked.push(
        await getDecryptedPrivateKey(
          executor,
          accountId,
          summary.id,
          passphrase
        )
      )
    } catch (error) {
      // A passphrase that unlocks a different key is expected here; only
      // total failure (below) is an error the user must see.
      if (!(error instanceof PgpKeyError)) throw error
    }
  }
  if (unlocked.length === 0) {
    throw new PgpReceiveError(
      "wrong-passphrase",
      "the passphrase does not unlock any of this account's private keys"
    )
  }
  return unlocked
}

// ---------------------------------------------------------------------------
// Decryption + verification
// ---------------------------------------------------------------------------

/** The display content a decrypt/verify produced (pre-sanitize input for
 * the render pipeline; the caller picks html first, then text). */
export interface DecryptedContent {
  html: string | null
  text: string | null
  signature: SignatureStatus
}

export interface PgpDecryptRequest {
  executor: SqlExecutor
  accountId: string
  /** Per-use passphrase; never stored or logged. */
  passphrase: string
  /** The armored PGP message (inline block or fetched payload part). */
  armored: string
}

export interface PgpVerifyRequest {
  executor: SqlExecutor
  accountId: string
  /** The complete clear-signed armor (BEGIN PGP SIGNED MESSAGE … END PGP
   * SIGNATURE) found in the message body. */
  clearSigned: string
}

/**
 * Verify a clear-signed inline block and return its signed text (the
 * content to splice in place of the armor) plus the trust status.
 */
export async function verifyClearSignedBlock(
  clearSigned: string,
  verificationKeys: readonly OpenPGP.Key[]
): Promise<{ content: string; signature: SignatureStatus }> {
  const openpgp = await loadOpenpgp()
  let message: OpenPGP.CleartextMessage
  try {
    message = await openpgp.readCleartextMessage({
      cleartextMessage: clearSigned,
    })
  } catch (error) {
    throw new PgpReceiveError(
      "bad-armor",
      "the signed block is not a readable OpenPGP clear-signed message",
      { cause: error }
    )
  }
  try {
    const result = await openpgp.verify({
      message,
      verificationKeys: [...verificationKeys],
    })
    const signature = await classifySignatures(
      result.signatures,
      knownKeyIds(verificationKeys)
    )
    return { content: result.data, signature }
  } catch {
    // Verification machinery failed — keep the content, report honestly.
    return {
      content: message.getText(),
      signature: await classifySignatures(
        message.getSigningKeyIDs().map((keyID) => ({
          keyID,
          verified: Promise.reject(new Error("verification failed")),
        })),
        knownKeyIds(verificationKeys)
      ),
    }
  }
}

/**
 * Verify a DETACHED signature over exact signed bytes (the multipart/signed
 * payload entity + the delimiter-preceding CRLF, exactly as RFC 3156 §5
 * defines the signed data — the same bytes pgp-transform signs on send).
 * `signedData` goes in as binary so no line-ending normalization can move
 * the bytes between sign time and verify time.
 */
export async function verifyDetachedSignature(
  signedData: string,
  signatureArmor: string,
  verificationKeys: readonly OpenPGP.Key[]
): Promise<SignatureStatus> {
  const openpgp = await loadOpenpgp()
  let signature: OpenPGP.Signature
  try {
    signature = await openpgp.readSignature({
      armoredSignature: signatureArmor,
    })
  } catch {
    // An unreadable signature is a broken message, not an unknown signer.
    return { trust: "invalid", keyIds: [] }
  }
  try {
    const result = await openpgp.verify({
      message: await openpgp.createMessage({
        binary: new TextEncoder().encode(signedData),
      }),
      signature,
      verificationKeys: [...verificationKeys],
    })
    return await classifySignatures(
      result.signatures,
      knownKeyIds(verificationKeys)
    )
  } catch {
    return { trust: "unknown-signer", keyIds: [] }
  }
}

/**
 * Decrypt one armored message and render-parse the plaintext entity:
 * the RFC 3156 payload is a complete MIME entity ("Content-Type: …" +
 * blank line + body), inline armored messages are usually bare text.
 * Signatures riding INSIDE the encrypted data (one-pass sign+encrypt, or
 * an inner multipart/signed) are verified against the imported keys and
 * reported through the returned status.
 */
export async function decryptArmored(
  armored: string,
  decryptionKeys: readonly OpenPGP.PrivateKey[],
  verificationKeys: readonly OpenPGP.Key[]
): Promise<DecryptedContent> {
  const openpgp = await loadOpenpgp()
  let message: OpenPGP.Message<Uint8Array>
  try {
    message = await openpgp.readMessage({ armoredMessage: armored })
  } catch (error) {
    throw new PgpReceiveError(
      "bad-armor",
      "the encrypted content is not a readable OpenPGP message",
      { cause: error }
    )
  }
  let decrypted: OpenPGP.DecryptMessageResult & { data: Uint8Array }
  try {
    decrypted = await openpgp.decrypt({
      message,
      decryptionKeys: [...decryptionKeys],
      verificationKeys: [...verificationKeys],
      format: "binary",
    })
  } catch (error) {
    throw new PgpReceiveError(
      "no-matching-key",
      "none of your unlocked private keys can decrypt this message",
      { cause: error }
    )
  }

  // Exact literal bytes → string: binary (not utf8) keeps the entity's
  // CRLFs intact, which the inner detached-signature verification needs.
  const entity = new TextDecoder().decode(decrypted.data)
  const importedKeyIds = knownKeyIds(verificationKeys)
  const embedded = await classifySignatures(
    decrypted.signatures,
    importedKeyIds
  )
  const parsed = await parseDecryptedEntity(
    entity,
    (signedData, signatureArmor) =>
      verifyDetachedSignature(signedData, signatureArmor, verificationKeys)
  )
  return {
    html: parsed.html,
    text: parsed.text,
    signature: combineSignatureStatuses([embedded, parsed.signature]),
  }
}

/** The pgp-keys-backed orchestrators the render path consumes as its
 * `pgpDeps` seam (tests inject fakes to keep jsdom realms openpgp-free). */

export async function decryptArmoredForAccount(
  request: PgpDecryptRequest
): Promise<DecryptedContent> {
  const [decryptionKeys, verificationKeys] = await Promise.all([
    loadDecryptionKeys(request.executor, request.accountId, request.passphrase),
    loadVerificationKeys(request.executor, request.accountId),
  ])
  return decryptArmored(request.armored, decryptionKeys, verificationKeys)
}

export async function verifyClearSignedForAccount(
  request: PgpVerifyRequest
): Promise<{ content: string; signature: SignatureStatus }> {
  const verificationKeys = await loadVerificationKeys(
    request.executor,
    request.accountId
  )
  return verifyClearSignedBlock(request.clearSigned, verificationKeys)
}

/** The two call seams mail-display.tsx binds by default; tests replace the
 * whole object. openpgp loads only when the real functions run (D11). */
export interface PgpReceiveUiDeps {
  decryptArmored: (request: PgpDecryptRequest) => Promise<DecryptedContent>
  verifyClearSigned: (
    request: PgpVerifyRequest
  ) => Promise<{ content: string; signature: SignatureStatus }>
}

export const defaultPgpReceiveUiDeps: PgpReceiveUiDeps = {
  decryptArmored: decryptArmoredForAccount,
  verifyClearSigned: verifyClearSignedForAccount,
}

// ---------------------------------------------------------------------------
// Decrypted-entity parsing (pure — openpgp stays out; detached-signature
// verification is injected so tests can spy on it)
// ---------------------------------------------------------------------------

const MAX_ENTITY_NESTING = 5

interface ParsedContentType {
  mime: string
  params: Record<string, string>
}

interface ParsedEntity {
  headers: Map<string, string>
  contentType: ParsedContentType
  /** The exact raw entity text (headers + blank line + body). */
  raw: string
  /** The body after the header block, verbatim (no transfer decoding). */
  body: string
}

/** Parse a Content-Type value: "text/plain; charset=utf-8" → mime + params
 * (quoted params unquoted). Missing/garbled values fall back to text/plain. */
function parseContentType(value: string | null): ParsedContentType {
  if (!value) return { mime: "text/plain", params: {} }
  const [mime, ...paramTexts] = value.split(";")
  const params: Record<string, string> = {}
  for (const paramText of paramTexts) {
    const eq = paramText.indexOf("=")
    if (eq === -1) continue
    const name = paramText.slice(0, eq).trim().toLowerCase()
    let param = paramText.slice(eq + 1).trim()
    if (
      (param.startsWith('"') && param.endsWith('"')) ||
      (param.startsWith("'") && param.endsWith("'"))
    ) {
      param = param.slice(1, -1)
    }
    if (name) params[name] = param
  }
  return { mime: mime.trim().toLowerCase() || "text/plain", params }
}

/** Split an entity into headers and body at the first blank line. A first
 * line without a colon means there is no header block at all (bare inline
 * PGP literal data) — the whole text is the body. */
function parseEntity(raw: string): ParsedEntity {
  const separator = raw.match(/\r?\n\r?\n/)
  const headerBlock =
    separator?.index !== undefined ? raw.slice(0, separator.index) : ""
  const body =
    separator?.index !== undefined
      ? raw.slice(separator.index + separator[0].length)
      : raw
  const firstLine = headerBlock.split(/\r?\n/, 1)[0] ?? ""
  const headers = new Map<string, string>()
  if (firstLine.includes(":")) {
    // Unfold continuations (lines starting with space/tab), lowercase names.
    for (const line of headerBlock.split(/\r?\n/)) {
      if (/^[ \t]/.test(line) && headers.size > 0) {
        const last = [...headers.keys()].pop()
        if (last) headers.set(last, `${headers.get(last)} ${line.trim()}`)
        continue
      }
      const colon = line.indexOf(":")
      if (colon === -1) continue
      headers.set(
        line.slice(0, colon).trim().toLowerCase(),
        line.slice(colon + 1).trim()
      )
    }
  } else {
    // No header block: the raw text is the body itself.
    return {
      headers,
      contentType: { mime: "text/plain", params: {} },
      raw,
      body: raw,
    }
  }
  return {
    headers,
    contentType: parseContentType(headers.get("content-type") ?? null),
    raw,
    body,
  }
}

/**
 * Split a multipart body at its boundary delimiters, preserving exact part
 * bytes: the CRLF before a delimiter belongs to the delimiter (RFC 2046),
 * so each part ends right before it — the byte layout the detached
 * signature of an inner multipart/signed covers (part + CRLF).
 */
function splitMultipartParts(body: string, boundary: string): string[] {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const delimiter = new RegExp(
    `(\\r\\n|\\n|^)--${escaped}(?:--)?[ \\t]*(?=\\r\\n|\\n|$)`,
    "g"
  )
  const marks: Array<{ contentEnd: number; nextContentStart: number }> = []
  let match: RegExpExecArray | null
  while ((match = delimiter.exec(body)) !== null) {
    // The match consumes the CRLF that precedes the delimiter, and that
    // CRLF belongs to the delimiter (RFC 2046) — the part ends BEFORE it.
    const contentEnd = match.index
    const after = match.index + match[0].length
    const terminator = body.startsWith("\r\n", after)
      ? 2
      : body[after] === "\n" || body[after] === "\r"
        ? 1
        : 0
    marks.push({ contentEnd, nextContentStart: after + terminator })
  }
  const parts: string[] = []
  for (let index = 1; index < marks.length; index++) {
    parts.push(
      body.slice(marks[index - 1].nextContentStart, marks[index].contentEnd)
    )
  }
  return parts
}

/** Decode a leaf part's body per its Content-Transfer-Encoding. Charset
 * handling is UTF-8-only (the app's bodies are UTF-8; other charsets
 * degrade mojibake-safe rather than throwing). */
function decodePartBody(entity: ParsedEntity): string {
  const encoding = (entity.headers.get("content-transfer-encoding") ?? "7bit")
    .trim()
    .toLowerCase()
  if (encoding === "base64") {
    const compact = entity.body.replace(/[^A-Za-z0-9+/=]/g, "")
    try {
      const binary = atob(compact)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index)
      }
      return new TextDecoder().decode(bytes)
    } catch {
      return entity.body
    }
  }
  if (encoding === "quoted-printable") {
    // Soft line breaks drop; =XX escapes reassemble into BYTES decoded as
    // UTF-8 (the base64 path's decoder) — decoding per char would mangle
    // multi-byte sequences like =C3=A9 into mojibake.
    const softened = entity.body.replace(/=\r?\n/g, "")
    const bytes: number[] = []
    for (let index = 0; index < softened.length; index++) {
      const char = softened[index]
      const hex = char === "=" ? softened.slice(index + 1, index + 3) : ""
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        index += 2
      } else {
        bytes.push(char.charCodeAt(0))
      }
    }
    return new TextDecoder().decode(new Uint8Array(bytes))
  }
  return entity.body
}

/**
 * Walk a decrypted entity to its display content: text/plain → text,
 * text/html → html; multipart/alternative prefers the html part;
 * multipart/mixed renders its FIRST part (decrypted attachments are not
 * re-extracted — the original attachment rows stay untouched); an inner
 * multipart/signed is verified over the exact signed bytes (injected
 * callback) and its part one parsed on.
 */
export async function parseDecryptedEntity(
  entityText: string,
  verifyDetached: (
    signedData: string,
    signatureArmor: string
  ) => Promise<SignatureStatus> = async () => NO_SIGNATURE
): Promise<DecryptedContent> {
  async function walk(raw: string, depth: number): Promise<DecryptedContent> {
    const entity = parseEntity(raw)
    const { mime, params } = entity.contentType
    if (mime.startsWith("multipart/") && depth < MAX_ENTITY_NESTING) {
      const boundary = params.boundary
      const parts = boundary ? splitMultipartParts(entity.body, boundary) : []
      if (parts.length === 0) {
        return { html: null, text: entity.body, signature: NO_SIGNATURE }
      }
      if (mime === "multipart/signed" && parts.length >= 2) {
        const signatureEntity = parseEntity(parts[1])
        const inner = await walk(parts[0], depth + 1)
        const signature = await verifyDetached(
          `${parts[0]}\r\n`,
          decodePartBody(signatureEntity)
        )
        return {
          ...inner,
          signature: combineSignatureStatuses([inner.signature, signature]),
        }
      }
      // alternative → prefer the html part; mixed → the first (body) part.
      let chosen = 0
      if (mime === "multipart/alternative") {
        const htmlAt = parts.findIndex((part) =>
          parseEntity(part).contentType.mime.includes("html")
        )
        if (htmlAt !== -1) chosen = htmlAt
      }
      return walk(parts[chosen], depth + 1)
    }
    const decoded = decodePartBody(entity)
    if (mime.includes("html")) {
      return { html: decoded, text: null, signature: NO_SIGNATURE }
    }
    return { html: null, text: decoded, signature: NO_SIGNATURE }
  }
  return walk(entityText, 0)
}

// ---- Lazy-load discipline -----------------------------------------------
// Asserted by the pgp-receive source-scan test: the ONLY openpgp reference
// in this module is the dynamic import() above plus the type-only import.
