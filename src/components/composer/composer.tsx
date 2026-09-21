import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react"
import { Link as LinkExtension } from "@tiptap/extension-link"
import ImageExtension from "@tiptap/extension-image"
import { TextAlign } from "@tiptap/extension-text-align"
import { Underline } from "@tiptap/extension-underline"
import { Node } from "@tiptap/react"
import { EditorContent, useEditor } from "@tiptap/react"
import { StarterKit } from "@tiptap/starter-kit"
import { Placeholder } from "@tiptap/extensions"
import {
  ChevronDown,
  ExternalLink,
  Maximize2,
  Minimize2,
  Minus,
  Paperclip,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useAccountStore } from "@/stores/account-store"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import { getComposerPayload, useComposerStore } from "@/stores/composer-store"
import { refreshThreadList } from "@/stores/thread-list-store"
import { useUiStore } from "@/stores/ui-store"
import {
  isComposerPopoutWindow,
  isTauriRuntime,
  openComposerPopout,
} from "@/services/desktop/popout"
import { hasInvalidRecipient } from "./address-validation"
import { addFileAttachments, pickAttachments } from "./attachment-input"
import { getAttachmentBytes } from "./attachment-bytes"
import { AttachmentStrip } from "./attachment-strip"
import { ComposerToolbar } from "./composer-toolbar"
import { AiPromptDialog } from "./ai-prompt-dialog"
import {
  fileToDataUrl,
  insertInlineImage,
  inlineImageTooLargeMessage,
  partitionImageFiles,
  pickInlineImages,
} from "./inline-image"
import { RecipientField } from "./recipient-field"
import { ScheduleSendMenu } from "./schedule-send-menu"
import { SendGuardDialogs } from "./send-guard-dialogs"
import { evaluateSendGuards, type SendGuardKind } from "./send-guards"
import {
  createSnippetExpansion,
  setSnippetShortcuts,
  setSnippetVariablePrompt,
} from "./snippet-insert"
import { SnippetVariableDialog } from "./snippet-variable-dialog"
import {
  captureTransformTarget,
  COMPOSE_TRANSFORM_LABELS,
  replaceDraftRange,
  transformedTextToHtml,
} from "./compose-transform"
import { ComposeTransformBar } from "./compose-transform-bar"
import { transformDraftText } from "@/services/ai/compose-transform"
import type { ComposeTransformMode } from "@/services/ai/compose-transform"
import {
  generateDraftFromPrompt,
  generateReplyForThread,
} from "@/services/ai/compose-generate"
import { isAiConfigured, isSurfaceEnabled } from "@/services/ai/settings"
import { getDefaultPrivateKey } from "@/services/crypto/pgp-keys"
import {
  deleteDraftByKey,
  isDraftEmpty,
  type DraftInput,
} from "@/services/composer/drafts"
import { syncDraftAttachmentBytes } from "@/services/composer/draft-attachments"
import {
  resolveMissingPgpRecipients,
  sendComposerDraft,
} from "@/services/composer/send"
import { useDraftAutosave } from "@/services/composer/use-draft-autosave"
import { getSendAsAliases, type AliasRow } from "@/services/db/aliases"
import { getExecutor } from "@/services/db/executor"
import { getMessage } from "@/services/db/messages"
import { listSnippets, type SnippetRow } from "@/services/db/snippets"
import {
  getAttachmentGuardSuppressed,
  getEmptySubjectGuardSuppressed,
  getSendDelaySeconds,
  setAttachmentGuardSuppressedPreference,
  setComposerModePreference,
  setEmptySubjectGuardSuppressedPreference,
} from "@/services/settings/preferences"
import { scheduleComposerSend } from "@/components/layout/use-scheduled-sends"
import { formatSnoozedUntil } from "@/components/layout/use-snoozed-threads"
import {
  defaultShortcutKeys,
  type ShortcutId,
} from "@/constants/shortcuts"
import { setComposerKeyActions } from "./composer-key-actions"
import {
  getSignature,
  insertSignatureBlock,
  SIGNATURE_BLOCK_CLASS,
} from "@/services/composer/signatures"

/**
 * The composer view (tasks 8.1 + 8.2): To/Cc/Bcc recipient fields with
 * per-chip validity flags and contact autocomplete (8.3), subject, TipTap
 * rich-text body with a formatting toolbar, and a Send/Discard footer.
 *
 * Self-contained by contract: the mailbox shell decides when this view is
 * mounted (ui-store composerOpen) and calls `composer-store.openNew` to
 * start a blank message; this component renders null while the composer
 * store is closed, so it is safe to keep mounted. Opening a new message
 * puts focus in the To field (mail-composition spec); reply/forward modes
 * pre-fill recipients (task 8.4) and manage their own focus.
 *
 * The editor syncs its HTML into composer-store on every update.
 *
 * Task 8.5 (attachments): the whole composer surface is a dropzone — it
 * highlights on dragover and dropped OS files are read (bytes land in the
 * attachment-bytes registry) and surface as removable chips in the
 * attachment strip above the footer. The footer's "Attach file" button
 * opens the system picker (multiple). Cap breaches and read failures show
 * as an inline error above the footer (see attachment-input.ts).
 *
 * Task 8.6 (draft autosave): the store hands out a fresh `draftKey` per
 * open; this view mounts useDraftAutosave against the composer snapshot
 * (recipients, subject, body, attachment descriptors, reply context) so
 * edits land in `local_drafts` after a 3s quiet period. Explicit close
 * paths flush first, then delete the row by key: a confirmed discard
 * (non-empty drafts require confirmation) and a successful send both end
 * with the draft row gone.
 *
 * Task 8.7 (send): Send enables when the draft is sendable — at least one
 * valid recipient and a subject or body — and calls sendComposerDraft
 * with the payload from getComposerPayload(). Success closes the composer
 * with a toast ("Message queued" when offline); a failure keeps the
 * composer open and shows the sanitized error with a Retry affordance.
 * Undo send (design D3, tasks 5.1/5.2): a positive per-account delay
 * (preferences.ts getSendDelaySeconds) starts the pre-send window instead
 * — composer-store.beginUndoWindow owns the countdown, the shell-level
 * banner and the cancel/restore; only a delay of 0 keeps this component
 * on the immediate send path below.
 *
 * Task 5.3 (send guards): before the send flow starts, Send runs the
 * draft through two prompts — the forgotten-attachment reminder
 * (attachment wording in the visible body while no file is attached;
 * quoted history excluded) and the empty-subject confirmation. Each fires
 * at most once per attempt and can be suppressed per account (the
 * prompt's "Don't ask again" checkbox, persisted in preferences.ts). The
 * prompts strictly precede the undo-send window: a guard answer is not a
 * send, so the countdown can never start under an open dialog.
 *
 * Task 6.2 (snippets): the global snippet list is loaded on open and
 * exposed two ways — a "Snippet" picker in the toolbar (inserts the body
 * at the cursor) and keyboard expansion (typing a snippet shortcut then
 * Space replaces it with the body; see snippet-insert.ts for the
 * mechanism).
 *
 * Task 2.3 (snippet variables, design D11): this component owns the ONE
 * unknown-variable prompt — snippet-insert's substitution reports the ids
 * it cannot fill from the compose context and the dialog below collects a
 * value per id (applied to all occurrences) before the insertion
 * continues. Keyboard expansion cannot prompt (synchronous keydown) and
 * leaves unknown ids literal instead.
 *
 * Task 10.1 (schedule send): a clock button beside Send opens the
 * send-later picker (presets + custom date/time). Picking a time runs the
 * shared schedule flow — the payload is built EXACTLY as Send builds it,
 * validated by the same gates, and the fully built MIME is stored in
 * scheduled_sends with the due time; the draft row is removed like on a
 * send and the composer closes with a "Scheduled for <time>" toast. The
 * stored jobs are listed (and edited/cancelled) from the sidebar's
 * Scheduled dialog; transmission itself is task 10.2's due pass.
 *
 * Task 16.2 (send-as, design D10): a compact From picker above the To
 * field lists the ACTIVE account's send-as aliases (default first, via
 * getSendAsAliases) beside the bare account identity. Opening a draft
 * preselects the account's default alias; a REPLY preselects the alias
 * the original message was addressed to (its To/Cc, case-insensitive),
 * falling back to the default. The selection lands in composer-store
 * `fromAlias` and rides to the send service, which splits it into the
 * MIME From header (alias) vs. the envelope (account address).
 *
 * Task 18.5 (PGP send, design D11): two per-message toolbar toggles
 * (Sign / Encrypt) set the composer-store PGP intent for THIS draft. At
 * Send time, before the send service runs: encryption is checked against
 * the stored public keys — a recipient without one blocks the attempt in
 * a dialog naming them, offering "Disable encryption and send" instead
 * (the mail-security spec's missing-key scenario); signing needs the
 * account's default private key and a per-use passphrase, asked in a
 * send-time dialog and held only in this component's memory (never
 * persisted, never stored) so both the immediate send and the frozen
 * undo-window args can carry it. Scheduling is refused while a PGP mode
 * is active (the schedule flow stores plaintext MIME by design).
 *
 * Task 4.6 (compose text transform, ai-assistance spec, design D1): when
 * AI is configured and the composeTransform surface is enabled (flags
 * loaded once per mount; unconfigured surfaces HIDE — no error state),
 * the toolbar's AI menu runs improve/shorten/formalize over the selected
 * draft text (or the whole body when nothing is selected). The result is
 * a PENDING replacement: a bar between toolbar and body shows
 * "Transforming…", then Accept/Discard (or the provider error + Retry).
 * The draft stays fully editable throughout and is untouched until the
 * user explicitly accepts; accepting splices the transformed text in
 * (undoable via the editor's native history) and surfaces an Undo toast
 * restoring the original range. All transform state is component state,
 * not composer-store — a pending replacement is transient UI, not draft
 * data (same reasoning as the snippet variable prompt), and it must die
 * with the composer.
 *
 * Batch C2 adds three surfaces to this view:
 *
 * - Size modes + minimize: the shell renders the overlay container as
 *   either FULL (today's surface) or CENTERED (a rounded card over a
 *   dimmed backdrop) — this view is identical in both, the header's
 *   toggle just flips ui-store.composerMode. Minimize (the header button
 *   AND the Esc binding) hides the overlay behind the shell's tray chip
 *   while the store stays open (autosave, shortcut gates and any
 *   in-flight undo window continue); the close (X) button keeps the
 *   saveNow + keep-draft flow, pointer-only. A pop-out button (Tauri
 *   only) moves the draft into its own window: saveNow, then the new
 *   window's LABEL carries the draft key and composer-popout.tsx resumes
 *   the whole draft — bytes included — from local_drafts.
 *
 * - Inline images: the TipTap Image extension (inline, allowBase64)
 *   accepts data-URL <img> elements; pasted image FILES and dropped
 *   image files route through processIncomingFiles, which inserts
 *   inline-able images (≤ 2 MB) at the cursor and sends everything else
 *   — non-images and over-cap images, the latter with an explainer
 *   toast — to the attachment pipeline. The toolbar's image button picks
 *   files through the system dialog. The body keeps data: URLs until the
 *   MIME build (mime-builder extractInlineImages) turns them into
 *   multipart/related parts with Content-IDs.
 *
 * - Send & Archive: the Send button grows a chevron menu for reply/forward
 *   drafts bound to a thread; "Send & Archive" runs this exact send flow
 *   and archives the source thread once the send commits — via the
 *   archiveSourceThreadId flag on the send args, so the undo-window path
 *   archives at expiry (when the send is real) and cancel/failure never
 *   archives.
 *
 * Batch C3 adds:
 *
 * - Toolbar rounding-out (see composer-toolbar.tsx): the StarterKit
 *   affordances the editor already enabled — undo/redo, strikethrough,
 *   inline code, blockquote — get buttons.
 *
 * - AI generative offers beside the transforms (ai menu): "Draft from
 *   prompt" (blank-slate new compose; a small dialog collects the
 *   instruction) and "Generate reply" (reply/forward drafts bound to a
 *   thread). Both ride the SAME one-offer pending-replacement flow as the
 *   transforms — Transforming… → Accept/Discard, error + Retry — and the
 *   result only ever enters the draft through an explicit Accept
 *   (whole-body for the generative offers). Caching, tier resolution and
 *   the fence contract live in services/ai/compose-generate.ts.
 */

