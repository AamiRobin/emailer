import { formatDistanceToNow } from "date-fns"
import { AlertCircleIcon, Loader2Icon, RefreshCwIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { useSyncStore } from "@/stores/sync-store"

/**
 * Last-synced indicator (task 4.4): relative "Synced X ago", a spinner
 * while the account syncs, and an error glyph when the last pass failed.
 * Mount wiring lives in the mail shell, which renders one instance per
 * active account in the mailbox-pane header (mail-shell.tsx, task 6.8);
 * this component is a pure consumer of the sync store's
 * `perAccount[accountId]` state. Nothing hydrates here: the sync
 * scheduler drives setSyncing/setSynced/setError around each pass, and
 * the boot path (services/bootstrap.ts) seeds `lastSyncAt` from the
 * accounts table via the store's hydrateFromAccounts action.
 */
export function SyncIndicator({
  accountId,
  className,
}: {
  accountId: string
  className?: string
}) {
  const status = useSyncStore(
    (state) => state.perAccount[accountId]?.status ?? "idle"
  )
  const lastSyncAt = useSyncStore(
    (state) => state.perAccount[accountId]?.lastSyncAt
  )
  const error = useSyncStore((state) => state.perAccount[accountId]?.error)

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-muted-foreground",
        className
      )}
      title={error}
    >
      {status === "syncing" ? (
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
      ) : status === "error" ? (
        <AlertCircleIcon
          className="size-3.5 text-destructive"
          aria-hidden="true"
        />
      ) : (
        <RefreshCwIcon className="size-3.5" aria-hidden="true" />
      )}
      <span className="truncate text-xs whitespace-nowrap">
        {lastSyncAt
          ? `Synced ${formatDistanceToNow(new Date(lastSyncAt * 1000), {
              addSuffix: true,
            })}`
          : "Not synced yet"}
      </span>
      <span className="sr-only">
        {status === "error"
          ? "Last sync failed"
          : status === "syncing"
            ? "Syncing now"
            : "Up to date"}
      </span>
    </div>
  )
}
