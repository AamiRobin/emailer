import { create } from "zustand"

import {
  clearAttachmentBytes,
  deleteAttachmentBytes,
  getAttachmentBytes,
} from "@/components/composer/attachment-bytes"
import { bytesToBase64, htmlToText } from "@/services/email/mime-builder"
import type { OutgoingAttachment } from "@/services/email/types"

/**
 * Composer draft state (design D5/D8): pure in-memory state for the
 * compose view — recipients, subject and the TipTap HTML body — plus the
 * `mode` that says what kind of message is being written. Nothing
 * persists here; draft persistence to `local_drafts` is task 8.6 and the
 * send path is task 8.7.
 *
 * The store keeps RAW input only: recipients are stored as typed (no
 * validity flags, no normalization). Validity is a UI-layer concern —
 * `src/components/composer/address-validation.ts` validates on demand and
 * the recipient chips carry the visual invalid flags, so the store never
 * blocks typing. Parsing free-text input into `Recipient` chips is also
 * component-side; the store just receives the parsed arrays.
 *
 * Mounting contract (tasks 8.1/8.2): the mailbox shell owns whether the
 * composer is mounted — `ui-store.composerOpen` — while this store's
 * `open` flag drives the composer view's own visibility once mounted (it
 * renders null when closed, so the shell may keep it mounted
 * unconditionally). `openNew`/`close` are the shell-facing entry points;
 * the shell calls `setComposerOpen(true)` alongside `openNew`.
 *
 * Task seams (8.3-8.6):
 * - 8.3 (autocomplete) extends RecipientField with suggestions; the store
 *   shape is unchanged.
 * - 8.4 (reply/forward) calls `openWith(mode, accountId)` and then
 *   pre-fills recipients/subject/body through the setters; `ComposerMode`
 *   already carries inReplyTo/references/quotedHtml/source ids. The
 *   per-account signature (settings-owned) is injected above
 *   `quotedHtml` by 8.4 — there is deliberately no signature field here
 *   yet.
 * - 8.5 (attachments) adds `attachments` as metadata-only state: the raw
 *   bytes live in the session registry
 *   `src/components/composer/attachment-bytes.ts` keyed by attachment id,
 *   so this state stays serializable. Components read files and register
 *   their bytes at add time (drag-drop or picker, see
 *   attachment-input.ts); `removeAttachment` and the draft-dropping
 *   actions (`reset`/`openNew`/`openWith`) clear the registry to match.
 *   `getComposerPayload` base64-encodes registered bytes into the send
 *   shape. Size caps are enforced at add time in the component layer.
 * - 8.6 (drafts) serializes the draft fields for `local_drafts` via the
 *   composer component's useDraftAutosave mount; rehydrates with
 *   `openWith` + setters. `draftKey` below is the per-open instance key
 *   that autosave and the send/discard deletions address the row by.
 *   Attachment BYTES are not persisted — drafts carry metadata
 *   only, so attachments survive within the session (see drafts.ts).
 * - 8.7 (send) reads the payload via getComposerPayload and hands it to
 *   sendComposerDraft from the composer component.
 */

/** A composer recipient, exactly as meant by the user. `{name?, email}`
 * maps 1:1 onto `SendEmailInput`'s `EmailAddress` (email required here —
 * an empty address is simply invalid, flagged in the UI). */
export interface Recipient {
  name?: string
  email: string
}

/** One composer attachment, metadata only (task 8.5). The bytes live in
 * the attachment-bytes registry under `id`; `size` is the raw byte count
 * shown in the UI and enforced against the size caps. */
export interface ComposerAttachment {
  id: string
  /** File name as displayed and sent as the MIME filename. */
  name: string
  /** Raw size in bytes (pre-base64). */
  size: number
  /** MIME type when known; absent → application/octet-stream on send. */
  mimeType?: string
}

/**
 * What the composer is editing. "new" is a blank message; "reply"/"forward"
 * carry generous context so tasks 8.4 (quoted history, addressing) and 8.6
 * (draft resume) can extend without reshaping the store.
 */
export type ComposerMode =
  | { kind: "new" }
  | {
      kind: "reply"
      /** Reply-all expands to the sender plus all original To/Cc (8.4). */
      replyAll: boolean
      /** RFC 5322 Message-ID of the source message ("<id@host>"). */
      inReplyTo?: string
      /** Space-separated References chain, oldest first. */
      references?: string
      /** DB id of the source message (quoted-history load, draft resume). */
      sourceMessageId?: string
      /** DB thread of the source message so a reply lands back in-thread. */
      sourceThreadId?: string
      /** Pre-rendered quoted history HTML (8.4 injects it into the body). */
      quotedHtml?: string
    }
  | {
      kind: "forward"
      sourceMessageId?: string
      sourceThreadId?: string
      quotedHtml?: string
    }

/** Send-shaped serialization of the current draft (see getComposerPayload).
 * `to/cc/bcc/subject/htmlBody` match SendEmailInput; `from`/`inReplyTo`/
 * `references`/`messageId` are resolved by the send service (task 8.7).
 * `attachments` (task 8.5) carries the base64 content from the bytes
 * registry and is present only when the draft has attachments with bytes. */
export interface ComposerSendPayload {
  to: Recipient[]
  cc: Recipient[]
  bcc: Recipient[]
  subject: string
  htmlBody: string
  textBody: string
  attachments?: OutgoingAttachment[]
}