/** Token utilities standing in for prose styles (no typography plugin):
 * list markers, paragraph rhythm and link styling inside the editor. */
const EDITOR_CONTENT_CLASS =
  "max-w-none [&_a]:text-primary [&_a]:underline [&_ol]:list-decimal [&_ol]:ps-6 [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p.is-empty:first-child]:before:pointer-events-none [&_p.is-empty:first-child]:before:float-left [&_p.is-empty:first-child]:before:h-0 [&_p.is-empty:first-child]:before:content-[attr(data-placeholder)] [&_p.is-empty:first-child]:before:text-muted-foreground [&_ul]:list-disc [&_ul]:ps-6"

/** Tooltip suffix showing a binding's default keys (" (Cmd/Ctrl+Enter)").
 * The shortcuts overlay renders the live effective table; tooltips stay a
 * static hint beside the affordance the binding drives. */
function keysHint(id: ShortcutId): string {
  const keys = defaultShortcutKeys(id)
  return keys ? ` (${keys})` : ""
}

/** One selectable signature option of the per-message selector (fix 3):
 * the account it belongs to, its display label and its HTML body. */
interface SignatureOption {
  accountId: string
  label: string
  html: string
}

/**
 * TipTap node for the managed signature block (fix 3): the wrapper div
 * the signature service emits is not a default editor node, so without
 * this rule every editor round-trip (setContent on selection change, and
 * every later keystroke's serialization) would strip the div and lose
 * the block the removal/replacement logic anchors on. Registered as a
 * transparent block node that parses and renders the exact div, the
 * signature survives the editor like the quoted blockquote does.
 */
const EmailSignatureBlock = Node.create({
  name: "emailSignatureBlock",
  group: "block",
  content: "block+",
  parseHTML() {
    return [{ tag: `div[class="${SIGNATURE_BLOCK_CLASS}"]` }]
  },
  renderHTML() {
    return ["div", { class: SIGNATURE_BLOCK_CLASS }, 0]
  },
})

/** Alias row → the store's From-picker selection shape (task 16.2). */
function toFromAliasSelection(alias: AliasRow): {
  email: string
  name?: string
} {
  return {
    email: alias.email,
    ...(alias.display_name ? { name: alias.display_name } : {}),
  }
}

/** Visibility gate: everything expensive (the TipTap instance) mounts
 * only while the composer is open, so a draft rehydrated into the store
 * (task 8.6 resume) is picked up as the editor's initial content. */
export function Composer() {
  const open = useComposerStore((state) => state.open)
  if (!open) return null
  return <ComposerView />
}

