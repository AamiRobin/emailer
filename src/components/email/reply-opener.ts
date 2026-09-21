import { getAccount, toEmailAccount } from "@/services/db/accounts"
import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import { getDraft } from "@/services/composer/drafts"
import type { DraftRecord } from "@/services/composer/drafts"
import {
  restoreDraftAttachmentBytes,
  type RestoredDraftAttachment,
} from "@/services/composer/draft-attachments"
import { buildReply } from "@/services/composer/reply"
import {
  appendSignature,
  getSignature,
  SIGNATURE_BLOCK_CLASS,
} from "@/services/composer/signatures"
import { setAttachmentBytes } from "@/components/composer/attachment-bytes"
import { getThreadWithMessages } from "@/services/db/threads"
import type { ComposerMode } from "@/stores/composer-store"
import { useComposerStore } from "@/stores/composer-store"
import { useAccountStore } from "@/stores/account-store"
import { useUiStore } from "@/stores/ui-store"
import { toast } from "sonner"

/**
 * Shared composer-open helpers (tasks 7.6/8.4/8.6, mail-organization spec
 * "context menu mirrors the toolbar/keyboard actions"): ONE reply-prefill
 * path and ONE draft-resume path, consumed by the thread view's toolbar +
 * inline reply, the thread list's context-menu/row defaults and the
 * keyboard `r` binding — so every surface produces the exact same
 * composer state.
 *
 * Bridge ordering contract (moved here verbatim from thread-view): the
 * composer store is configured FIRST — `openWith` already sets
 * composer-store.open — and ui-store's composerOpen flag is flipped only
 * afterwards. MailShell's bridge effect calls `openNew` only when
 * composer-store.open is still false, so an already-configured store is
 * never clobbered with a blank new message; the shell just mounts the
 * overlay around the prefilled draft.
 */

/**
 * ── draftKey join (composer 8.6 parallel change) ─────────────────────
 * The resume path needs the composer autosave to keep updating the SAME
 * local_drafts row. The composer worker owns composer-store/composer
 * components, which do not carry the `draftKey` state field yet, so the
 * key lives here until the store adopts it:
 *
 *   JOIN: when `draftKey: string | null` lands in ComposerState/INITIAL
 *   (composer-store.ts), replace this module variable with store state —
 *   openDraftForResume below sets it via
 *   `useComposerStore.setState({ draftKey })`, and the autosave hook reads
 *   `useComposerStore.getState().draftKey` instead of importing this
 *   getter. Until then the composer worker can read the same value through
 *   getActiveComposerDraftKey().
 */
let activeDraftKey: string | null = null

/** The draftKey of the draft the current composer content was resumed
 * from, or null when the composer content is not a resumed draft. */
export function getActiveComposerDraftKey(): string | null {
  return activeDraftKey
}

export interface OpenReplyOptions {
  /** Thread to reply to (its latest message is the reply target). */
  threadId: string
  /** Reply-all expands to sender + original To/Cc (see buildReply). */
  replyAll: boolean
  /** Compose from this account; defaults to the store's active account. */
  accountId?: string
  /**
   * Executor override. Production callers omit it (getExecutor());
   * the thread list passes its store's executor seam so tests can inject
   * one node:sqlite database through setThreadListStoreExecutor().
   */
  executor?: SqlExecutor
}

/**
 * Load `threadId` + its latest message, fetch the account signature and
 * open the app-level composer prefilled as a reply. Resolves to false
 * (composer untouched) when there is no account, the thread is unknown or
 * has no messages, or the db is unavailable (getExecutor() outside
 * Tauri); failures are logged, never thrown.
 */
export async function openReplyForThread(
  options: OpenReplyOptions
): Promise<boolean> {
  return openReplyPrefill(options)
}

/**
 * Smart-reply insertion (task 4.5, ai-assistance spec "Writing-style smart
 * replies"): the reply dialog's "Use reply" lands here. Additive sibling
 * of `openReplyForThread` sharing its ENTIRE prefill path — buildReply
 * still supplies the reply mode (inReplyTo/references/source ids), the
 * recipients and the Re: subject — with ONE difference, by design: the
 * suggestion REPLACES the built draft body (the quoted history is not
 * included), so the composer opens with the style-matched draft text for
 * editing, never a send (spec: suggestions are editable drafts only, one
 * at a time on request). `bodyHtml` is the ready-to-edit HTML (the caller
 * converts its plain suggestion via escape + <br>/<p>, the same pattern as
 * the compose transform's splice-in); the account signature is appended
 * below it. Same ordering contract, same false-on-no-op resolutions.
 */
