import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import { Archive, Mail, MailOpen, Reply, Star, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { getAccount, toEmailAccount } from "@/services/db/accounts"
import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import {
  allowSender,
  isSenderAllowed,
  normalizeSenderEmail,
} from "@/services/db/image-allowlist"
import type { MessageRow } from "@/services/db/messages"
import type { ThreadWithMessages } from "@/services/db/threads"
import { getThreadWithMessages } from "@/services/db/threads"
import { buildReply } from "@/services/composer/reply"
import type { EmailAccount } from "@/services/email/types"
import {
  archiveThread,
  setThreadRead,
  setThreadStarred,
  trashThread,
} from "@/services/email-actions/thread-actions"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import { refreshThreadList } from "@/stores/thread-list-store"
import { useAccountStore } from "@/stores/account-store"
import type { Recipient } from "@/stores/composer-store"
import { useUiStore } from "@/stores/ui-store"
import { MailDisplay } from "./mail-display"
import { openReplyForThread } from "./reply-opener"

/**
 * ThreadView — the real reading-pane content (tasks 7.1/7.3/7.4/7.5-UI).
 *
 * Data: loads the thread + its chronological messages through
 * getThreadWithMessages for uiStore.activeThread + the active account,
 * re-loading whenever the selection changes — the keyed inner component
 * remounts per (account, thread) selection, so open-scoped state (which
 * messages were unread, expansions, star state) resets naturally.
 *
 * Mark-read-on-open: opening a thread with unread messages marks the
 * whole thread read through setThreadRead exactly once per open (ref
 * guard, StrictMode-safe) and refreshes the thread-list/folder-count
 * caches — in the "new message in an existing thread" scenario the older
 * messages stay collapsed while the new one renders expanded.
 *
 * Image policy (task 7.3): senders on the image_allowlist render remote
 * images automatically; everyone else gets the per-message banner
 * (inside MailDisplay) whose "Always allow from sender" lands here and
 * persists through allowSender.
 *
 * Toolbar: the real thread actions (archive/trash/star/mark-read/unread)
 * via services/email-actions/thread-actions + store refreshes, disabled
 * while a mutation is in flight.
 *
 * Inline reply (task 7.6): a muted one-line affordance below the message
 * list expands into a compact summary (resolved To/Cc, Re: subject) whose
 * Reply / Reply all buttons prefill the real composer through the shared
 * reply-opener helper (buildReply + getSignature) and open the app-level
 * composer overlay — the reading view stays mounted behind it
 * (ui-store.composerOpen only mounts the overlay; it never unmounts this
 * pane). The toolbar Reply button takes the same path, defaulting to
 * reply (not reply-all); see reply-opener.ts for the composer-store
 * bridge ordering contract shared with the list's context menu and the
 * keyboard binding.
 */

export function ThreadView() {
  const activeThread = useUiStore((state) => state.activeThread)
  const activeAccountId = useAccountStore((state) => state.activeAccountId)

  if (!activeThread || !activeAccountId) {
    return (
      <div data-testid="thread-empty" className="flex h-full min-h-0 flex-col">
        <div className="p-8 text-center text-muted-foreground">
          No message selected
        </div>
      </div>
    )
  }
  return (
    <ThreadViewContent
      key={`${activeAccountId}:${activeThread}`}
      threadId={activeThread}
      accountId={activeAccountId}
    />
  )
}

interface ThreadViewState {
  loaded: ThreadWithMessages | null
  loading: boolean
  loadFailed: boolean
  /** Senders (normalized emails) allowed to render remote images. */
  allowedSenders: Set<string>
  account: EmailAccount | null
}

function ThreadViewContent({
  threadId,
  accountId,
}: {
  threadId: string
  accountId: string
}) {
  const [state, setState] = useState<ThreadViewState>({
    loaded: null,
    loading: true,
    loadFailed: false,
    allowedSenders: new Set(),
    account: null,
  })
  /** Messages unread at open time: rendered expanded + emphasized. */
  const [initiallyUnreadIds, setInitiallyUnreadIds] = useState<Set<string>>(
    () => new Set()
  )
  /** User-toggled expansion of collapsed messages (unread start expanded). */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [isStarred, setIsStarred] = useState(false)
  /** The thread still has unread messages (read/unread toggle state). */
  const [hasUnread, setHasUnread] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)

  // Thread opens already marked read — the once-per-open guard (a ref
  // survives React StrictMode's double effect invocation).
  const markedReadRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const executor = getExecutor()
        const loaded = await getThreadWithMessages(executor, threadId)
        if (cancelled) return
        if (!loaded || loaded.thread.account_id !== accountId) {
          setState({
            loaded: null,
            loading: false,
            loadFailed: true,
            allowedSenders: new Set(),
            account: null,
          })
          return
        }
        const accountRow = await getAccount(executor, accountId)
        const senderEmails = [
          ...new Set(
            loaded.messages
              .map((message) => message.from_address ?? "")
              .filter((email) => email.length > 0)
          ),
        ]
        const allowed = await Promise.all(
          senderEmails.map(async (email) => ({
            email,
            allowed: await lookupSenderAllowed(executor, accountId, email),
          }))
        )
        if (cancelled) return
        const unreadIds = new Set(
          loaded.messages
            .filter((message) => message.is_read === 0)
            .map((message) => message.id)
        )
        setState({
          loaded,
          loading: false,
          loadFailed: false,
          allowedSenders: new Set(
            allowed.filter((entry) => entry.allowed).map((entry) => entry.email)
          ),
          account: accountRow ? toEmailAccount(accountRow) : null,
        })
        setInitiallyUnreadIds(unreadIds)
        // Unread messages start expanded; read ones start collapsed.
        setExpandedIds(new Set(unreadIds))
        setIsStarred(loaded.thread.is_starred === 1)
        setHasUnread(unreadIds.size > 0)
        markThreadReadOnOpen(
          executor,
          accountId,
          threadId,
          unreadIds,
          markedReadRef,
          () => {
            if (!cancelled) setHasUnread(false)
          }
        )
      } catch (error) {
        // getExecutor() throws outside Tauri (plain vite, tests without a
        // db override) — degrade to the error state, never crash.
        console.warn("[thread-view] failed to load thread", error)
        if (!cancelled) {
          setState({
            loaded: null,
            loading: false,
            loadFailed: true,
            allowedSenders: new Set(),
            account: null,
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [threadId, accountId])

  const handleToggleExpanded = useCallback((messageId: string) => {
    setExpandedIds((previous) => {
      const next = new Set(previous)
      if (next.has(messageId)) {
        next.delete(messageId)
      } else {
        next.add(messageId)
      }
      return next
    })
  }, [])

  const handleAllowSender = useCallback(
    (senderEmail: string) => {
      const normalized = normalizeSenderEmail(senderEmail)
      try {
        void allowSender(getExecutor(), accountId, senderEmail)
          .then(() => {
            setState((previous) => ({
              ...previous,
              allowedSenders: new Set(previous.allowedSenders).add(normalized),
            }))
          })
          .catch((error) => {
            console.warn("[thread-view] allow-sender failed", error)
          })
      } catch (error) {
        console.warn("[thread-view] allow-sender unavailable", error)
      }
    },
    [accountId]
  )

  const runThreadAction = useCallback(
    (
      action: string,
      mutate: (executor: SqlExecutor) => Promise<void>,
      onSuccess?: () => void
    ) => {
      if (pendingAction !== null) return
      setPendingAction(action)
      try {
        mutate(getExecutor())
          .then(() =>
            Promise.all([refreshThreadList(), refreshFolderIndicators()])
          )
          .then(() => {
            onSuccess?.()
          })
          .catch((error) => {
            console.warn(`[thread-view] ${action} failed`, error)
          })
          .finally(() => {
            setPendingAction(null)
          })
      } catch (error) {
        console.warn(`[thread-view] ${action} unavailable`, error)
        setPendingAction(null)
      }
    },
    [pendingAction]
  )

  const thread = state.loaded?.thread ?? null
  const messages = state.loaded?.messages ?? []
  const disabled = thread === null || pendingAction !== null

  /**
   * Open the app-level composer prefilled as a reply to the thread's
   * latest message (task 7.6). The prefill itself lives in the shared
   * reply-opener helper (reply-opener.ts) so the toolbar, the inline
   * reply box, the list's context menu and the keyboard `r` binding all
   * take the identical path — including the composer-store-first bridge
   * ordering contract documented there. The reading view stays mounted
   * behind the composer overlay.
   */
  const openReplyComposer = useCallback(
    (replyAll: boolean) => {
      void openReplyForThread({ threadId, replyAll, accountId })
    },
    [threadId, accountId]
  )

  function renderBody() {
    if (state.loading) {
      return (
        <div
          data-testid="thread-loading"
          className="p-8 text-center text-sm text-muted-foreground"
        >
          Loading thread…
        </div>
      )
    }
    if (!thread || state.loadFailed) {
      return (
        <div
          data-testid="thread-not-found"
          className="p-8 text-center text-muted-foreground"
        >
          Message not found
        </div>
      )
    }
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl pb-6">
          <h2
            data-testid="thread-subject"
            className="px-6 pt-4 text-base font-semibold"
          >
            {thread.subject || "(no subject)"}
          </h2>
          <div className="pt-2">
            {messages.map((message) => (
              <div
                key={message.id}
                className="border-b border-border last:border-b-0"
              >
                <MailDisplay
                  message={message}
                  threadSubject={thread.subject}
                  imagesAllowed={
                    message.from_address !== null &&
                    state.allowedSenders.has(
                      normalizeSenderEmail(message.from_address)
                    )
                  }
                  onAllowSender={handleAllowSender}
                  initiallyUnread={initiallyUnreadIds.has(message.id)}
                  expanded={expandedIds.has(message.id)}
                  onToggleExpanded={() => handleToggleExpanded(message.id)}
                  account={state.account}
                />
              </div>
            ))}
          </div>
          {/* Task 7.6: inline reply affordance below the message list. */}
          {messages.length > 0 && (
            <InlineReply
              message={messages[messages.length - 1]}
              thread={thread}
              account={state.account}
              accountId={accountId}
              disabled={disabled}
              onOpenComposer={openReplyComposer}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center p-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            data-testid="toolbar-archive"
            disabled={disabled}
            title="Archive"
            onClick={() =>
              runThreadAction("archive", (executor) =>
                archiveThread(executor, accountId, threadId)
              )
            }
          >
            <Archive className="size-4" />
            <span className="sr-only">Archive</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-testid="toolbar-trash"
            disabled={disabled}
            title="Move to trash"
            className="text-destructive hover:text-destructive focus-visible:text-destructive"
            onClick={() =>
              runThreadAction("trash", (executor) =>
                trashThread(executor, accountId, threadId)
              )
            }
          >
            <Trash2 className="size-4" />
            <span className="sr-only">Move to trash</span>
          </Button>
          <Separator orientation="vertical" className="mx-1 h-6" />
          <Button
            variant="ghost"
            size="icon"
            data-testid="toolbar-star"
            disabled={disabled}
            title={isStarred ? "Unstar thread" : "Star thread"}
            onClick={() => {
              const next = !isStarred
              runThreadAction(
                "star",
                (executor) =>
                  setThreadStarred(executor, accountId, threadId, next),
                () => setIsStarred(next)
              )
            }}
          >
            <Star className={isStarred ? "size-4 fill-current" : "size-4"} />
            <span className="sr-only">
              {isStarred ? "Unstar thread" : "Star thread"}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-testid="toolbar-read-toggle"
            disabled={disabled}
            title={hasUnread ? "Mark as read" : "Mark as unread"}
            onClick={() => {
              const next = hasUnread
              runThreadAction(
                next ? "read" : "unread",
                (executor) =>
                  setThreadRead(executor, accountId, threadId, next),
                () => setHasUnread(next)
              )
            }}
          >
            {hasUnread ? (
              <Mail className="size-4" />
            ) : (
              <MailOpen className="size-4" />
            )}
            <span className="sr-only">
              {hasUnread ? "Mark as read" : "Mark as unread"}
            </span>
          </Button>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {/* Task 7.6: same prefill path as the inline box, reply-all off. */}
          <Button
            variant="ghost"
            size="icon"
            data-testid="toolbar-reply"
            disabled={disabled}
            title="Reply"
            onClick={() => openReplyComposer(false)}
          >
            <Reply className="size-4" />
            <span className="sr-only">Reply</span>
          </Button>
        </div>
      </div>
      <Separator />
      {renderBody()}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline reply (task 7.6)
// ---------------------------------------------------------------------------

/** First name of the reply target for the collapsed bar's placeholder
 * ("Reply to William…"); degrades to the address local part, then
 * "participants" when the sender has no usable identity. */
function firstNameOf(fromName: string | null, fromAddress: string | null) {
  const name = fromName?.trim()
  if (name) return name.split(/\s+/)[0]
  const address = fromAddress?.trim()
  if (address) return address.split("@")[0]
  return "participants"
}

/**
 * Inline reply affordance at the bottom of an opened thread. Collapsed it
 * is a muted one-line box ("Reply to {sender}…", the tweakcn reference's
 * personalized placeholder); clicking expands a
 * compact summary — the resolved To (and Cc, when a reply-all would add
 * any) plus the Re: subject — with Reply / Reply all / Cancel and a note
 * that the full editor opens. Both actions route through ThreadView's
 * openReplyComposer, so the actual editing happens in the app-level
 * composer overlay while this reading view stays mounted behind it.
 *
 * The summary is computed with the pure buildReply (no signature), so it
 * always mirrors what the composer will prefill; the prefill itself is
 * rebuilt with the account signature at open time.
 */
function InlineReply({
  message,
  thread,
  account,
  accountId,
  disabled,
  onOpenComposer,
}: {
  /** Reply target — the thread's latest message. */
  message: MessageRow
  thread: ThreadWithMessages["thread"]
  account: EmailAccount | null
  accountId: string
  disabled: boolean
  onOpenComposer: (replyAll: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)

  const composerAccount = useMemo(
    () => account ?? { id: accountId, email: "" },
    [account, accountId]
  )
  // Reply-all carries the superset of recipients, so it drives the
  // displayed To/Cc lines; the plain-reply targets are its prefix.
  const summary = useMemo(
    () =>
      buildReply({
        message,
        thread,
        account: composerAccount,
        replyAll: true,
      }),
    [message, thread, composerAccount]
  )

  if (!expanded) {
    return (
      <div data-testid="reply-anchor" className="px-6 pb-4">
        <button
          type="button"
          data-testid="inline-reply-open"
          className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-accent hover:text-foreground"
          onClick={() => setExpanded(true)}
        >
          <Reply className="size-4 shrink-0" aria-hidden="true" />
          <span>
            Reply to {firstNameOf(message.from_name, message.from_address)}…
          </span>
        </button>
      </div>
    )
  }

  return (
    <div data-testid="reply-anchor" className="px-6 pb-4">
      <div
        data-testid="inline-reply-expanded"
        className="rounded-lg border border-border bg-muted/30 p-3"
      >
        <div className="grid gap-1 text-xs">
          <div data-testid="inline-reply-to" className="min-w-0">
            <span className="font-medium text-muted-foreground">To:</span>{" "}
            <span className="text-muted-foreground">
              {formatRecipients(summary.to)}
            </span>
          </div>
          {summary.cc.length > 0 && (
            <div data-testid="inline-reply-cc" className="min-w-0">
              <span className="font-medium text-muted-foreground">Cc:</span>{" "}
              <span className="text-muted-foreground">
                {formatRecipients(summary.cc)}
              </span>
            </div>
          )}
          <div data-testid="inline-reply-subject" className="min-w-0">
            <span className="font-medium text-muted-foreground">Subject:</span>{" "}
            <span>{summary.subject}</span>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            data-testid="inline-reply-send"
            disabled={disabled}
            onClick={() => onOpenComposer(false)}
          >
            <Reply className="size-3.5" />
            Reply
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="inline-reply-reply-all"
            disabled={disabled}
            onClick={() => onOpenComposer(true)}
          >
            Reply all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="inline-reply-cancel"
            onClick={() => setExpanded(false)}
          >
            Cancel
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">
            Opens the full editor
          </span>
        </div>
      </div>
    </div>
  )
}

/** "Name <email>" comma list for the inline reply summary lines. */
function formatRecipients(recipients: Recipient[]): string {
  return recipients
    .map((recipient) =>
      recipient.name
        ? `${recipient.name} <${recipient.email}>`
        : recipient.email
    )
    .join(", ")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Folder-badge cache refresh (the store's own method, best-effort). */
function refreshFolderIndicators(): Promise<void> {
  return useFolderCountsStore.getState().refreshFolderCounts()
}

/** Allowlist lookup that never breaks the thread load (cosmetic policy). */
async function lookupSenderAllowed(
  executor: SqlExecutor,
  accountId: string,
  senderEmail: string
): Promise<boolean> {
  try {
    return await isSenderAllowed(executor, accountId, senderEmail)
  } catch (error) {
    console.warn("[thread-view] allowlist lookup failed", error)
    return false
  }
}

/**
 * Mark the thread read once per open when it had unread messages, then
 * refresh the list/folder caches. The guard ref survives StrictMode's
 * double effect invocation; a failed mutation releases the guard so the
 * next open retries.
 */
function markThreadReadOnOpen(
  executor: SqlExecutor,
  accountId: string,
  threadId: string,
  unreadIds: Set<string>,
  guard: RefObject<Set<string>>,
  onComplete: () => void
): void {
  if (unreadIds.size === 0) return
  const guardKey = `${accountId}:${threadId}`
  if (guard.current?.has(guardKey)) return
  guard.current?.add(guardKey)
  setThreadRead(executor, accountId, threadId, true)
    .then(() => Promise.all([refreshThreadList(), refreshFolderIndicators()]))
    .then(() => {
      onComplete()
    })
    .catch((error) => {
      console.warn("[thread-view] mark-read-on-open failed", error)
      guard.current?.delete(guardKey)
    })
}