function ComposerView() {
  const mode = useComposerStore((state) => state.mode)
  const to = useComposerStore((state) => state.to)
  const cc = useComposerStore((state) => state.cc)
  const bcc = useComposerStore((state) => state.bcc)
  const showCc = useComposerStore((state) => state.showCc)
  const showBcc = useComposerStore((state) => state.showBcc)
  const subject = useComposerStore((state) => state.subject)
  const setTo = useComposerStore((state) => state.setTo)
  const setCc = useComposerStore((state) => state.setCc)
  const setBcc = useComposerStore((state) => state.setBcc)
  const setSubject = useComposerStore((state) => state.setSubject)
  const setHtml = useComposerStore((state) => state.setHtml)
  const toggleCc = useComposerStore((state) => state.toggleCc)
  const toggleBcc = useComposerStore((state) => state.toggleBcc)
  const reset = useComposerStore((state) => state.reset)
  const close = useComposerStore((state) => state.close)
  const draftKey = useComposerStore((state) => state.draftKey)
  const composerAccountId = useComposerStore((state) => state.activeAccountId)
  // Fall back to the shell's active account (e.g. a composer opened before
  // an account selection landed in the store).
  const shellAccountId = useAccountStore((state) => state.activeAccountId)
  const accountId = composerAccountId ?? shellAccountId

  const toInputRef = useRef<HTMLInputElement>(null)

  // ---- Draft autosave (task 8.6) ----

  const executor = useMemo(() => getExecutor(), [])

  /** Composer store → the serializable DraftInput shape. Cheap read of
   * already-loaded state (the autosave poll calls it every second). */
  const getDraftInput = useCallback((): DraftInput => {
    const state = useComposerStore.getState()
    const reply = state.mode.kind === "reply" ? state.mode : undefined
    const forward = state.mode.kind === "forward" ? state.mode : undefined
    const inReplyTo = reply?.inReplyTo
    const threadId = reply?.sourceThreadId ?? forward?.sourceThreadId
    return {
      to: state.to,
      cc: state.cc,
      bcc: state.bcc,
      subject: state.subject,
      bodyHtml: state.html,
      ...(state.attachments.length > 0
        ? {
            attachments: state.attachments.map((attachment) => ({
              filename: attachment.name,
              size: attachment.size,
            })),
          }
        : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(threadId ? { threadId } : {}),
    }
  }, [])

  const { flush, saveNow } = useDraftAutosave({
    accountId: accountId ?? "",
    draftKey: draftKey ?? "",
    getDraftInput,
    executor,
    enabled: Boolean(accountId && draftKey),
  })

  // ---- Draft attachment bytes (batch C1, fix 1) ----

  // Bytes ride the draft: every attachment LIST change (add, remove, and
  // the mount-time first observation of a resumed draft) reconciles the
  // persisted rows under the draft key with the live list, reading the
  // raw bytes from the session registry. Deliberately outside the
  // autosave JSON diff — the poll stringifies its snapshot every second
  // and must never stringify megabytes of payload; add/remove/mount are
  // exactly the moments a save could still pick the bytes up.
  const attachments = useComposerStore((state) => state.attachments)
  useEffect(() => {
    if (!accountId || !draftKey) return
    syncDraftAttachmentBytes(executor, accountId, draftKey, attachments).catch(
      (error) => {
        console.warn("[composer] failed to persist attachment bytes", error)
      }
    )
  }, [executor, accountId, draftKey, attachments])

  /**
   * Post-close cache refresh: a sent, scheduled or discarded draft changed
   * the mailbox data behind the composer (the local_drafts row is gone, a
   * sent message landed in Sent) — re-read the visible list and the folder
   * badges now instead of waiting for the next sync (the same discipline
   * as the toolbar/context-menu action flows).
   */
  const refreshMailboxCaches = () => {
    void refreshThreadList()
    void useFolderCountsStore.getState().refreshFolderCounts()
  }

  // ---- From picker (task 16.2, design D10) ----

  const fromAlias = useComposerStore((state) => state.fromAlias)
  const setFromAlias = useComposerStore((state) => state.setFromAlias)
  // The bare identity option mirrors the account row from the switcher's
  // store (the composer has no account picker of its own).
  const composerAccount = useAccountStore((state) =>
    accountId
      ? state.accounts.find((account) => account.id === accountId)
      : undefined
  )

  /** The active account's send-as identities (default first, then
   * alphabetical); the picker renders only when there is at least one. */
  const [aliases, setAliases] = useState<AliasRow[]>([])
  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    getSendAsAliases(executor, accountId)
      .then((rows) => {
        if (!cancelled) setAliases(rows)
      })
      .catch((error) => {
        console.warn("[composer] failed to load aliases", error)
      })
    return () => {
      cancelled = true
    }
  }, [executor, accountId])

  /** One preselection per open: a REPLY prefers the alias the original
   * message was addressed to (its To/Cc, case-insensitive); everything
   * else — and a reply without a match — falls back to the account's
   * default alias. A selection the user already made is never overridden. */
  useEffect(() => {
    if (!accountId || aliases.length === 0) return
    if (useComposerStore.getState().fromAlias) return
    const mode = useComposerStore.getState().mode
    const fallback = aliases.find((alias) => alias.is_default === 1) ?? null
    if (mode.kind !== "reply" || !mode.sourceMessageId) {
      if (fallback) setFromAlias(toFromAliasSelection(fallback))
      return
    }
    let cancelled = false
    getMessage(executor, mode.sourceMessageId)
      .then((message) => {
        if (cancelled) return
        if (useComposerStore.getState().fromAlias) return
        const addressed = [...(message?.to ?? []), ...(message?.cc ?? [])]
          .map((contact) => contact.email?.trim().toLowerCase())
          .filter((email): email is string => Boolean(email))
        const match = aliases.find((alias) =>
          addressed.includes(alias.email.toLowerCase())
        )
        const picked = match ?? fallback
        if (picked) setFromAlias(toFromAliasSelection(picked))
      })
      .catch((error) => {
        console.warn("[composer] failed to resolve the reply alias", error)
        if (!cancelled && fallback) setFromAlias(toFromAliasSelection(fallback))
      })
    return () => {
      cancelled = true
    }
  }, [accountId, aliases, executor, setFromAlias])

  // ---- Per-message signature selector (batch C1, fix 3) ----

  const signatureSelection = useComposerStore(
    (state) => state.signatureSelection
  )
  const setSignatureSelection = useComposerStore(
    (state) => state.setSignatureSelection
  )

  // Draft notice line (batch C3): set by the send-again opener when the
  // prefilled draft could not fully mirror the original (unrestorable
  // attachments); the composer only renders and dismisses it.
  const attachmentNotice = useComposerStore((state) => state.attachmentNotice)
  const setAttachmentNotice = useComposerStore(
    (state) => state.setAttachmentNotice
  )

  // One option per account that HAS a signature (settings-stored, per
  // account — signatures.ts), so any signature is selectable from any
  // draft; the sending account's is the prefill default. Reloading with
  // the accounts list keeps the offered options in step with account and
  // settings changes for as long as the composer stays mounted.
  const accounts = useAccountStore((state) => state.accounts)
  const [signatureOptions, setSignatureOptions] = useState<SignatureOption[]>(
    []
  )
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // An empty accounts list resolves to [] — the selector hides.
        const options = await Promise.all(
          accounts.map(async (account) => ({
            accountId: account.id,
            label: account.displayName
              ? `${account.displayName} <${account.email}>`
              : account.email,
            html: await getSignature(executor, account.id),
          }))
        )
        if (!cancelled) {
          setSignatureOptions(
            options.filter((option) => option.html.trim() !== "")
          )
        }
      } catch (error) {
        console.warn("[composer] failed to load signatures", error)
        if (!cancelled) setSignatureOptions([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [executor, accounts])

  // ---- Send guards (task 5.3) ----

  /** Guards waiting to be answered this attempt, in prompt order; the
   * head is the one whose dialog is open. */
  const [guardQueue, setGuardQueue] = useState<SendGuardKind[]>([])
  const activeGuard = guardQueue[0] ?? null
  /** Guards satisfied for the CURRENT attempt ("Send anyway"): a fresh
   * Send click starts a new attempt, so each guard fires at most once. */
  const confirmedGuards = useRef<Set<SendGuardKind>>(new Set())
  /** Re-entrancy fence over the whole attempt — the guard reads are
   * async, and the modal dialog alone cannot stop a second Send. */
  const sendAttemptActive = useRef(false)

  /** The guard conditions the live draft meets, minus the account's
   * suppressed ones (the prompt checkboxes). A settings read failure
   * keeps every condition active — fail toward asking. */
  const collectGuards = useCallback(async (): Promise<SendGuardKind[]> => {
    const state = useComposerStore.getState()
    const conditions = evaluateSendGuards({
      html: state.html,
      subject: state.subject,
      hasAttachments: state.attachments.some(
        (attachment) => getAttachmentBytes(attachment.id) !== undefined
      ),
    })
    if (conditions.length === 0 || !accountId) return conditions
    try {
      const [attachmentSuppressed, emptySubjectSuppressed] = await Promise.all([
        getAttachmentGuardSuppressed(executor, accountId),
        getEmptySubjectGuardSuppressed(executor, accountId),
      ])
      return conditions.filter((kind) =>
        kind === "attachment" ? !attachmentSuppressed : !emptySubjectSuppressed
      )
    } catch (error) {
      console.warn("[composer] guard preferences unavailable; asking", error)
      return conditions
    }
  }, [accountId, executor])

  /** Persist a prompt's "Don't ask again" choice. Fire-and-forget: a
   * failed write must not block the send it was answered for. */
  const persistGuardSuppression = (kind: SendGuardKind): void => {
    if (!accountId) return
    const write =
      kind === "attachment"
        ? setAttachmentGuardSuppressedPreference(executor, accountId, true)
        : setEmptySubjectGuardSuppressedPreference(executor, accountId, true)
    write.catch((error) => {
      console.warn("[composer] failed to persist guard suppression", error)
    })
  }

  // ---- Send (task 8.7) ----

  const [sending, setSending] = useState(false)
  /** Sanitized send-flow failure, shown above the footer with a Retry. */
  const [sendError, setSendError] = useState<string | null>(null)

  // ---- Send & Archive (batch C2) ----

  /** The thread the split button's "Send & Archive" archives after the
   * send completes — present only for reply/forward drafts bound to a
   * thread (the composer-store mode carries it). */
  const sourceThreadId =
    mode.kind === "reply" || mode.kind === "forward"
      ? mode.sourceThreadId
      : undefined

  /**
   * Whether the CURRENT attempt is a Send & Archive: set by the split
   * button's menu entry, consumed when performSend builds the send args
   * (the flag rides the frozen undo-window args too, so the archive lands
   * exactly when the send does — after the window expires — or never, on
   * cancel/failure; see sendComposerDraft's archiveSourceThreadId). A
   * plain Send click resets it, so a dismissed guard attempt cannot leak
   * the archive intent into the next send. A REF deliberately: the menu
   * click and the attempt's async pipeline span renders, and a state
   * setter would not be visible to the closure that builds the args.
   */
  const archiveOnSendRef = useRef(false)

  /** Shared attempt entry: plain Send (click and Cmd/Ctrl+Enter) and the
   * Send & Archive menu both land here, running the identical guard → PGP
   * → send pipeline; only the archive flag differs. */
  const startSendAttempt = (archive: boolean) => {
    archiveOnSendRef.current = archive
    handleSend()
  }


  // ---- PGP send (task 18.5) ----

  const pgpSign = useComposerStore((state) => state.pgpSign)
  const pgpEncrypt = useComposerStore((state) => state.pgpEncrypt)
  const togglePgpSign = useComposerStore((state) => state.togglePgpSign)
  const togglePgpEncrypt = useComposerStore((state) => state.togglePgpEncrypt)

  /** The signing passphrase, per composer mount and memory-only: asked
   * once per session (the send-time dialog), reused by the Retry button,
   * and carried into the frozen undo-window args. NEVER persisted — not
   * in the store, not in drafts, not anywhere on disk. */
  const pgpPassphraseRef = useRef<string | null>(null)
  /** Recipients the missing-key guard blocked (null = no dialog). */
  const [pgpMissingKeys, setPgpMissingKeys] = useState<string[] | null>(null)
  /** The open passphrase prompt; holds the promise's resolve. */
  const [passphraseRequest, setPassphraseRequest] = useState<{
    resolve: (passphrase: string | null) => void
  } | null>(null)
  const [passphraseValue, setPassphraseValue] = useState("")

  /** The send-time passphrase dialog as a promise: the attempt awaits it,
   * the dialog resolves with the typed value or null (cancelled). */
  const requestPgpPassphrase = (): Promise<string | null> =>
    new Promise((resolve) => {
      setPassphraseValue("")
      setPassphraseRequest({ resolve })
    })

  // Body HTML mirrors the editor (synced onUpdate); subject/recipients are
  // subscribed above.
  const html = useComposerStore((state) => state.html)

  const recipients = [...to, ...cc, ...bcc]
  const canSend =
    accountId !== null &&
    recipients.length > 0 &&
    !hasInvalidRecipient(recipients) &&
    (subject.trim() !== "" || html.trim() !== "")

  /** The unguarded send (task 8.7 + undo send, design D3): flush, then
   * the per-account pre-send window or the immediate send. Runs once the
   * attempt's guards and PGP prompts are all answered — performSend is
   * also the Retry path, which re-runs only the send, never the prompts
   * (the cached passphrase ref covers a signed retry). */
  const performSend = () => {
    if (sending || !accountId || !draftKey) return
    setSending(true)
    void (async () => {
      try {
        // Flush pending keystrokes first: it aligns the autosave baseline
        // with the last observed snapshot, so the unmount flush after
        // reset() cannot resurrect the row the send just deleted.
        await flush()
        // Task 18.5: the PGP options read as the toggles stand NOW — the
        // passphrase comes from the ref the attempt flow filled (absent
        // key stays absent, so plain sends keep their exact old shape).
        const state = useComposerStore.getState()
        const sendArgs = {
          accountId,
          payload: getComposerPayload(),
          draftKey,
          mode,
          // Task 16.2: the From-picker alias — the send service keeps the
          // envelope on the account and shapes the From header with this.
          fromAlias: state.fromAlias,
          // Batch C2 Send & Archive: the send service archives this thread
          // after the send commits — on the immediate path right after
          // enqueue, on the undo path after the window expires (the flag
          // rides these frozen args). Never on failure or cancel.
          ...(archiveOnSendRef.current && sourceThreadId
            ? { archiveSourceThreadId: sourceThreadId }
            : {}),
          ...(state.pgpSign || state.pgpEncrypt
            ? {
                pgp: {
                  mode:
                    state.pgpSign && state.pgpEncrypt
                      ? ("sign+encrypt" as const)
                      : state.pgpSign
                        ? ("sign" as const)
                        : ("encrypt" as const),
                  ...(pgpPassphraseRef.current !== null
                    ? { passphrase: pgpPassphraseRef.current }
                    : {}),
                },
              }
            : {}),
        }
        // Undo send (design D3, tasks 5.1/5.2): a positive per-account
        // delay starts the pre-send window — nothing is transmitted or
        // queued until it expires, and the store owns the countdown and
        // the cancel/restore from here (the banner is shell-level).
        const delaySeconds = await getSendDelaySeconds(executor, accountId)
        if (delaySeconds > 0) {
          const snapshot = useComposerStore.getState()
          useComposerStore.getState().beginUndoWindow({
            delaySeconds,
            sendArgs,
            snapshot: {
              accountId,
              mode,
              draftKey,
              to: [...snapshot.to],
              cc: [...snapshot.cc],
              bcc: [...snapshot.bcc],
              showCc: snapshot.showCc,
              showBcc: snapshot.showBcc,
              subject: snapshot.subject,
              html: snapshot.html,
              attachments: [...snapshot.attachments],
              fromAlias: snapshot.fromAlias,
              pgpSign: snapshot.pgpSign,
              pgpEncrypt: snapshot.pgpEncrypt,
              signatureSelection: snapshot.signatureSelection,
            },
          })
          return
        }
        const result = await sendComposerDraft(sendArgs)
        if (result.status === "queued") {
          if (result.queuedOffline) {
            toast.info("Message queued")
          } else {
            toast.success("Message sent")
          }
          reset()
          // sendComposerDraft already deleted the draft row; this sweep
          // also removes snapshots the autosave poll had not observed yet.
          await deleteDraftByKey(executor, accountId, draftKey)
          refreshMailboxCaches()
        } else {
          setSendError(result.error)
        }
      } catch (error) {
        // Typed validation errors and local write failures keep the
        // composer open with its content.
        setSendError(error instanceof Error ? error.message : String(error))
      } finally {
        setSending(false)
      }
    })()
  }

  /** The attempt's PGP stage (task 18.5), run after the send guards are
   * answered and before performSend: encryption is checked against the
   * stored public keys (blocking dialog that names the recipients without
   * one) and signing needs the default private key plus a per-use
   * passphrase (send-time dialog, kept memory-only in the ref). Cancels
   * and "keep editing" abort the attempt; everything else lands in
   * performSend. */
  const continueAttempt = async (): Promise<void> => {
    // Only handleSend's guarded path starts an attempt (accountId is
    // non-null there); the guard re-states it for this closure so the
    // PGP lookups below take a string.
    if (!accountId) return
    try {
      const state = useComposerStore.getState()
      if (state.pgpEncrypt) {
        const missing = await resolveMissingPgpRecipients(
          executor,
          accountId,
          recipients.map((recipient) => recipient.email)
        )
        if (missing.length > 0) {
          // The dialog takes over the attempt (the fence stays up until
          // its answer below).
          setPgpMissingKeys(missing)
          return
        }
      }
      if (state.pgpSign) {
        const defaultKey = await getDefaultPrivateKey(executor, accountId)
        if (!defaultKey) {
          sendAttemptActive.current = false
          setSendError(
            "Add a PGP private key for this account before signing messages"
          )
          return
        }
        if (pgpPassphraseRef.current === null) {
          const passphrase = await requestPgpPassphrase()
          if (passphrase === null) {
            // Cancelled: abort the attempt, keep the draft.
            sendAttemptActive.current = false
            return
          }
          pgpPassphraseRef.current = passphrase
        }
      }
      sendAttemptActive.current = false
      performSend()
    } catch (error) {
      sendAttemptActive.current = false
      setSendError(error instanceof Error ? error.message : String(error))
    }
  }

  /** "Disable encryption and send" (the spec's missing-key offer): drop
   * the toggle for this draft and continue the attempt (the signing
   * passphrase prompt may still follow). */
  const handlePgpDisableEncryption = () => {
    setPgpMissingKeys(null)
    useComposerStore.getState().togglePgpEncrypt()
    void continueAttempt()
  }

  /** "Keep editing" / Esc on the missing-key dialog: abort the attempt. */
  const handlePgpMissingDismiss = () => {
    setPgpMissingKeys(null)
    sendAttemptActive.current = false
    confirmedGuards.current.clear()
  }

  const handlePassphraseSubmit = () => {
    const request = passphraseRequest
    setPassphraseRequest(null)
    request?.resolve(passphraseValue)
  }

  const handlePassphraseCancel = () => {
    const request = passphraseRequest
    setPassphraseRequest(null)
    request?.resolve(null)
  }

  /** Guarded Send entry point (task 5.3): the attempt's prompts, if any,
   * run to completion BEFORE performSend — each at most once per attempt,
   * skipping the account's suppressed ones; the PGP stage (task 18.5)
   * follows them. */
  const handleSend = () => {
    if (
      sending ||
      sendAttemptActive.current ||
      !accountId ||
      !draftKey ||
      !canSend
    ) {
      return
    }
    sendAttemptActive.current = true
    setSendError(null)
    void (async () => {
      try {
        const pending = (await collectGuards()).filter(
          (kind) => !confirmedGuards.current.has(kind)
        )
        if (pending.length > 0) {
          setGuardQueue(pending)
          return
        }
        await continueAttempt()
      } catch (error) {
        sendAttemptActive.current = false
        setSendError(error instanceof Error ? error.message : String(error))
      }
    })()
  }

  /** "Send anyway": satisfy the guard for this attempt, then prompt the
   * next queued guard (if any) or continue into the PGP stage / send. */
  const handleGuardConfirm = (kind: SendGuardKind, suppress: boolean) => {
    confirmedGuards.current.add(kind)
    if (suppress) persistGuardSuppression(kind)
    const rest = guardQueue.filter((pending) => pending !== kind)
    setGuardQueue(rest)
    if (rest.length === 0) {
      // The attempt fence stays up until continueAttempt resolves it.
      void continueAttempt()
    }
  }

  /** The fix affordance ("Attach a file" / "Add a subject"): abort the
   * attempt, close the prompts and hand control back — opening the file
   * picker or focusing the subject, so the user can attach/add it before
   * the next Send. Guards may fire again on that next attempt. */
  const handleGuardGoBack = (kind: SendGuardKind, suppress: boolean) => {
    if (suppress) persistGuardSuppression(kind)
    sendAttemptActive.current = false
    setGuardQueue([])
    confirmedGuards.current.clear()
    if (kind === "attachment") {
      handleAttachClick()
    } else {
      // Deferred so the focus lands AFTER the dialog's own close-handling
      // restores focus to where it was when the prompt opened.
      window.setTimeout(() => {
        document.getElementById("composer-subject")?.focus()
      }, 0)
    }
  }

  /** Esc/overlay dismissal: abort the attempt, keep every guard for the
   * next Send click. */
  const handleGuardDismiss = () => {
    sendAttemptActive.current = false
    setGuardQueue([])
    confirmedGuards.current.clear()
  }

  // ---- Schedule send (task 10.1) ----

  /**
   * Schedule the composed message for `dueAt`: the same flush-first
   * discipline as Send, then the shared schedule flow (validates like
   * Send, stores the BUILT MIME in scheduled_sends, removes the draft).
   * Success closes the composer with a toast; a failure keeps it open
   * with the sanitized error, like a failed send.
   */
  const handleSchedule = (dueAt: number) => {
    if (sending || !accountId || !draftKey || !canSend) return
    // Task 18.5: the schedule flow stores the PLAINTEXT built MIME by
    // design (edited and re-dated later), so a signed/encrypted draft
    // must not go through it — refused with the usual inline error.
    if (
      useComposerStore.getState().pgpSign ||
      useComposerStore.getState().pgpEncrypt
    ) {
      setSendError(
        "Scheduled sends don't support PGP yet — disable Sign/Encrypt or send directly"
      )
      return
    }
    setSending(true)
    setSendError(null)
    void (async () => {
      try {
        // Same autosave-baseline alignment as handleSend: the unmount
        // flush after reset() cannot resurrect the deleted draft row.
        await flush()
        const result = await scheduleComposerSend({
          accountId,
          payload: getComposerPayload(),
          mode,
          draftKey,
          dueAt,
        })
        if (result.status === "scheduled") {
          toast.success(`Scheduled for ${formatSnoozedUntil(dueAt)}`)
          reset()
          // scheduleComposerSend already deleted the draft row; this
          // sweep also removes snapshots the autosave poll had not
          // observed yet (same double-sweep as handleSend).
          await deleteDraftByKey(executor, accountId, draftKey)
          refreshMailboxCaches()
        } else {
          setSendError(result.error)
        }
      } catch (error) {
        setSendError(error instanceof Error ? error.message : String(error))
      } finally {
        setSending(false)
      }
    })()
  }

  // ---- Discard (task 8.6 confirmation) ----

  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const discardDraft = () => {
    void (async () => {
      // flush() (not saveNow) writes exactly the last observed snapshot,
      // re-aligning the autosave baseline so the unmount flush that fires
      // on reset() is a no-op and cannot re-insert the row deleted below.
      await flush()
      if (accountId && draftKey) {
        await deleteDraftByKey(executor, accountId, draftKey)
      }
      reset()
      refreshMailboxCaches()
    })()
  }

  const handleDiscard = () => {
    // Spec: discarding a non-empty draft requires confirmation; an empty
    // one goes immediately.
    if (isDraftEmpty(getDraftInput())) {
      discardDraft()
      return
    }
    setConfirmDiscard(true)
  }

  // ---- Close keeping the draft ----

  /**
   * The third way out of the composer beside Send and Discard: dismiss
   * the window while KEEPING the draft. saveNow() writes the CURRENT
   * snapshot to the `local_drafts` row (flush() would only rewrite the
   * last poll-observed one, missing edits newer than a poll tick) and the
   * Drafts folder lists the row; clicking it resumes via resumeDraft.
   * close() then drops only the open flag — deliberately keeping every
   * field, unlike reset().
   */
  const handleCloseKeepDraft = () => {
    void saveNow().finally(() => close())
  }

  /** Minimize to the shell's tray chip (the Esc binding): the overlay
   * hides, `open` stays true so autosave, the shortcut gates and any
   * in-flight undo window continue untouched. */
  const handleMinimize = () => {
    useComposerStore.getState().minimize()
  }

  /** Leave the minimized state and put focus back into the draft — the
   * tray chip's body and the `c` binding while minimized (restores the
   * surface instead of stacking a new compose over it). */
  const handleRestoreAndFocus = () => {
    useComposerStore.getState().restore()
    window.setTimeout(() => {
      toInputRef.current?.focus()
    }, 0)
  }

  // ---- Composer-scoped keyboard (batch C1, fix 2; batch C2 semantics) ----

  // The global shortcut hook fires these for Cmd/Ctrl+Enter ("send-
  // message") and Esc ("dismiss"/"close-composer") while the composer is
  // open. Esc now MINIMIZES (the draft stays open behind the shell's tray
  // chip; autosave keeps running) — only the close (X) button runs the
  // saveNow + close flow, which the tray chip's × also consults while the
  // overlay is hidden. Re-registered every render with fresh closures; the
  // registration dies with the view (composer closed).
  useEffect(() => {
    setComposerKeyActions({
      send: () => startSendAttempt(false),
      minimize: handleMinimize,
      restore: handleRestoreAndFocus,
      keepDraftAndClose: handleCloseKeepDraft,
    })
    return () => setComposerKeyActions(null)
  })


  // ---- Pop out to its own window (batch C2, Tauri only) ----

  /** Whether this surface offers the pop-out button: only under the Tauri
   * runtime (the JS WebviewWindow API is absent in the browser/mock mode —
   * the button hides gracefully) and never inside a composer pop-out
   * window itself. */
  const showPopOutButton = isTauriRuntime() && !isComposerPopoutWindow()

  const [poppingOut, setPoppingOut] = useState(false)

  /**
   * The state transfer is the DATABASE, not the URL: saveNow() persists
   * the CURRENT snapshot (recipients, subject, body — inline images in the
   * HTML included) and the C1 draft-attachment sync has already mirrored
   * the attachment bytes; the new window's label carries ONLY the draft
   * key, and composer-popout resumes the full draft from local_drafts
   * through the one resume path. The overlay closes only after the window
   * exists, so a failed creation leaves the composer untouched.
   */
  const handlePopOut = () => {
    if (poppingOut || !draftKey) return
    setPoppingOut(true)
    void (async () => {
      try {
        await saveNow()
        await openComposerPopout(draftKey)
        close()
      } catch (error) {
        console.warn("[composer] pop-out failed", error)
      } finally {
        setPoppingOut(false)
      }
    })()
  }

  // ---- Attachments (task 8.5) ----

  /** Depth counter for dragenter/dragleave — child elements fire leave
   * events while still inside the composer surface. */
  const dragDepth = useRef(0)
  const [dragActive, setDragActive] = useState(false)
  /** First cap/read rejection of the last add — cleared by the next one. */
  const [attachmentError, setAttachmentError] = useState<string | null>(null)

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    // preventDefault is what marks the surface as a drop target.
    event.preventDefault()
  }

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }

  /**
   * Route an incoming file batch (batch C2): inline-able images (2 MB
   * cap) go INTO the body at the cursor as data-URL <img> elements;
   * everything else — non-image files AND images over the cap — keeps the
   * regular attachment pipeline, with a toast explaining the reroute so
   * an over-cap image never silently lands in the wrong place.
   */
  const processIncomingFiles = (files: File[]) => {
    if (files.length === 0) return
    const { inline, attach } = partitionImageFiles(files)
    if (attach.length > 0) {
      void addFileAttachments(attach).then((result) =>
        setAttachmentError(result.error ?? null)
      )
      const overCapImage = attach.find((file) =>
        file.type.toLowerCase().startsWith("image/")
      )
      if (overCapImage) toast.info(inlineImageTooLargeMessage(overCapImage.name))
    }
    if (inline.length === 0 || !editor || editor.isDestroyed) return
    void (async () => {
      for (const file of inline) {
        try {
          insertInlineImage(editor, await fileToDataUrl(file))
        } catch (error) {
          console.warn("[composer] inline image insert failed", error)
        }
      }
    })()
  }

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    // Image files were already intercepted editor-side (editorProps
    // handleDrop) so ProseMirror's default file insertion cannot double-
    // insert them; whatever reaches here routes through the partition.
    processIncomingFiles(Array.from(event.dataTransfer.files))
  }

  const handleAttachClick = () => {
    void pickAttachments().then((result) =>
      setAttachmentError(result.error ?? null)
    )
  }

  // ---- Inline images: toolbar picker (batch C2) ----

  /** The toolbar's image button: system picker filtered to images, each
   * pick inserted at the cursor as a data-URL <img>. Picks over the 2 MB
   * inline cap route to the attachment pipeline with the same explainer
   * toast the paste/drop reroutes use. */
  const handlePickInlineImage = () => {
    if (!editor || editor.isDestroyed) return
    void pickInlineImages().then(({ picked, tooLarge }) => {
      if (tooLarge.length > 0) {
        toast.info(inlineImageTooLargeMessage(tooLarge[0].name))
        void addFileAttachments(
          tooLarge.map(
            ({ name, bytes }) => new File([new Uint8Array(bytes)], name)
          )
        ).then((result) => setAttachmentError(result.error ?? null))
      }
      for (const image of picked) {
        insertInlineImage(editor, image.dataUrl)
      }
    })
  }

  useEffect(() => {
    // Spec: a new compose opens with focus in the To field. Reply/forward
    // (8.4) pre-address the message, so body focus is their call.
    if (mode.kind === "new") {
      toInputRef.current?.focus()
    }
  }, [mode])

  // ---- Snippets (task 6.2) ----

  // Loaded once per open; the same rows feed the toolbar picker (state)
  // and the keyboard expansion (the shared lookup map the extension reads
  // per keystroke — see setSnippetShortcuts).
  const [snippets, setSnippets] = useState<SnippetRow[]>([])
  const snippetExpansion = useMemo(() => createSnippetExpansion(), [])

  useEffect(() => {
    let cancelled = false
    listSnippets(executor)
      .then((rows) => {
        if (cancelled) return
        setSnippets(rows)
        const shortcuts = new Map<string, SnippetRow>()
        for (const snippet of rows) {
          if (snippet.shortcut && !shortcuts.has(snippet.shortcut)) {
            shortcuts.set(snippet.shortcut, snippet)
          }
        }
        setSnippetShortcuts(shortcuts)
      })
      .catch((error) => {
        console.warn("[composer] failed to load snippets", error)
      })
    return () => {
      cancelled = true
    }
  }, [executor])

  // ---- Snippet variable prompt (task 2.3, design D11) ----

  /**
   * The one pending unknown-variable prompt (null = none): the unresolved
   * ids and the resolve of the promise insertSnippetBody is awaiting.
   * Component state by design — a prompt is transient UI, not draft data,
   * so it never enters composer-store. Mounting installs the callback
   * snippet-insert calls (module-level, React-free); unmounting answers
   * any open prompt with null so its insertion promise settles instead of
   * leaking.
   */
  const [snippetVariableRequest, setSnippetVariableRequest] = useState<{
    variables: string[]
    resolve: (answers: Record<string, string> | null) => void
  } | null>(null)

  useEffect(() => {
    setSnippetVariablePrompt((variables) =>
      new Promise<Record<string, string> | null>((resolve) => {
        setSnippetVariableRequest({ variables, resolve })
      })
    )
    return () => {
      setSnippetVariablePrompt(null)
      setSnippetVariableRequest((request) => {
        request?.resolve(null)
        return null
      })
    }
  }, [])

  /** Confirm: hand the answers back — one value per id, applied to all of
   * that id's occurrences — and let the insertion proceed. */
  const handleSnippetVariablesInsert = (
    answers: Record<string, string>
  ): void => {
    setSnippetVariableRequest(null)
    snippetVariableRequest?.resolve(answers)
  }

  /** Cancel: resolve null (insertSnippetBody inserts nothing). */
  const handleSnippetVariablesCancel = (): void => {
    setSnippetVariableRequest(null)
    snippetVariableRequest?.resolve(null)
  }

  const editor = useEditor({
    extensions: [
      // StarterKit v3 bundles underline + link; they are disabled here and
      // registered explicitly below (documented v3 pattern).
      StarterKit.configure({ link: false, underline: false }),
      Underline,
      LinkExtension.configure({
        // Links in mail open externally (D7); never navigate in-app.
        openOnClick: false,
      }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Placeholder.configure({ placeholder: "Write your message…" }),
      // Inline images (batch C2): inline:true keeps images flowing inside
      // a paragraph and allowBase64 lets pasted/picked files ride as data
      // URLs until the MIME build extracts them into multipart/related
      // parts. The 2 MB cap is enforced in the file handlers below — the
      // extension itself stays permissive (it also parses data-URL <img>
      // tags inside pasted rich text, which the cap intentionally does
      // not police).
      ImageExtension.configure({ inline: true, allowBase64: true }),
      EmailSignatureBlock,
      snippetExpansion,
    ],
    // Initial content only — rehydrated drafts (task 8.6) set store state
    // before this view mounts.
    content: useComposerStore.getState().html,
    editorProps: {
      attributes: {
        class: "min-h-40 outline-none",
        "aria-label": "Message body",
      },
      // Clipboard paste of image FILES (batch C2): ProseMirror would
      // otherwise insert them with no size gate — the composer's
      // partition owns the decision instead (inline at the cursor under
      // the cap, attachments with a toast above it). Handled HERE because
      // paste never reaches the section-level handlers. Rich-text pastes
      // with embedded <img> tags still flow through the extension's HTML
      // parsing untouched.
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? [])
        if (files.length === 0) return false
        event.preventDefault()
        processIncomingFiles(files)
        return true
      },
      // File drops ON the editor: suppress ProseMirror's default file
      // insertion so the section-level drop handler below stays the ONE
      // router for every drop over the composer surface (editor and
      // chrome alike). Returning true does not stop the DOM event from
      // bubbling to it. Drops without files (in-document drags, HTML)
      // keep the editor's native behavior.
      handleDrop: (_view, event) => {
        return (event.dataTransfer?.files?.length ?? 0) > 0
      },
    },
    onUpdate: ({ editor: current }) => setHtml(current.getHTML()),
  })

  /**
   * Signature selection write path (fix 3): swap the managed signature
   * block in the body — replacing a previously inserted block preserves
   * the user's text above it, "No signature" removes the block — through
   * the same placement rule the reply prefill uses ([body][signature]
   * [quote], end of body otherwise). The editor is the body's source of
   * truth: setContent syncs the store via onUpdate; without a live
   * editor (closed view edge) the store setter applies directly.
   */
  const handleSignatureSelect = (selectedAccountId: string) => {
    setSignatureSelection(selectedAccountId === "" ? null : selectedAccountId)
    const signature =
      selectedAccountId === ""
        ? undefined
        : signatureOptions.find(
            (option) => option.accountId === selectedAccountId
          )
    const currentHtml =
      editor && !editor.isDestroyed
        ? editor.getHTML()
        : useComposerStore.getState().html
    const nextHtml = insertSignatureBlock(currentHtml, signature?.html ?? "")
    if (editor && !editor.isDestroyed) {
      // setContent syncs the store via onUpdate; focus stays on the
      // selector (native select behavior) — no scroll/focus churn.
      editor.commands.setContent(nextHtml)
    } else {
      setHtml(nextHtml)
    }
  }

  // ---- Compose text transform (task 4.6, design D1) ----

  /**
   * Whether the AI affordance may appear at all: AI configured AND the
   * composeTransform surface enabled (spec: surfaces hidden when
   * unconfigured — never shown in an error state). Loaded once per mount,
   * best-effort like the other loaders: any read failure hides the menu
   * (fail toward privacy default). Re-opening the composer re-reads the
   * flags, so toggling the surface in settings takes effect on next open.
   */
  const [aiTransformAvailable, setAiTransformAvailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [configured, surfaceEnabled] = await Promise.all([
          isAiConfigured(executor),
          isSurfaceEnabled(executor, "composeTransform"),
        ])
        if (!cancelled) setAiTransformAvailable(configured && surfaceEnabled)
      } catch (error) {
        console.warn("[composer] failed to load AI availability", error)
        if (!cancelled) setAiTransformAvailable(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [executor])

  /** "Draft from prompt" dialog visibility (batch C3). Component state by
   * design — transient input UI, not draft data; the dialog resets its
   * field on every open and closing it discards the typed text. */
  const [aiPromptOpen, setAiPromptOpen] = useState(false)

  /**
   * The ONE pending replacement (null = none). Component state by design,
   * NOT composer-store: a pending offer is transient UI tied to this
   * mounted editor instance (its ranges are editor positions), not draft
   * data — it must never be autosaved, restored or shared (the same
   * reasoning as the snippet variable prompt above). `originalHtml` keeps
   * the pre-offer range content so acceptance stays undoable.
   *
   * Batch C3 generalizes the flow beyond the text transforms: every
   * generative offer — transform, prompt-drafted body, generated reply —
   * rides this ONE pending state and bar. `source` is frozen at launch so
   * Retry re-runs the SAME request (transform text/range frozen at
   * capture; the prompt / thread id frozen likewise), with `regenerate`
   * flipping the cache-bypass flag on the retry path.
   */
  type PendingOfferSource =
    | { kind: "transform"; mode: ComposeTransformMode; text: string }
    | { kind: "draftPrompt"; prompt: string }
    | { kind: "generateReply"; threadId: string }

  const [pendingTransform, setPendingTransform] = useState<{
    id: number
    source: PendingOfferSource
    range: { from: number; to: number }
    originalHtml: string
    status: "transforming" | "ready" | "error"
    resultText: string | null
    error: string | null
  } | null>(null)
  /** Correlates async completions with the pending offer they belong to —
   * a discarded offer's late response must not resurrect the bar. */
  const transformIdRef = useRef(0)

  /** The bar's display name per offer kind (transform labels are shared
   * with the toolbar menu; the generative offers carry their own). */
  const pendingOfferLabel = (source: PendingOfferSource): string => {
    if (source.kind === "transform") return COMPOSE_TRANSFORM_LABELS[source.mode]
    return source.kind === "draftPrompt" ? "Draft from prompt" : "Generated reply"
  }

  /** Send one captured target to the provider and track it as pending.
   * Errors (AiProviderError, and AiUnavailableError for a surface disabled
   * mid-session) land INLINE in the bar with Retry — never a blocking
   * dialog, the draft keeps working (spec "AI caching and failure
   * handling"). Transforms never cache (service doc: one-shot, low
   * reuse); the generative offers cache through ai_cache and pass
   * `regenerate` on retries so a retry never just re-serves the row the
   * first attempt wrote. */
  const launchOffer = (
    source: PendingOfferSource,
    target: Pick<
      NonNullable<typeof pendingTransform>,
      "range" | "originalHtml"
    >,
    regenerate: boolean
  ) => {
    const id = ++transformIdRef.current
    setPendingTransform({
      source,
      ...target,
      id,
      status: "transforming",
      resultText: null,
      error: null,
    })
    void (async () => {
      try {
        let result: string
        if (source.kind === "transform") {
          result = await transformDraftText({
            text: source.text,
            mode: source.mode,
          })
        } else if (source.kind === "draftPrompt") {
          result = (
            await generateDraftFromPrompt({
              prompt: source.prompt,
              accountId,
              regenerate,
            })
          ).text
        } else {
          result = (
            await generateReplyForThread({
              accountId: accountId ?? "",
              threadId: source.threadId,
              regenerate,
            })
          ).text
        }
        setPendingTransform((current) =>
          current?.id === id
            ? { ...current, status: "ready", resultText: result }
            : current
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setPendingTransform((current) =>
          current?.id === id
            ? { ...current, status: "error", error: message }
            : current
        )
      }
    })()
  }

  /** Menu entry (task 4.6): capture the selection (else the whole body)
   * and start the pending flow. A blank target runs nothing. */
  const runComposeTransform = (mode: ComposeTransformMode) => {
    if (!editor || editor.isDestroyed) return
    const target = captureTransformTarget(editor)
    if (!target) return
    launchOffer(
      { kind: "transform", mode, text: target.text },
      target,
      false
    )
  }

  /** Whole-body capture for the generative offers (batch C3): the range
   * spans the entire document (an empty body is legitimate — the prompt
   * draft lands in it) and the undo snapshot is the full body HTML. */
  const captureWholeBodyTarget = () => ({
    range: { from: 0, to: editor.state.doc.content.size },
    originalHtml: editor.getHTML(),
  })

  /** "Draft from prompt" entry (batch C3): the dialog handed over the
   * trimmed instruction; the generated body is offered whole-body. */
  const runDraftFromPrompt = (prompt: string) => {
    if (!editor || editor.isDestroyed) return
    launchOffer({ kind: "draftPrompt", prompt }, captureWholeBodyTarget(), false)
  }

  /** "Generate reply" entry (batch C3): a full reply draft generated from
   * the source thread, offered over the whole body (Accept replaces it). */
  const runGenerateReply = () => {
    if (!editor || editor.isDestroyed) return
    if (!sourceThreadId) return
    launchOffer(
      { kind: "generateReply", threadId: sourceThreadId },
      captureWholeBodyTarget(),
      false
    )
  }

  /** Retry: re-run the SAME request (source and range frozen at launch —
   * recapturing would silently target different content), bypassing the
   * ai_cache row a first generative run wrote. */
  const retryComposeTransform = () => {
    if (!pendingTransform) return
    launchOffer(
      pendingTransform.source,
      { range: pendingTransform.range, originalHtml: pendingTransform.originalHtml },
      true
    )
  }

  /**
   * Accept (spec: "shown as a pending replacement the user explicitly
   * accepts"): splice the offered text in — the FIRST point any draft
   * content changes. Transforms replace the captured range; the
   * generative offers replace the WHOLE body as it stands at accept time
   * (the draft stays editable while generating, so the launch-time range
   * could be stale). Then clear the bar and offer a grace-period Undo
   * toast (the explicit affordance for the spec's "the action SHALL be
   * undoable"; the editor's native Cmd/Ctrl+Z undo covers the same
   * replacement — insertContentAt is a regular transaction in the
   * history stack).
   */
  const acceptComposeTransform = () => {
    const pending = pendingTransform
    if (!pending || pending.resultText === null) return
    if (!editor || editor.isDestroyed) {
      setPendingTransform(null)
      return
    }
    const range =
      pending.source.kind === "transform"
        ? pending.range
        : { from: 0, to: editor.state.doc.content.size }
    const undo = replaceDraftRange(
      editor,
      range,
      transformedTextToHtml(pending.resultText)
    )
    setPendingTransform(null)
    if (!undo) return
    toast.success(`${pendingOfferLabel(pending.source)} applied`, {
      description: "The original text was replaced.",
      duration: 10000,
      action: {
        label: "Undo",
        onClick: () => {
          // Puts the captured original back over the replaced extent.
          // Edits made elsewhere after accepting shift positions; the
          // native editor undo remains the exact-granularity path.
          if (editor && !editor.isDestroyed) {
            replaceDraftRange(editor, undo.range, pending.originalHtml)
          }
        },
      },
    })
  }

  /** Discard (spec: the explicit alternative): drop the offer. The
   * original text was never touched — it is only replaced on Accept. */
  const discardComposeTransform = () => {
    setPendingTransform(null)
  }

  // Cc/Bcc rows auto-reveal when a reply-all pre-fills them (task 8.4).
  const ccVisible = showCc || cc.length > 0
  const bccVisible = showBcc || bcc.length > 0

  // Composer surface size (batch C2): the shell renders the overlay
  // container differently per mode; the header's toggle just flips it.
  const composerMode = useUiStore((state) => state.composerMode)
  const setComposerMode = useUiStore((state) => state.setComposerMode)

  return (
    <TooltipProvider delay={0}>
      <section
        aria-label={
          mode.kind === "reply"
            ? "Reply"
            : mode.kind === "forward"
              ? "Forward"
              : "New message"
        }
        // The keyboard layer's composer gate matches focus by this marker
        // (use-keyboard-shortcuts.ts): with the centered card non-modal,
        // "the composer owns the keys" means "focus is inside this
        // surface", not merely "a composer is open".
        data-testid="composer-surface"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex h-full min-h-96 flex-col bg-background ${
          dragActive ? "bg-primary/5 ring-2 ring-primary ring-inset" : ""
        }`}
      >
        {/* The header strip doubles as the centered card's drag handle —
            mail-shell's CenteredComposerCard starts a drag only when the
            pointer lands inside this row and not on a button. */}
        <div
          data-composer-drag-handle
          className="flex cursor-grab select-none items-center justify-between px-4 pt-3 active:cursor-grabbing"
        >
          <span className="text-sm font-medium text-muted-foreground">
            {mode.kind === "reply"
              ? "Reply"
              : mode.kind === "forward"
                ? "Forward"
                : "New message"}
          </span>
          <div className="flex items-center gap-0.5">
            {/* Size toggle (batch C2): collapse the full surface to the
                centered card and back. The mode lives in ui-store and is
                persisted through the preferences service (fire-and-forget —
                a failed settings write must not block the flip; the store
                push in setComposerModePreference re-applies the same value,
                so the double-set is harmless). */}
            <Button
              variant="ghost"
              size="icon"
              aria-label={
                composerMode === "centered"
                  ? "Expand composer"
                  : "Collapse composer"
              }
              title={
                composerMode === "centered"
                  ? "Expand to full window"
                  : "Shrink to centered card"
              }
              data-testid="composer-size-toggle"
              onClick={() => {
                const next =
                  composerMode === "centered" ? "full" : "centered"
                setComposerMode(next)
                try {
                  void setComposerModePreference(getExecutor(), next).catch(
                    () => {
                      /* non-Tauri runtime or db hiccup — store already set */
                    }
                  )
                } catch {
                  /* getExecutor() unavailable (unit tests) — store set above */
                }
              }}
            >
              {composerMode === "centered" ? (
                <Maximize2 aria-hidden />
              ) : (
                <Minimize2 aria-hidden />
              )}
            </Button>
            {/* Pop out to its own window (batch C2): Tauri only — the
                button hides gracefully in the browser/mock mode and inside
                the pop-out surface itself. */}
            {showPopOutButton ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Pop out composer"
                title="Open in its own window"
                disabled={poppingOut}
                data-testid="composer-pop-out"
                onClick={handlePopOut}
              >
                <ExternalLink aria-hidden />
              </Button>
            ) : null}
            {/* Minimize (batch C2): hides the overlay behind the shell's
                tray chip, keeping the draft — the Esc binding's flow. */}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Minimize composer"
              title={`Minimize to tray${keysHint("close-composer")}`}
              data-testid="composer-minimize"
              onClick={handleMinimize}
            >
              <Minus aria-hidden />
            </Button>
            {/* Dismiss keeping the draft — the autosaved local_drafts row
                stays addressable from the Drafts folder (resume on click).
                Esc used to run this same path; since batch C2 it minimizes
                instead, so the save-and-close flow is pointer-only. */}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close and save draft"
              title="Save draft and close"
              onClick={handleCloseKeepDraft}
            >
              <X aria-hidden />
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2 px-4 pt-2">
          {/* From picker (task 16.2): rendered only when the account has
              send-as aliases; option value "" is the bare identity. */}
          {aliases.length > 0 ? (
            <div className="flex items-center gap-3">
              <Label
                htmlFor="composer-from"
                className="w-14 shrink-0 text-muted-foreground"
              >
                From
              </Label>
              <select
                id="composer-from"
                aria-label="From address"
                value={fromAlias?.email ?? ""}
                onChange={(event) => {
                  const email = event.target.value
                  if (email === "") {
                    setFromAlias(null)
                    return
                  }
                  const alias = aliases.find(
                    (candidate) => candidate.email === email
                  )
                  setFromAlias(alias ? toFromAliasSelection(alias) : null)
                }}
                className="h-7 max-w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">
                  {composerAccount
                    ? composerAccount.displayName
                      ? `${composerAccount.displayName} <${composerAccount.email}>`
                      : composerAccount.email
                    : "Account address"}
                </option>
                {aliases.map((alias) => (
                  <option key={alias.id} value={alias.email}>
                    {alias.display_name
                      ? `${alias.display_name} <${alias.email}>`
                      : alias.email}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <Label
              htmlFor="composer-to"
              className="w-14 shrink-0 text-muted-foreground"
            >
              To
            </Label>
            <RecipientField
              id="composer-to"
              recipients={to}
              onChange={setTo}
              placeholder="name@example.com"
              inputRef={toInputRef}
              accountId={accountId}
            />
            <div className="flex shrink-0 gap-0.5">
              <Button
                variant="ghost"
                size="xs"
                aria-expanded={ccVisible}
                onClick={toggleCc}
              >
                Cc
              </Button>
              <Button
                variant="ghost"
                size="xs"
                aria-expanded={bccVisible}
                onClick={toggleBcc}
              >
                Bcc
              </Button>
            </div>
          </div>

          {ccVisible ? (
            <div className="flex items-center gap-3">
              <Label
                htmlFor="composer-cc"
                className="w-14 shrink-0 text-muted-foreground"
              >
                Cc
              </Label>
              <RecipientField
                id="composer-cc"
                recipients={cc}
                onChange={setCc}
                placeholder="name@example.com"
                accountId={accountId}
              />
            </div>
          ) : null}

          {bccVisible ? (
            <div className="flex items-center gap-3">
              <Label
                htmlFor="composer-bcc"
                className="w-14 shrink-0 text-muted-foreground"
              >
                Bcc
              </Label>
              <RecipientField
                id="composer-bcc"
                recipients={bcc}
                onChange={setBcc}
                placeholder="name@example.com"
                accountId={accountId}
              />
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <Label
              htmlFor="composer-subject"
              className="w-14 shrink-0 text-muted-foreground"
            >
              Subject
            </Label>
            <Input
              id="composer-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Subject"
              autoComplete="off"
              className="border-0 bg-transparent px-0 focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
        </div>

        <Separator className="mt-3" />
        <ComposerToolbar
          editor={editor}
          snippets={snippets}
          pgpSign={pgpSign}
          pgpEncrypt={pgpEncrypt}
          onTogglePgpSign={togglePgpSign}
          onTogglePgpEncrypt={togglePgpEncrypt}
          aiTransformAvailable={aiTransformAvailable}
          composeTransformPending={pendingTransform !== null}
          onComposeTransform={runComposeTransform}
          aiModeKind={mode.kind}
          generateReplyThreadId={sourceThreadId ?? null}
          onDraftFromPrompt={() => setAiPromptOpen(true)}
          onGenerateReply={runGenerateReply}
          onInsertImage={handlePickInlineImage}
        />
        <Separator />

        {/* Composer AI offers (task 4.6 + batch C3): the pending-replacement
            bar — <label> transforming… / Accept-Discard / error+Retry — one
            offer at a time, transforms and generative drafts alike. The
            draft below stays editable the whole time. */}
        {pendingTransform ? (
          <ComposeTransformBar
            label={pendingOfferLabel(pendingTransform.source)}
            status={pendingTransform.status}
            error={pendingTransform.error}
            onAccept={acceptComposeTransform}
            onDiscard={discardComposeTransform}
            onRetry={retryComposeTransform}
          />
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">
          <div className={EDITOR_CONTENT_CLASS}>
            <EditorContent editor={editor} />
          </div>
        </div>

        {/* Attachment strip + inline cap/read errors (task 8.5). */}
        <AttachmentStrip />
        {/* Draft notice (batch C3 send-again): a dismissible info line for
            ways this draft visibly differs from its prefill source — the
            send-again opener sets it when original attachments could not
            be restored. Transient store state, cleared with the draft. */}
        {attachmentNotice ? (
          <div
            data-testid="composer-attachment-notice"
            role="status"
            className="flex items-center justify-between gap-2 px-4 pb-2 text-xs text-muted-foreground"
          >
            <span className="min-w-0">{attachmentNotice}</span>
            <Button
              variant="ghost"
              size="xs"
              data-testid="composer-attachment-notice-dismiss"
              onClick={() => setAttachmentNotice(null)}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
        {attachmentError ? (
          <p role="alert" className="px-4 pb-2 text-xs text-destructive">
            {attachmentError}
          </p>
        ) : null}

        {/* Send-flow failure (task 8.7): sanitized error + Retry; the
            composer stays open with its content. */}
        {sendError ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 px-4 pb-2 text-xs text-destructive"
          >
            <span className="min-w-0 truncate">{sendError}</span>
            {/* Retry re-runs only the send (performSend): the attempt's
                guards were already answered before it failed. */}
            <Button variant="outline" size="xs" onClick={performSend}>
              Retry
            </Button>
          </div>
        ) : null}

        <Separator />
        <footer className="flex items-center gap-2 px-4 py-3">
          {/* Per-message signature (fix 3): "No signature" plus one
              option per account signature; hidden entirely when no
              account has one to offer. */}
          {signatureOptions.length > 0 ? (
            <select
              aria-label="Signature"
              title="Signature"
              value={signatureSelection ?? ""}
              onChange={(event) => handleSignatureSelect(event.target.value)}
              className="h-7 max-w-48 shrink-0 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">No signature</option>
              {signatureOptions.map((option) => (
                <option key={option.accountId} value={option.accountId}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : null}
          <Button
            variant="ghost"
            className="me-auto"
            onClick={handleAttachClick}
          >
            <Paperclip aria-hidden />
            Attach file
          </Button>
          <Button variant="outline" onClick={handleDiscard}>
            Discard
          </Button>
          {/* Schedule send (task 10.1): the send-later picker beside Send;
              enabled on the same sendable gate. */}
          <ScheduleSendMenu
            disabled={!canSend || sending}
            onSchedule={handleSchedule}
          />
          {/* Send split button (batch C2): the primary Send is unchanged;
              a reply/forward bound to a thread gains a chevron menu whose
              "Send & Archive" runs the identical flow and archives the
              source thread when the send completes. */}
          <div className="flex items-stretch">
            <Button
              disabled={!canSend || sending}
              onClick={() => startSendAttempt(false)}
              title={`Send${keysHint("send-message")}`}
              className={sourceThreadId ? "rounded-e-none" : undefined}
            >
              {sending ? "Sending…" : "Send"}
            </Button>
            {sourceThreadId ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      disabled={!canSend || sending}
                      aria-label="More send options"
                      title="More send options"
                      data-testid="send-options"
                      className="rounded-s-none border-s border-s-border px-1.5"
                    >
                      <ChevronDown aria-hidden />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" data-testid="send-options-menu">
                  <DropdownMenuItem
                    data-testid="send-and-archive"
                    onClick={() => startSendAttempt(true)}
                  >
                    Send &amp; Archive
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </footer>

        {/* Send guards (task 5.3): the attachment reminder and the
            empty-subject confirmation, one open at a time. */}
        <SendGuardDialogs
          guard={activeGuard}
          onConfirm={handleGuardConfirm}
          onGoBack={handleGuardGoBack}
          onDismiss={handleGuardDismiss}
        />

        {/* Missing-key guard (task 18.5, mail-security spec): the send is
            BLOCKED naming the recipients without a known public key, with
            the spec's "disable encryption instead" offer. */}
        <Dialog
          open={pgpMissingKeys !== null}
          onOpenChange={(open) => {
            if (!open) handlePgpMissingDismiss()
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Missing encryption keys</DialogTitle>
              <DialogDescription>
                No PGP public key is known for: {pgpMissingKeys?.join(", ")}.
                Import their keys in settings, remove the recipients, or send
                without encryption.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={handlePgpMissingDismiss}>
                Keep editing
              </Button>
              <Button onClick={handlePgpDisableEncryption}>
                Disable encryption and send
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Send-time passphrase prompt (task 18.5): unlocks the account's
            default private key for signing; the value lives only in this
            component until the send args are built. */}
        <Dialog
          open={passphraseRequest !== null}
          onOpenChange={(open) => {
            if (!open) handlePassphraseCancel()
          }}
        >
          <DialogContent>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                handlePassphraseSubmit()
              }}
            >
              <DialogHeader>
                <DialogTitle>PGP passphrase</DialogTitle>
                <DialogDescription>
                  Enter the passphrase of your signing key to sign this message.
                </DialogDescription>
              </DialogHeader>
              <Input
                type="password"
                value={passphraseValue}
                onChange={(event) => setPassphraseValue(event.target.value)}
                aria-label="PGP passphrase"
                autoComplete="off"
                autoFocus
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handlePassphraseCancel}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={passphraseValue === ""}>
                  Sign and send
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Snippet variable prompt (task 2.3, design D11): one dialog per
            insertion listing every id without a context value; the answers
            apply to ALL occurrences of their id. Keyed by the id list so
            each prompt starts with empty fields. */}
        {snippetVariableRequest ? (
          <SnippetVariableDialog
            key={snippetVariableRequest.variables.join("\u0000")}
            variables={snippetVariableRequest.variables}
            onInsert={handleSnippetVariablesInsert}
            onCancel={handleSnippetVariablesCancel}
          />
        ) : null}

        {/* Draft-from-prompt input (batch C3): the AI menu's entry opens it
            (new compose only — the toolbar disables the item elsewhere);
            Generate hands the instruction to the pending-offer flow, never
            straight into the draft. */}
        {aiTransformAvailable ? (
          <AiPromptDialog
            open={aiPromptOpen}
            onOpenChange={setAiPromptOpen}
            onGenerate={runDraftFromPrompt}
          />
        ) : null}

        {/* Discard confirmation (task 8.6): required for non-empty drafts. */}
        <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Discard draft?</DialogTitle>
              <DialogDescription>
                Your message will be deleted.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setConfirmDiscard(false)}
              >
                Cancel
              </Button>
              <Button variant="destructive" onClick={discardDraft}>
                Discard
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </section>
    </TooltipProvider>
  )
}
