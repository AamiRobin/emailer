import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import {
  Archive,
  Ban,
  BellOff,
  Check,
  Clock,
  ListTodo,
  Mail,
  MailOpen,
  Pin,
  Reply,
  StickyNote,
  Star,
  Trash2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { getAccount, toEmailAccount } from "@/services/db/accounts"
import type { BlockedSenderAction } from "@/services/db/blocked-senders"
import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import {
  allowSender,
  isSenderAllowed,
  normalizeSenderEmail,
} from "@/services/db/image-allowlist"
import type { MessageRow } from "@/services/db/messages"
import { isThreadPendingTodo } from "@/services/db/todos"
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
import { setThreadNote } from "@/services/email-actions/notes"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import {
  parseThreadParticipants,
  refreshThreadList,
} from "@/stores/thread-list-store"
import { useAccountStore } from "@/stores/account-store"
import type { Recipient } from "@/stores/composer-store"
import { useUiStore } from "@/stores/ui-store"
import { addThreadToTodos } from "@/components/layout/use-todos"
import { BlockSenderDialog } from "./block-sender-dialog"
import { blockSenderWithRefresh } from "./block-sender-flow"
import { MailDisplay } from "./mail-display"
import { openReplyForThread } from "./reply-opener"
import { SnoozeMenu } from "./snooze-menu"
import { snoozeThreadsWithRefresh } from "./snooze-flow"
import {
  applyThreadStatesWithRefresh,
  type ThreadStateKind,
} from "./thread-state-flow"

/**
 * ThreadView — the real reading-pane content (tasks 7.1/7.3/7.4/7.5-UI).
 *
 * Data: loads the thread + its chronological messages through
 * getThreadWithMessages for uiStore.activeThread, re-loading whenever the
 * selection changes — the keyed inner component remounts per (account,
 * thread) selection, so open-scoped state (which messages were unread,
 * expansions, star state) resets naturally.
 *
 * Owning account (task 9.2, unified inbox): the loaded thread's own
 * account_id is authoritative — the selection may belong to any active
 * account, so the account-scoped work (profile lookup, image allowlist,
 * mark-read-on-open, the toolbar's archive/trash/star/read, reply) runs
 * as the OWNING account, not the active one; the account-scoped services
 * refuse a foreign accountId (resolveContext → ThreadNotFoundError). In
 * per-account views the owning and the active account coincide
 * (behavior-preserving); before a load completes the active-account prop
 * stands in (actions are disabled anyway).
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
 * via services/email-actions/thread-actions + store refreshes, plus the
 * local-only states mute/pin/done (task 3.3) through the shared state
 * flow, all disabled while a mutation is in flight. The local-only
 * additions join them: "Add to Todos" (task 15.2, the shared todos flow
 * in layout/use-todos — idempotent via UNIQUE(thread_id)) and the private
 * note toggle (task 15.1) revealing the auto-saving ThreadNotes editor
 * pinned under the toolbar. "Block sender" (task 18.2, the mail-security
 * spec's "Block from the reading pane" scenario) renders only when the
 * thread has a usable cached sender (the context menu's availability
 * condition) and opens the shared confirm dialog behind the SAME block
 * flow as the thread-list context menu (block-sender-flow.ts).
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
  /** Local-only states (task 3.3) seeded from the loaded thread row. */
  const [isMuted, setIsMuted] = useState(false)
  const [isPinned, setIsPinned] = useState(false)
  const [isDone, setIsDone] = useState(false)
  /** Thread note (task 15.1): present flag for the toolbar indicator,
   * plus the editor's open state — a thread WITH a note opens expanded
   * (the spec shows the note in the reading pane), without one the
   * toolbar toggle reveals the editor. */
  const [hasNote, setHasNote] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  /** The thread sits on the cross-account Todos list (task 15.2). */
  const [isTodo, setIsTodo] = useState(false)
  /** The reading-pane block sender (task 18.2): the confirm dialog's
   * open state — mounted fresh per open, like the context menu's. */
  const [blockOpen, setBlockOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)

  // Thread opens already marked read — the once-per-open guard (a ref
  // survives React StrictMode's double effect invocation).
  const markedReadRef = useRef<Set<string>>(new Set())

  const thread = state.loaded?.thread ?? null
  const messages = state.loaded?.messages ?? []
  const disabled = thread === null || pendingAction !== null
  /**
   * Task 9.2 (unified inbox): account-scoped operations target the open
   * thread's OWNING account — thread.account_id is authoritative once
   * loaded (the same resolution as the list's accountForTarget); before
   * the load completes (actions disabled anyway) it degrades to the
   * active-account prop. In per-account views the two always coincide.
   */
  const owningAccountId = thread?.account_id ?? accountId
  /**
   * Block sender availability (task 18.2): the SAME condition the thread
   * context menu's item uses — the thread's newest-message sender from the
   * participants cache (its first entry, maintained by
   * recomputeThreadCaches; the identity the sender sort, the bundles and
   * the block cleanup itself all match on). Threads without a usable
   * cached sender get no block affordance.
   */
  const blockSenderEmail = thread
    ? (parseThreadParticipants(thread.participants)[0]?.email ?? null)
    : null

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const executor = getExecutor()
        const loaded = await getThreadWithMessages(executor, threadId)
        if (cancelled) return
        if (!loaded) {
          setState({
            loaded: null,
            loading: false,
            loadFailed: true,
            allowedSenders: new Set(),
            account: null,
          })
          return
        }
        // Task 9.2 (unified inbox): the loaded thread's own account_id is
        // authoritative — the selection may belong to any active account,
        // so every account-scoped step below (account/profile lookups,
        // allowlist policy, mark-read-on-open) runs as the OWNING account,
        // not the active one (which would make the actions/service calls
        // refuse the thread). In per-account views the two coincide.
        const owningAccountId = loaded.thread.account_id
        const accountRow = await getAccount(executor, owningAccountId)
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
            allowed: await lookupSenderAllowed(
              executor,
              owningAccountId,
              email
            ),
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
        setIsMuted(loaded.thread.muted_at != null)
        setIsPinned(loaded.thread.pinned_at != null)
        setIsDone(loaded.thread.done_at != null)
        // Task 15.1: a thread with a note opens with the notes editor
        // expanded; the toolbar icon stays emphasized while a note exists.
        setHasNote(loaded.thread.note != null)
        setNotesOpen(loaded.thread.note != null)
        // Task 15.2: reflect the pending-todo membership on the toolbar
        // button (best-effort — a failed lookup just leaves the default).
        try {
          const pending = await isThreadPendingTodo(executor, threadId)
          if (!cancelled) setIsTodo(pending)
        } catch {
          // No executor (plain vite) — the button still works optimistically.
        }
        markThreadReadOnOpen(
          executor,
          owningAccountId,
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
    // Only the thread id drives the load: the owning account comes from
    // the loaded row (task 9.2), and active-account switches remount this
    // component via ThreadView's account:thread key anyway.
  }, [threadId])

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
        void allowSender(getExecutor(), owningAccountId, senderEmail)
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
    [owningAccountId]
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

  /**
   * Open the app-level composer prefilled as a reply to the thread's
   * latest message (task 7.6). The prefill itself lives in the shared
   * reply-opener helper (reply-opener.ts) so the toolbar, the inline
   * reply box, the list's context menu and the keyboard `r` binding all
   * take the identical path — including the composer-store-first bridge
   * ordering contract documented there. The reading view stays mounted
   * behind the composer overlay. Replies compose as the thread's OWNING
   * account (task 9.2) — the opener refuses an account mismatch.
   */
  const openReplyComposer = useCallback(
    (replyAll: boolean) => {
      void openReplyForThread({
        threadId,
        replyAll,
        accountId: owningAccountId,
      })
    },
    [threadId, owningAccountId]
  )

  /**
   * Toolbar snooze (task 2.3): the shared snooze flow (service + toast +
   * list/badge/section refreshes) under the same pendingAction guard as
   * the other toolbar actions. The snoozed thread leaves the current view
   * via the flow's list refresh.
   */
  const snoozeFromToolbar = (until: number, label: string) => {
    if (pendingAction !== null) return
    setPendingAction("snooze")
    snoozeThreadsWithRefresh(getExecutor(), [threadId], until, label).finally(
      () => {
        setPendingAction(null)
      }
    )
  }

  /**
   * Toolbar local-state toggles (task 3.3): the shared state flow (per-
   * thread service writes + toast + the trimmed refresh sequence) under
   * the same pendingAction guard as the other toolbar actions. A mute or
   * done drops the thread from the inbox list behind the still-open
   * reading pane via the flow's list refresh; the button labels flip from
   * the local state on success.
   */
  const toggleThreadState = (kind: ThreadStateKind) => {
    if (pendingAction !== null) return
    setPendingAction(kind)
    applyThreadStatesWithRefresh(getExecutor(), [threadId], kind)
      .then((applied) => {
        if (!applied) return
        if (kind === "mute") setIsMuted(true)
        else if (kind === "unmute") setIsMuted(false)
        else if (kind === "pin") setIsPinned(true)
        else if (kind === "unpin") setIsPinned(false)
        else if (kind === "done") setIsDone(true)
        else setIsDone(false)
      })
      .finally(() => {
        setPendingAction(null)
      })
  }

  /**
   * Toolbar "Add to Todos" (task 15.2): the shared todos flow (service
   * write + section notify + toast) under the same pendingAction guard as
   * the other toolbar actions. Idempotent by UNIQUE(thread_id): when the
   * thread is already pending, adding again moves it to the bottom.
   */
  const addTodoFromToolbar = () => {
    if (pendingAction !== null) return
    setPendingAction("add-todo")
    addThreadToTodos(owningAccountId, threadId)
      .then(() => setIsTodo(true))
      .finally(() => {
        setPendingAction(null)
      })
  }

  /**
   * Reading-pane "Block sender" confirm (task 18.2): the SHARED block
   * flow (block-sender-flow.ts — the thread-list context menu's block
   * entry runs the exact same path) under the same pendingAction guard
   * as the other toolbar actions. The dialog only reports the intent;
   * the flow owns the blocklist write, the optional existing-mail
   * cleanup, the toast and the refreshes — its list refresh prunes the
   * filed rows behind the still-open pane.
   */
  const confirmBlockSender = (
    action: BlockedSenderAction,
    applyToExisting: boolean
  ) => {
    if (blockSenderEmail === null || pendingAction !== null) return
    setBlockOpen(false)
    setPendingAction("block")
    try {
      blockSenderWithRefresh(
        getExecutor(),
        owningAccountId,
        blockSenderEmail,
        action,
        applyToExisting
      ).finally(() => {
        setPendingAction(null)
      })
    } catch (error) {
      console.warn("[thread-view] block sender unavailable", error)
      setPendingAction(null)
    }
  }

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
              accountId={owningAccountId}
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
                archiveThread(executor, owningAccountId, threadId)
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
                trashThread(executor, owningAccountId, threadId)
              )
            }
          >
            <Trash2 className="size-4" />
            <span className="sr-only">Move to trash</span>
          </Button>
          <SnoozeMenu onPick={snoozeFromToolbar}>
            <Button
              variant="ghost"
              size="icon"
              data-testid="toolbar-snooze"
              disabled={disabled}
              title="Snooze"
            >
              <Clock className="size-4" />
              <span className="sr-only">Snooze</span>
            </Button>
          </SnoozeMenu>
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
                  setThreadStarred(executor, owningAccountId, threadId, next),
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
                  setThreadRead(executor, owningAccountId, threadId, next),
                // `next` is the mark-read value; the thread now has unread
                // messages exactly when it was marked unread instead.
                () => setHasUnread(!next)
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
          <Button
            variant="ghost"
            size="icon"
            data-testid="toolbar-mute"
            disabled={disabled}
            title={isMuted ? "Unmute thread" : "Mute thread"}
            onClick={() => toggleThreadState(isMuted ? "unmute" : "mute")}
          >
            <BellOff
              className={isMuted ? "size-4 text-foreground" : "size-4"}
            />
            <span className="sr-only">
              {isMuted ? "Unmute thread" : "Mute thread"}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-testid="toolbar-pin"
            disabled={disabled}
            title={isPinned ? "Unpin thread" : "Pin thread"}
            onClick={() => toggleThreadState(isPinned ? "unpin" : "pin")}
          >
            <Pin className={isPinned ? "size-4 fill-current" : "size-4"} />
            <span className="sr-only">
              {isPinned ? "Unpin thread" : "Pin thread"}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-testid="toolbar-done"
            disabled={disabled}
            title={isDone ? "Mark not done" : "Mark done"}
            onClick={() => toggleThreadState(isDone ? "undone" : "done")}
          >
            <Check className="size-4" />
            <span className="sr-only">
              {isDone ? "Mark not done" : "Mark done"}
            </span>
          </Button>
          {/* Task 15.2: add the thread to the cross-account Todos list.
              Always clickable — a re-add is a benign move-to-bottom — but
              emphasized while the thread is already pending. */}
          <Button
            variant="ghost"
            size="icon"
            data-testid="toolbar-add-todo"
            disabled={disabled}
            title={
              isTodo ? "In Todos — click to move to the bottom" : "Add to Todos"
            }
            onClick={addTodoFromToolbar}
          >
            <ListTodo
              className={isTodo ? "size-4 text-foreground" : "size-4"}
            />
            <span className="sr-only">
              {isTodo ? "In Todos" : "Add to Todos"}
            </span>
          </Button>
          {/* Task 15.1: toggle the private note editor. Emphasized while a
              note exists so a closed editor is still discoverable. */}
          <Button
            variant="ghost"
            size="icon"
            data-testid="toolbar-note"
            disabled={disabled}
            aria-pressed={notesOpen}
            title={hasNote ? "Edit note" : "Add a note"}
            onClick={() => setNotesOpen((open) => !open)}
          >
            <StickyNote
              className={hasNote ? "size-4 fill-current" : "size-4"}
            />
            <span className="sr-only">
              {hasNote ? "Edit note" : "Add a note"}
            </span>
          </Button>
          {/* Task 18.2: the reading-pane Block sender entry (the mail-
              security spec's "Block from the reading pane" scenario) —
              rendered only when the thread has a usable cached sender,
              like the list's context-menu item. Opens the same confirm
              dialog; the flow runs on confirm. */}
          {blockSenderEmail && (
            <Button
              variant="ghost"
              size="icon"
              data-testid="toolbar-block-sender"
              disabled={disabled}
              title="Block sender"
              onClick={() => {
                if (pendingAction !== null) return
                setBlockOpen(true)
              }}
            >
              <Ban className="size-4" />
              <span className="sr-only">Block sender</span>
            </Button>
          )}
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
      {/* Task 15.1: the collapsible private-note editor, pinned under the
          toolbar so a note stays visible above the messages while open.
          Closing (or switching threads) flushes a pending auto-save. */}
      {notesOpen && thread && (
        <ThreadNotes
          threadId={threadId}
          initialNote={thread.note ?? null}
          onHasNoteChange={setHasNote}
        />
      )}
      {renderBody()}
      {/* Task 18.2: the block confirm dialog, mounted fresh per open and
          unmounted on close — the choice made here persists at block time
          (same pattern as the context menu's dialog). Blocking targets the
          thread's OWNING account, like every other account-scoped toolbar
          action. */}
      {blockOpen && blockSenderEmail && (
        <BlockSenderDialog
          sender={blockSenderEmail}
          accountId={owningAccountId}
          open
          onOpenChange={setBlockOpen}
          onConfirm={confirmBlockSender}
        />
      )}
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
// Thread notes (task 15.1)
// ---------------------------------------------------------------------------

