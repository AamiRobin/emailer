import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react"
import { Link as LinkExtension } from "@tiptap/extension-link"
import { TextAlign } from "@tiptap/extension-text-align"
import { Underline } from "@tiptap/extension-underline"
import { EditorContent, useEditor } from "@tiptap/react"
import { StarterKit } from "@tiptap/starter-kit"
import { Placeholder } from "@tiptap/extensions"
import { Paperclip, X } from "lucide-react"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useAccountStore } from "@/stores/account-store"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import { getComposerPayload, useComposerStore } from "@/stores/composer-store"
import { refreshThreadList } from "@/stores/thread-list-store"
import { hasInvalidRecipient } from "./address-validation"
import { addFileAttachments, pickAttachments } from "./attachment-input"
import { getAttachmentBytes } from "./attachment-bytes"
import { AttachmentStrip } from "./attachment-strip"
import { ComposerToolbar } from "./composer-toolbar"
import { RecipientField } from "./recipient-field"
import { ScheduleSendMenu } from "./schedule-send-menu"
import { SendGuardDialogs } from "./send-guard-dialogs"
import { evaluateSendGuards, type SendGuardKind } from "./send-guards"
import { createSnippetExpansion, setSnippetShortcuts } from "./snippet-insert"
import { getDefaultPrivateKey } from "@/services/crypto/pgp-keys"
import {
  deleteDraftByKey,
  isDraftEmpty,
  type DraftInput,
} from "@/services/composer/drafts"
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
  setEmptySubjectGuardSuppressedPreference,
} from "@/services/settings/preferences"
import { scheduleComposerSend } from "@/components/layout/use-scheduled-sends"
import { formatSnoozedUntil } from "@/components/layout/use-snoozed-threads"

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
 */

/** Token utilities standing in for prose styles (no typography plugin):
 * list markers, paragraph rhythm and link styling inside the editor. */
const EDITOR_CONTENT_CLASS =
  "max-w-none [&_a]:text-primary [&_a]:underline [&_ol]:list-decimal [&_ol]:ps-6 [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p.is-empty:first-child]:before:pointer-events-none [&_p.is-empty:first-child]:before:float-left [&_p.is-empty:first-child]:before:h-0 [&_p.is-empty:first-child]:before:content-[attr(data-placeholder)] [&_p.is-empty:first-child]:before:text-muted-foreground [&_ul]:list-disc [&_ul]:ps-6"

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

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return
    void addFileAttachments(files).then((result) =>
      setAttachmentError(result.error ?? null)
    )
  }

  const handleAttachClick = () => {
    void pickAttachments().then((result) =>
      setAttachmentError(result.error ?? null)
    )
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
    },
    onUpdate: ({ editor: current }) => setHtml(current.getHTML()),
  })

  // Cc/Bcc rows auto-reveal when a reply-all pre-fills them (task 8.4).
  const ccVisible = showCc || cc.length > 0
  const bccVisible = showBcc || bcc.length > 0

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
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex h-full min-h-96 flex-col bg-background ${
          dragActive ? "bg-primary/5 ring-2 ring-primary ring-inset" : ""
        }`}
      >
        <div className="flex items-center justify-between px-4 pt-3">
          <span className="text-sm font-medium text-muted-foreground">
            {mode.kind === "reply"
              ? "Reply"
              : mode.kind === "forward"
                ? "Forward"
                : "New message"}
          </span>
          {/* Dismiss keeping the draft — the autosaved local_drafts row
              stays addressable from the Drafts folder (resume on click). */}
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
        />
        <Separator />

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">
          <div className={EDITOR_CONTENT_CLASS}>
            <EditorContent editor={editor} />
          </div>
        </div>

        {/* Attachment strip + inline cap/read errors (task 8.5). */}
        <AttachmentStrip />
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
          <Button disabled={!canSend || sending} onClick={handleSend}>
            {sending ? "Sending…" : "Send"}
          </Button>
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
