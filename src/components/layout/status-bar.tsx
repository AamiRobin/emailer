import { PendingOpsBadge } from "@/components/layout/pending-ops-badge"
import { SyncIndicator } from "@/components/layout/sync-indicator"
import { useActiveAccount } from "@/stores/account-store"

/**
 * Bottom status bar: the sync state (task 4.4) and queued-op count
 * (6.8) on the left, the app version on the right. The indicators moved
 * here from the sidebar footer, which keeps only the account/settings
 * controls. The sync text hides with no active account (nothing to
 * sync); the version comes from tauri.conf.json via the build-time
 * `__APP_VERSION__` define.
 */
export function StatusBar() {
  const activeAccount = useActiveAccount()
  return (
    <footer
      data-testid="status-bar"
      className="flex h-7 shrink-0 items-center justify-between gap-2 border-t bg-sidebar px-3 text-xs text-muted-foreground"
    >
      <div className="flex min-w-0 items-center gap-2">
        {activeAccount && (
          <SyncIndicator accountId={activeAccount.id} className="min-w-0" />
        )}
        <PendingOpsBadge />
      </div>
      <span className="shrink-0 tabular-nums">v{__APP_VERSION__}</span>
    </footer>
  )
}