/** Quiet period after the last keystroke before the note auto-saves. */
const NOTE_SAVE_DEBOUNCE_MS = 800
/** How long the subtle "Saved" affordance stays visible after a write. */
const NOTE_SAVED_VISIBLE_MS = 2000

/**
 * The private thread-note editor (task 15.1, mail-organization spec
 * "Thread notes"). Local-only by construction: the editor writes through
 * setThreadNote (a plain threads.note UPDATE — the note is never sent and
 * no queue operation exists for it), so it survives restarts like the
 * other local states.
 *
 * Auto-save mirrors the draft autosave's UX contract (use-draft-autosave)
 * in a leaner, single-value shape: a change re-arms a short debounce
 * timer, blur saves immediately, and unmount flushes the last value (so
 * collapsing the editor or switching threads cannot lose keystrokes).
 * Writing an empty/whitespace note REMOVES it (the service normalizes to
 * NULL), which also clears the thread row's note indicator. After each
 * successful write the thread list refreshes so that indicator keeps up,
 * and a subtle "Saved" line shows for a moment — the same quiet
 * acknowledgment style the composer's autosave affordances use.
 */
function ThreadNotes({
  threadId,
  initialNote,
  onHasNoteChange,
}: {
  threadId: string
  /** The thread's stored note at open time (the editor's baseline). */
  initialNote: string | null
  /** Notified after every successful save so the toolbar's indicator
   * (and thus the thread row's, via the list refresh) stays current. */
  onHasNoteChange: (hasNote: boolean) => void
}) {
  const [value, setValue] = useState(initialNote ?? "")
  const [savedRecently, setSavedRecently] = useState(false)
  // latest-ref pattern: timer callbacks persist the newest keystrokes
  // (synced after commit, never during render).
  const valueRef = useRef(value)
  useEffect(() => {
    valueRef.current = value
  })
  const lastSavedRef = useRef<string | null>(initialNote)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearDebounce = useCallback(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [])

  const persist = useCallback(
    (text: string) => {
      if (text === lastSavedRef.current) return
      try {
        setThreadNote(getExecutor(), threadId, text)
          .then(() => {
            lastSavedRef.current = text
            onHasNoteChange(text.trim() !== "")
            setSavedRecently(true)
            if (savedTimerRef.current !== null) {
              clearTimeout(savedTimerRef.current)
            }
            savedTimerRef.current = setTimeout(() => {
              savedTimerRef.current = null
              setSavedRecently(false)
            }, NOTE_SAVED_VISIBLE_MS)
          })
          .catch((error) => {
            console.warn("[thread-view] note save failed", error)
          })
        // Best-effort: the row indicator lives in the thread-list cache.
        void refreshThreadList().catch(() => {})
      } catch (error) {
        // getExecutor() throws outside Tauri (plain vite) — never crash.
        console.warn("[thread-view] note save unavailable", error)
      }
    },
    [threadId, onHasNoteChange]
  )

  // Unmount flush: collapse, thread switch, pane teardown — pending
  // keystrokes land before the editor goes away.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current)
      const pending = valueRef.current
      if (pending !== lastSavedRef.current) {
        try {
          void setThreadNote(getExecutor(), threadId, pending).catch(() => {})
        } catch {
          // no executor (tests / plain vite) — nothing to flush
        }
      }
    }
  }, [threadId])

  const handleChange = (text: string) => {
    setValue(text)
    clearDebounce()
    if (text === lastSavedRef.current) return // reverted to the saved note
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      persist(text)
    }, NOTE_SAVE_DEBOUNCE_MS)
  }

  return (
    <div data-testid="thread-notes" className="px-6 pt-4">
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <div className="mb-1.5 flex items-center gap-1.5">
          <StickyNote
            aria-hidden="true"
            className="size-3.5 text-muted-foreground"
          />
          <span className="text-xs font-medium text-muted-foreground">
            Note
          </span>
          <span className="text-xs text-muted-foreground/70">
            Private — stored only on this device
          </span>
          {savedRecently && (
            <span
              data-testid="thread-note-saved"
              className="ml-auto text-xs text-muted-foreground"
            >
              Saved
            </span>
          )}
        </div>
        <Textarea
          data-testid="thread-note-input"
          aria-label="Thread note"
          value={value}
          rows={3}
          placeholder="Add a private note…"
          className="resize-y bg-transparent text-sm"
          onChange={(event) => handleChange(event.target.value)}
          onBlur={() => {
            clearDebounce()
            persist(valueRef.current)
          }}
        />
      </div>
    </div>
  )
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