export async function openSmartReplyForThread(
  options: OpenReplyOptions & { bodyHtml: string }
): Promise<boolean> {
  return openReplyPrefill(options, options.bodyHtml)
}

/**
 * Quick-reply insertion (parity-round-2 task 2.4, ai-assistance spec "AI
 * quick reply suggestions"): the reading pane's suggestion chips land
 * here. Additive sibling of `openSmartReplyForThread` sharing its ENTIRE
 * prefill path — buildReply supplies the reply mode (inReplyTo/references/
 * source ids), the recipients and the Re: subject, and the suggestion
 * REPLACES the built draft body — under a different name so the two chip
 * surfaces stay independently testable. The composer opens with the
 * suggestion as EDITABLE draft text addressed to the sender; nothing is
 * ever sent without the user's explicit send action (spec scenario "Use
 * a suggestion"). `bodyHtml` is the ready-to-edit HTML; the account
 * signature is appended below it. Same ordering contract, same
 * false-on-no-op resolutions.
 */
export async function openQuickReplyForThread(
  options: OpenReplyOptions & { bodyHtml: string }
): Promise<boolean> {
  return openReplyPrefill(options, options.bodyHtml)
}

/** The shared prefill path; `bodyHtmlOverride` swaps the built body. */
async function openReplyPrefill(
  options: OpenReplyOptions,
  bodyHtmlOverride?: string
): Promise<boolean> {
  const accountId =
    options.accountId ?? useAccountStore.getState().activeAccountId
  if (!accountId) return false
  let executor: SqlExecutor
  try {
    executor = options.executor ?? getExecutor()
  } catch (error) {
    console.warn("[reply-opener] db unavailable", error)
    return false
  }
  try {
    const loaded = await getThreadWithMessages(executor, options.threadId)
    if (!loaded || loaded.messages.length === 0) return false
    if (loaded.thread.account_id !== accountId) return false
    // Thread-level reply target: the latest message (chronological load).
    const message = loaded.messages[loaded.messages.length - 1]
    let signatureHtml = ""
    try {
      signatureHtml = await getSignature(executor, accountId)
    } catch (error) {
      // Reply without a signature instead of blocking the composer.
      console.warn("[reply-opener] signature unavailable", error)
    }
    // buildReply only needs id + email; an unresolved account degrades to
    // no self-filtering rather than blocking the reply.
    const accountRow = await getAccount(executor, accountId)
    const account = accountRow
      ? toEmailAccount(accountRow)
      : { id: accountId, email: "" }
    const prefill = buildReply({
      message,
      thread: loaded.thread,
      account,
      replyAll: options.replyAll,
      signatureHtml,
    })
    // Smart replies (task 4.5): keep the addressing/subject/threading
    // context, replace the quoted draft body with the suggestion text;
    // the signature moves below the suggestion (no quote block follows).
    const html =
      bodyHtmlOverride !== undefined
        ? appendSignature(bodyHtmlOverride, signatureHtml)
        : prefill.html
    applyComposerPrefill(prefill.mode, accountId, {
      to: prefill.to,
      cc: prefill.cc,
      subject: prefill.subject,
      html,
    })
    // Signature selector default (fix 3): the prefill embedded the
    // account's signature via buildReply/appendSignature — the control
    // reflects it, so a later selection swap replaces that block.
    if (signatureHtml.trim() !== "") {
      useComposerStore.getState().setSignatureSelection(accountId)
    }
    activeDraftKey = null
    useUiStore.getState().setComposerOpen(true)
    return true
  } catch (error) {
    console.warn("[reply-opener] failed to open reply", error)
    return false
  }
}

/**
 * Open the app-level composer prefilled from a local draft snapshot
 * (Drafts-folder resume, drafts.ts's recipe): reply drafts re-enter reply
 * mode (inReplyTo/sourceThreadId), everything else opens as a new message.
 * The draft's own body is restored verbatim — the stored quote already
 * lives inside it, so nothing is re-quoted. The row's draftKey is recorded
 * (see the join note above) so autosave keeps updating the same row, and
 * the row is NOT deleted: resume keeps it until the draft is sent or
 * discarded (the composer worker's send/discard paths own deleteDraft).
 *
 * `restoredAttachments` (fix 1): the persisted attachment bytes
 * restoreDraftAttachmentBytes decoded for this draft. They are
 * registered into the session registry AFTER openWith (which clears it)
 * and their metadata lands in the store, so the resumed draft's files
 * render, preview and send exactly like freshly attached ones.
 */
