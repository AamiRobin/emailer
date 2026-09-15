import { useEffect, useState } from "react"
import { ClockIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { getExecutor } from "@/services/db/executor"
import { countPendingOperationsByAccount } from "@/services/db/pending-operations"

/**
 * Pending-operations indicator (task 6.8): shows the offline mutation
 * queue depth (`pending_operations.status = 'pending'`, all accounts) as
 * a small header badge while anything is queued. The count is polled on
 * mount and every 30s — the queue is drained by the replay processor in
 * the background, so a light poll is enough for an indicator. The badge
 * is informational only: hovering shows "N pending changes", clicking is
 * a no-op. DB failures (e.g. no executor outside Tauri) are logged and
 * leave the badge hidden.
 */

/** Poll cadence for the queue-depth badge (indicator-grade freshness). */
const POLL_INTERVAL_MS = 30_000

export function PendingOpsBadge() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function poll(): Promise<void> {
      try {
        const rows = await countPendingOperationsByAccount(getExecutor())
        if (cancelled) return
        const pending = rows.reduce(
          (total, row) =>
            row.status === "pending" ? total + row.count : total,
          0
        )
        setCount(pending)
      } catch (error) {
        console.warn("[pending-ops-badge] count query failed", error)
      }
    }
    void poll()
    const timer = window.setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  if (count === 0) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="secondary"
            data-testid="pending-ops-badge"
            aria-label={`${count} pending changes`}
            className="cursor-default gap-0.5 tabular-nums"
          >
            <ClockIcon data-icon="inline-start" aria-hidden="true" />
            {count}
          </Badge>
        }
      />
      <TooltipContent>{count} pending changes</TooltipContent>
    </Tooltip>
  )
}
