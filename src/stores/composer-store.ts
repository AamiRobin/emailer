import { create } from "zustand"
import { toast } from "sonner"

import {
  clearAttachmentBytes,
  deleteAttachmentBytes,
  getAttachmentBytes,
} from "@/components/composer/attachment-bytes"
import { bytesToBase64, htmlToText } from "@/services/email/mime-builder"
import type { OutgoingAttachment } from "@/services/email/types"
import type { SendComposerDraftArgs } from "@/services/composer/send"
import {
  clampSendDelaySeconds,
  sendWithUndoDelay,
  type UndoSendController,
} from "@/services/composer/undo-send"

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
 * - 16.2 (send-as, design D10): `fromAlias` holds the From-picker
 *   selection (one of the account's aliases, or null = the bare account
 *   identity). The send service splits it: the alias shapes the MIME
 *   From HEADER while the envelope stays on the account address.
 * - Undo send (design D3, tasks 5.1/5.2): a send with undo enabled does
 *   NOT send immediately — `beginUndoWindow` closes the composer and runs
 *   a cancellable countdown (sendWithUndoDelay in undo-send.ts owns the
 *   timer and the provider send); the shell-level banner shows it and
 *   `cancelUndoSend` restores the snapshot below into an editable draft.
 *   The window is pre-send: nothing is transmitted or queued until it
 *   expires. `undoWindow` lives here (not in the composer pane) so the
 *   banner survives navigation.
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
 * A selected send-as identity (task 16.2, design D10): one of the
 * account's aliases, shown in the From picker. `null` means the bare
 * account identity — the send path keeps the ENVELOPE on the account
 * address either way; this only shapes the From HEADER.
 */
export interface FromAliasSelection {
  email: string
  name?: string
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

/**
 * The draft state an undo send holds onto for the window (design D3):
 * everything `cancelUndoSend` needs to put the user back into the
 * composer with the message intact. `mode` carries the reply/forward
 * context, `draftKey` addresses the still-existing autosaved row (the
 * real send deletes it; a cancel leaves it for continued editing).
 * Attachment metadata only — the bytes stay in the registry untouched
 * during the window (an intervening openNew clears them; a restore from
 * after that drops the ghosted descriptors with a warning toast, so the
 * restored draft never shows chips it cannot send).
 */
export interface UndoSendSnapshot {
  accountId: string
  mode: ComposerMode
  draftKey: string | null
  to: Recipient[]
  cc: Recipient[]
  bcc: Recipient[]
  showCc: boolean
  showBcc: boolean
  subject: string
  html: string
  attachments: ComposerAttachment[]
  /** From-picker selection at window start (task 16.2); a cancel
   * restores it with the rest of the draft. */
  fromAlias: FromAliasSelection | null
  /** Per-message PGP toggles at window start (task 18.5); optional so
   * older snapshots (and tests) stay valid — a cancel restores them,
   * defaulting to off. */
  pgpSign?: boolean
  pgpEncrypt?: boolean
}

/** The live window state the banner reads: the snapshot plus countdown. */
export interface UndoWindowState extends UndoSendSnapshot {
  totalSeconds: number
  remainingSeconds: number
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

  /**
   * The chosen send-as identity (task 16.2): null = the bare account
   * identity. Reset on openNew/openWith/reset like every draft field;
   * the From picker and the reply-alias preselection write it.
   */
  fromAlias: FromAliasSelection | null

  /**
   * Per-message PGP toggles (task 18.5): sign and/or encrypt THIS draft.
   * Composer-level intent only — not persisted account settings (18.7
   * owns the settings surface) and not serialized into local_drafts, so
   * they apply to the current draft only. The send service turns them
   * into RFC 3156 PGP/MIME (missing-key guard included).
   */
  pgpSign: boolean
  pgpEncrypt: boolean

