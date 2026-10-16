import { useEffect, useState } from "react"
import { History, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { historyWindowLabel } from "@/services/sync/history-window"
import { accountHistoryWindow, getAccount } from "@/services/db/accounts"
import type { SqlExecutor } from "@/services/db/executor"
import {
  dismissBoundedFirstSyncNotice,
  isBoundedFirstSync,
  isBoundedNoticeDismissed,
} from "@/services/sync/history-window"
import { getThreadListExecutor } from "@/stores/thread-list-store"

/**
 * The bounded-first-sync notice (parity-round-3 task 3.4, mail-sync spec
 * "Bounded first sync"): a subtle, dismissible one-line row at the top of
 * an account-scoped mailbox view telling the user that this account's
 * FIRST sync downloaded only the window's range, so older mail is still
 * on the server. Shows only while the account actually HAS a bounded
 * window, the bounded-first-sync flag was recorded by its sync driver,
 * and the user has not dismissed the notice — a widened window that has
 * been backfilled (or switched to All) naturally stops showing it.
 * Deliberately the least intrusive surface: an indicator row in the list
 * it affects, not a toast or a settings-only note.
 */

interface BoundedSyncNoticeProps {
  /** The single account the open view scopes to; null hides the notice. */
  accountId: string | null
}

interface NoticeState {
  /** The account this state was loaded for (staleness guard). */
  accountId: string
  windowLabel: string
  dismissed: boolean
}

export function BoundedSyncNotice({ accountId }: BoundedSyncNoticeProps) {
  const [state, setState] = useState<NoticeState | null>(null)

  useEffect(() => {
    if (accountId === null) return
    let cancelled = false
    const executor: SqlExecutor = getThreadListExecutor()
    void Promise.all([
      getAccount(executor, accountId),
      isBoundedFirstSync(executor, accountId),
      isBoundedNoticeDismissed(executor, accountId),
    ])
      .then(([row, bounded, dismissed]) => {
        if (cancelled) return
        const window = row ? accountHistoryWindow(row) : null
        setState(
          window !== null && bounded
            ? { accountId, windowLabel: historyWindowLabel(window), dismissed }
            : null
        )
      })
      .catch(() => {
        if (!cancelled) setState(null)
      })
    return () => {
      cancelled = true
    }
  }, [accountId])

  // The accountId checks at render cover both the null scope and a stale
  // state still carrying the previous account's load.
  if (
    accountId === null ||
    state === null ||
    state.accountId !== accountId ||
    state.dismissed
  ) {
    return null
  }

  return (
    <div
      role="note"
      data-testid="bounded-sync-notice"
      className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground"
    >
      <History className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        First sync for this account was limited to {state.windowLabel} — older
        mail is still on the server. New mail syncs normally.
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        aria-label="Dismiss the first-sync notice"
        data-testid="bounded-sync-notice-dismiss"
        onClick={() => {
          const next = { ...state, dismissed: true }
          setState(next)
          void dismissBoundedFirstSyncNotice(
            getThreadListExecutor(),
            accountId
          ).catch((error: unknown) => {
            console.warn("[bounded-sync] notice dismissal failed", error)
          })
        }}
      >
        <X aria-hidden />
      </Button>
    </div>
  )
}