interface ComposerState {
  /** Composer visibility once mounted; the shell mounts it via
   * ui-store.composerOpen (see module docstring). */
  open: boolean
  mode: ComposerMode
  /** Account the message is composed from; send uses its identity (8.7). */
  activeAccountId: string | null
  /** Stable key of this open composer instance (task 8.6): a fresh
   * crypto.randomUUID() per openNew/openWith, kept by close() so the
   * autosaved local_drafts row stays addressable, cleared by reset().
   * The composer component hands it to useDraftAutosave and to the
   * send/discard draft deletions. */
  draftKey: string | null
  /** Raw recipient chips, stored as typed — no validity state (see module
   * docstring); validity is computed in the UI on demand. */
  to: Recipient[]
  cc: Recipient[]
  bcc: Recipient[]
  /** Whether the Cc/Bcc rows are revealed; they also auto-show when the
   * corresponding list is non-empty (component derives the visible state). */
  showCc: boolean
  showBcc: boolean
  subject: string
  /** TipTap HTML body, synced onUpdate by the composer editor. */
  html: string
  /** Attachment metadata; bytes live in the attachment-bytes registry
   * (task 8.5). Cap enforcement happens at add time in the component. */
  attachments: ComposerAttachment[]

  /** Open a blank message composed from the given account. */
  openNew: (accountId: string | null) => void
  /** Open with a reply/forward mode (8.4); pre-fills arrive via setters. */
  openWith: (mode: ComposerMode, accountId: string | null) => void
  /** Hide the composer. Fields are kept so a later reopen (or task 8.6's
   * draft resume) can restore the in-progress message. */
  close: () => void
  /** Drop the draft entirely and hide the composer (the Discard action). */
  reset: () => void
  setTo: (recipients: Recipient[]) => void
  setCc: (recipients: Recipient[]) => void
  setBcc: (recipients: Recipient[]) => void
  setSubject: (subject: string) => void
  setHtml: (html: string) => void
  toggleCc: () => void
  toggleBcc: () => void
  /** Append attachment metadata (task 8.5). The component registers each
   * attachment's bytes under its id BEFORE calling this. */
  addAttachments: (attachments: ComposerAttachment[]) => void
  /** Remove one attachment and its registered bytes. */
  removeAttachment: (id: string) => void
}

interface InitialDraft {
  open: boolean
  mode: ComposerMode
  activeAccountId: string | null
  draftKey: string | null
  to: Recipient[]
  cc: Recipient[]
  bcc: Recipient[]
  showCc: boolean
  showBcc: boolean
  subject: string
  html: string
  attachments: ComposerAttachment[]
}

const INITIAL: InitialDraft = {
  open: false,
  mode: { kind: "new" } as ComposerMode,
  activeAccountId: null,
  draftKey: null,
  to: [] as Recipient[],
  cc: [] as Recipient[],
  bcc: [] as Recipient[],
  showCc: false,
  showBcc: false,
  subject: "",
  html: "",
  attachments: [] as ComposerAttachment[],
}

/** The draft-dropping actions also clear the bytes registry so dropped
 * attachments cannot leak (close() deliberately keeps everything). */
function dropDraft(): InitialDraft {
  clearAttachmentBytes()
  return { ...INITIAL }
}

export const useComposerStore = create<ComposerState>((set) => ({
  ...INITIAL,

  openNew: (accountId) =>
    set({
      ...dropDraft(),
      open: true,
      activeAccountId: accountId,
      draftKey: crypto.randomUUID(),
    }),

  openWith: (mode, accountId) =>
    set({
      ...dropDraft(),
      open: true,
      mode,
      activeAccountId: accountId,
      draftKey: crypto.randomUUID(),
    }),

  close: () => set({ open: false }),

  reset: () => set(dropDraft()),

  setTo: (to) => set({ to }),
  setCc: (cc) => set({ cc }),
  setBcc: (bcc) => set({ bcc }),
  setSubject: (subject) => set({ subject }),
  setHtml: (html) => set({ html }),

  toggleCc: () => set((state) => ({ showCc: !state.showCc })),
  toggleBcc: () => set((state) => ({ showBcc: !state.showBcc })),

  addAttachments: (attachments) =>
    set((state) => ({ attachments: [...state.attachments, ...attachments] })),

  removeAttachment: (id) => {
    deleteAttachmentBytes(id)
    set((state) => ({
      attachments: state.attachments.filter(
        (attachment) => attachment.id !== id
      ),
    }))
  },
}))

/**
 * Serialize the current draft into the send shape on demand (task 8.2).
 * The plain-text part is generated from the HTML exactly as the MIME
 * builder will (design D8). Send-time gating — valid recipients, an
 * account identity, offline enqueue — is the send service's job (8.7).
 *
 * Task 8.5: attachments with registered bytes are included as
 * SendEmailInput.attachments (base64 via the registry). Metadata without
 * bytes — e.g. a resumed draft's (session-lost) attachment descriptors —
 * is skipped so a send can never carry an empty/broken attachment part.
 */
export function getComposerPayload(): ComposerSendPayload {
  const { to, cc, bcc, subject, html, attachments } =
    useComposerStore.getState()
  const payload: ComposerSendPayload = {
    to,
    cc,
    bcc,
    subject,
    htmlBody: html,
    textBody: htmlToText(html),
  }
  const outgoing: OutgoingAttachment[] = []
  for (const attachment of attachments) {
    const bytes = getAttachmentBytes(attachment.id)
    if (!bytes) continue
    outgoing.push({
      filename: attachment.name,
      ...(attachment.mimeType !== undefined
        ? { mimeType: attachment.mimeType }
        : {}),
      contentBase64: bytesToBase64(bytes),
    })
  }
  if (outgoing.length > 0) payload.attachments = outgoing
  return payload
}
