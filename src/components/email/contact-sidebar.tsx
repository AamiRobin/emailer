import { useEffect, useState } from "react"
import { formatDistanceToNow } from "date-fns"
import { SquarePen } from "lucide-react"

import { ContactAvatar } from "@/components/contacts/contact-avatar"
import { Button } from "@/components/ui/button"
import { getExecutor } from "@/services/db/executor"
import type { ThreadRow } from "@/services/db/threads"
import { listRecentThreadsByParticipant } from "@/services/db/threads"
import { useComposerStore } from "@/stores/composer-store"
import { useUiStore } from "@/stores/ui-store"

/**
 * Reading-pane contact sidebar (task 2.7, contacts spec "Contact sidebar",
 * design D14 — no new storage): the current thread's sender with their
 * avatar (task 2.5's ContactAvatar, which owns the Gravatar setting),
 * display name, address, a compose-to action and the most recent threads
 * exchanged with that address, each row activating `onOpenThread`.
 *
 * The parent (thread-view) owns the TOGGLE and mounts this column only
 * when open — the sidebar renders the whole right-hand column (fixed
 * width, border, its own scroll area) so the message list shrinks beside
 * it via flex layout and nothing is ever covered. Default is closed: the
 * body is never displaced until the user asks for the sidebar.
 *
 * Sender mapping (documented decision): the spec's "current message's
 * sender" maps to the thread's ORIGINAL sender — the first message
 * chronologically (thread-view loads messages ascending) — the identity
 * the correspondence is anchored to, in contrast to the block-sender
 * affordance which targets the NEWEST message's cached sender.
 *
 * Compose-to mirrors use-contacts.ts's composeToContact bridge and its
 * ordering contract: the composer store is configured FIRST (openNew
 * already sets composer-store.open and carries the contact's OWNING
 * account — compose as the account the correspondence belongs to, no
 * account switch), then ui-store's composerOpen flag flips so MailShell
 * mounts the overlay around the prefilled draft without clobbering it.
 * The button is disabled without an owning account (never the case for a
 * loaded thread, but the prop is optional).
 */

/** How many recent threads the sidebar lists (the detail pane's default). */
const SIDEBAR_THREAD_LIMIT = 5

/**
 * The contact's recent threads, newest first (the db query's ordering),
 * excluding the currently open thread. DB failures render an empty list —
 * the sidebar is auxiliary and never breaks the reading pane. Reloads
 * when the address or the exclusion changes.
 */
function useRecentParticipantThreads(
  email: string,
  excludeThreadId: string | null
): ThreadRow[] {
  const [threads, setThreads] = useState<ThreadRow[]>([])
  useEffect(() => {
    let cancelled = false
    // The promise hop keeps the load (and the no-DB fallback —
    // getExecutor() throws outside Tauri) out of the effect body.
    Promise.resolve()
      .then(() =>
        listRecentThreadsByParticipant(getExecutor(), email, {
          limit: SIDEBAR_THREAD_LIMIT,
          excludeThreadId,
        })
      )
      .then((rows) => {
        if (!cancelled) setThreads(rows)
      })
      .catch((error) => {
        // An unmounted sidebar discards the answer; late failures
        // (executor torn down by test cleanup) are not worth reporting.
        if (cancelled) return
        console.warn("[contact-sidebar] failed to load recent threads", error)
        setThreads([])
      })
    return () => {
      cancelled = true
    }
  }, [email, excludeThreadId])
  return threads
}

/** Row timestamp: "5 minutes ago" style, like the thread list's rows. */
function formatRelativeDate(lastMessageAt: number | null): string {
  if (lastMessageAt === null) return ""
  return formatDistanceToNow(new Date(lastMessageAt * 1000), {
    addSuffix: true,
  })
}

export function ContactSidebar({
  email,
  name,
  accountId,
  excludeThreadId,
  onOpenThread,
}: {
  /** The contact's address (the sidebar's identity key). */
  email: string
  /** Display name from the message header; falls back to the address. */
  name?: string | null
  /** Owning account of the open thread — composes as this identity. */
  accountId?: string | null
  /** The open thread — never listed (it is already being read). */
  excludeThreadId?: string | null
  /** Row activation: open that thread in the reading pane. */
  onOpenThread: (threadId: string) => void
}) {
  const threads = useRecentParticipantThreads(email, excludeThreadId ?? null)
  const displayName = name?.trim() || email

  return (
    <aside
      data-testid="contact-sidebar"
      className="flex w-64 shrink-0 flex-col border-l border-border"
      aria-label={`Contact ${displayName}`}
    >
      <div className="flex items-start gap-3 p-3">
        {/* Task 2.5: ContactAvatar owns the Gravatar setting and the
            initials fallback; decorative because name/email are adjacent. */}
        <ContactAvatar email={email} name={name} className="size-10" />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="truncate text-sm font-semibold text-foreground">
            {displayName}
          </p>
          <p className="truncate text-xs text-muted-foreground" title={email}>
            {email}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="contact-compose"
          disabled={!accountId}
          aria-label={`Compose to ${displayName}`}
          title={`Compose to ${displayName}`}
          onClick={() => {
            if (!accountId) return
            const composer = useComposerStore.getState()
            composer.openNew(accountId)
            composer.setTo(
              name?.trim() ? [{ name: name.trim(), email }] : [{ email }]
            )
            useUiStore.getState().setComposerOpen(true)
          }}
        >
          <SquarePen />
        </Button>
      </div>
      <section
        aria-label="Recent threads"
        className="flex min-h-0 flex-1 flex-col px-3 pb-3"
      >
        <p className="py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Recent threads
        </p>
        {threads.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recent threads with this contact.
          </p>
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {threads.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  data-testid="contact-thread-row"
                  data-thread-id={thread.id}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent"
                  onClick={() => onOpenThread(thread.id)}
                >
                  {/* Unread dot, the thread list's indicator. */}
                  {thread.unread_count > 0 && (
                    <span
                      data-testid="contact-thread-unread"
                      aria-label="Unread"
                      className="size-2 shrink-0 rounded-full bg-primary"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {thread.subject || "(no subject)"}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatRelativeDate(thread.last_message_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}