  /** The active undo-send window (design D3): null when no send is
   * pending. The shell-level banner renders from this wherever the user
   * has navigated. */
  undoWindow: UndoWindowState | null

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
  /** Select the send-as identity for this draft (task 16.2); null
   * selects the bare account identity. */
  setFromAlias: (fromAlias: FromAliasSelection | null) => void
  /** Flip the per-message PGP sign / encrypt toggles (task 18.5). */
  togglePgpSign: () => void
  togglePgpEncrypt: () => void
  /**
   * Start the pre-send undo window (design D3): stores the snapshot, arms
   * the cancellable countdown via sendWithUndoDelay and closes the
   * composer — the banner replaces it. `delaySeconds` is clamped (0 = no
   * window, no-op; the caller sends immediately); expiry fires the real
   * provider send and closes the window. The frozen `sendArgs` (not the
   * live fields) are what expiry transmits.
   */
  beginUndoWindow: (args: {
    snapshot: UndoSendSnapshot
    sendArgs: SendComposerDraftArgs
    delaySeconds: number
  }) => void
  /**
   * Cancel the pending send: stops the timer before the provider is
   * invoked and restores the snapshot into an open, editable composer.
   * False when no window is active.
   */
  cancelUndoSend: () => boolean
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
  fromAlias: FromAliasSelection | null
  pgpSign: boolean
  pgpEncrypt: boolean
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
  fromAlias: null,
  pgpSign: false,
  pgpEncrypt: false,
}

/** The draft-dropping actions also clear the bytes registry so dropped
 * attachments cannot leak (close() deliberately keeps everything). */
function dropDraft(): InitialDraft {
  clearAttachmentBytes()
  return { ...INITIAL }
}

// ---- Undo send runtime (outside the store state: timers + generation) ----

interface ActiveUndoWindow {
  controller: UndoSendController
  countdown: ReturnType<typeof setInterval>
  generation: number
}

let activeUndoWindow: ActiveUndoWindow | null = null
/** Bumped by every cancel/supersede so a stale expiry callback (the send
 * promise resolving after its window was torn down) cannot touch state. */
let undoGeneration = 0

function stopUndoWindow(): void {
  if (!activeUndoWindow) return
  activeUndoWindow.controller.cancel()
  clearInterval(activeUndoWindow.countdown)
  activeUndoWindow = null
}

/** The set() partial that puts a window snapshot back into an open,
 * editable composer (cancelUndoSend and the expiry-failure path).
 * Attachment descriptors whose bytes are no longer registered (an
 * intervening openNew/openWith cleared the registry) are FILTERED out —
 * left in, they would render as chips while getComposerPayload silently
 * dropped them, so the user's next Send would transmit without files.
 * When any were dropped, a warning says so. */
function restoreSnapshot(snapshot: UndoSendSnapshot): Partial<ComposerState> {
  const restorable = snapshot.attachments.filter(
    (attachment) => getAttachmentBytes(attachment.id) !== undefined
  )
  if (restorable.length < snapshot.attachments.length) {
    toast.warning("Some attachments were no longer available and were removed")
  }
  return {
    open: true,
    mode: snapshot.mode,
    activeAccountId: snapshot.accountId,
    draftKey: snapshot.draftKey,
    to: [...snapshot.to],
    cc: [...snapshot.cc],
    bcc: [...snapshot.bcc],
    showCc: snapshot.showCc,
    showBcc: snapshot.showBcc,
    subject: snapshot.subject,
    html: snapshot.html,
    attachments: restorable.map((attachment) => ({ ...attachment })),
    fromAlias: snapshot.fromAlias,
    pgpSign: snapshot.pgpSign ?? false,
    pgpEncrypt: snapshot.pgpEncrypt ?? false,
  }
}

export const useComposerStore = create<ComposerState>((set, get) => ({
  ...INITIAL,
  // undoWindow sits outside INITIAL/dropDraft on purpose: an active
  // window must survive navigation (a mid-window openNew drops the
  // composer fields but keeps the banner and the pending send).
  undoWindow: null,

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

  setFromAlias: (fromAlias) => set({ fromAlias }),

  togglePgpSign: () => set((state) => ({ pgpSign: !state.pgpSign })),
  togglePgpEncrypt: () => set((state) => ({ pgpEncrypt: !state.pgpEncrypt })),

  beginUndoWindow: ({ snapshot, sendArgs, delaySeconds }) => {
    const totalSeconds = clampSendDelaySeconds(delaySeconds)
    // 0 = undo send disabled: no window, the caller sends immediately.
    if (totalSeconds <= 0) return
    // Supersede an active window: bump the generation FIRST so the old
    // window's .then handler below is inert and cannot clobber the new
    // window's state, then FLUSH the superseded controller — its pending
    // send transmits NOW (the same invoke path as expiry) instead of the
    // old stopUndoWindow() behavior that silently cancelled it (no send,
    // no toast, no restore).
    const generation = ++undoGeneration
    const superseded = activeUndoWindow
    if (superseded) {
      clearInterval(superseded.countdown)
      activeUndoWindow = null
      // Fire-and-forget outcome toast for the superseded message: its
      // window state is already gone (stale generation), so only the
      // result is still ours to surface.
      void superseded.controller.result.then((result) => {
        if (result === null) {
          toast.error("Sending failed")
        } else if (result.status === "queued") {
          if (result.queuedOffline) {
            toast.info("Message queued")
          } else {
            toast.success("Message sent")
          }
        } else {
          toast.error(result.error)
        }
      })
      superseded.controller.flush()
    }
    const controller = sendWithUndoDelay({
      ...sendArgs,
      delaySeconds: totalSeconds,
    })
    const countdown = setInterval(() => {
      set((state) =>
        state.undoWindow && state.undoWindow.remainingSeconds > 1
          ? {
              undoWindow: {
                ...state.undoWindow,
                remainingSeconds: state.undoWindow.remainingSeconds - 1,
              },
            }
          : {}
      )
    }, 1000)
    activeUndoWindow = { controller, countdown, generation }
    set({
      undoWindow: {
        ...snapshot,
        totalSeconds,
        remainingSeconds: totalSeconds,
      },
      // The banner replaces the composer for the window (design D3:
      // pre-send — the draft row and its bytes are left exactly as they
      // were, so a cancel or an app restart still finds the content).
      open: false,
    })

    void controller.result.then((result) => {
      if (generation !== undoGeneration) return // cancelled/superseded
      stopUndoWindow()
      set({ undoWindow: null })
      if (!result) {
        // Null here means the send impl REJECTED — a crash, not a cancel
        // (cancels resolve through the generation path above). Nothing
        // was transmitted: put the draft back into the composer and say
        // so, unless the user already started a new compose.
        if (!get().open) set(restoreSnapshot(snapshot))
        toast.error("Sending failed — your draft was restored")
        return
      }
      if (result.status === "queued") {
        // The send is real now (sendComposerDraft already deleted the
        // local_drafts row): clear the stale fields and attachment bytes,
        // unless the user started a new compose mid-window — those fields
        // are theirs.
        if (!get().open) set(dropDraft())
        if (result.queuedOffline) {
          toast.info("Message queued")
        } else {
          toast.success("Message sent")
        }
      } else {
        // The local enqueue path failed — nothing was transmitted, so
        // the draft goes back into the composer with the error surfaced
        // (an in-progress new compose is left alone, like the queued
        // branch above).
        if (!get().open) set(restoreSnapshot(snapshot))
        toast.error(result.error)
      }
    })
  },

  cancelUndoSend: () => {
    const undoWindow = get().undoWindow
    if (!undoWindow || !activeUndoWindow) return false
    // The expiry timer already fired: the provider send is in flight and
    // WILL commit — restoring the snapshot here would have the user's
    // next Send duplicate it. The window closes via its own .then.
    if (activeUndoWindow.controller.hasFired()) return false
    stopUndoWindow()
    undoGeneration += 1
    set({ undoWindow: null, ...restoreSnapshot(undoWindow) })
    return true
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