export function openDraftForResume(
  draft: DraftRecord,
  restoredAttachments?: RestoredDraftAttachment[]
): void {
  const replying = draft.inReplyTo !== null || draft.threadId !== null
  const mode: ComposerMode = replying
    ? {
        kind: "reply",
        replyAll: false,
        inReplyTo: draft.inReplyTo ?? undefined,
        sourceThreadId: draft.threadId ?? undefined,
      }
    : { kind: "new" }
  applyComposerPrefill(mode, draft.accountId, {
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    html: draft.bodyHtml,
    // draftKey join (see above): resume must reuse the row's key so the
    // composer's autosave updates THIS draft instead of creating a new one
    // — override the fresh key openWith just generated.
    draftKey: draft.draftKey ?? undefined,
  })
  if (restoredAttachments && restoredAttachments.length > 0) {
    for (const attachment of restoredAttachments) {
      setAttachmentBytes(attachment.id, attachment.bytes)
    }
    useComposerStore.getState().setAttachments(
      restoredAttachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        ...(attachment.mimeType !== undefined
          ? { mimeType: attachment.mimeType }
          : {}),
      }))
    )
  }
  // Signature selector default (fix 3): a stored managed block means the
  // draft carried a signature — attribute it to the draft's account (the
  // prefill default), so the control shows the truth about the body.
  useComposerStore
    .getState()
    .setSignatureSelection(
      draft.bodyHtml.includes(SIGNATURE_BLOCK_CLASS) ? draft.accountId : null
    )
  activeDraftKey = draft.draftKey
  useUiStore.getState().setComposerOpen(true)
}

/**
 * Load one draft by row id and resume it. Resolves to false when the row
 * is gone or the db is unavailable; failures are logged, never thrown.
 *
 * Persisted attachment bytes (fix 1) are loaded BEFORE the composer
 * opens: a corrupt/oversized stored payload drops that attachment with a
 * visible warning while the rest of the draft resumes untouched, and the
 * successfully decoded files are registered with the prefill so the
 * composer never shows a chip it cannot send.
 */
export async function resumeDraft(
  executor: SqlExecutor,
  draftId: string
): Promise<boolean> {
  let draft: DraftRecord | null
  try {
    draft = await getDraft(executor, draftId)
  } catch (error) {
    console.warn("[reply-opener] failed to load draft", error)
    return false
  }
  if (!draft) return false
  let restored: {
    attachments: RestoredDraftAttachment[]
    dropped: string[]
  } = { attachments: [], dropped: [] }
  if (draft.draftKey) {
    try {
      restored = await restoreDraftAttachmentBytes(
        executor,
        draft.accountId,
        draft.draftKey
      )
    } catch (error) {
      console.warn("[reply-opener] failed to restore attachments", error)
    }
  }
  openDraftForResume(draft, restored.attachments)
  if (restored.dropped.length > 0) {
    toast.warning(
      restored.dropped.length === 1
        ? `Attachment "${restored.dropped[0]}" couldn't be restored and was removed`
        : `Some attachments couldn't be restored and were removed: ${restored.dropped.join(", ")}`
    )
  }
  return true
}

/** Configure the composer store for one prefill (the 8.4 setter bridge):
 * openWith first (it resets + opens), then every field setter. */
function applyComposerPrefill(
  mode: ComposerMode,
  accountId: string | null,
  fields: {
    to: DraftRecord["to"]
    cc?: DraftRecord["cc"]
    bcc?: DraftRecord["bcc"]
    subject: string
    html: string
    draftKey?: string
  }
): void {
  const composer = useComposerStore.getState()
  composer.openWith(mode, accountId)
  composer.setTo(fields.to)
  composer.setCc(fields.cc ?? [])
  composer.setBcc(fields.bcc ?? [])
  composer.setSubject(fields.subject)
  composer.setHtml(fields.html)
  if (fields.draftKey !== undefined) {
    useComposerStore.setState({ draftKey: fields.draftKey })
  }
}
