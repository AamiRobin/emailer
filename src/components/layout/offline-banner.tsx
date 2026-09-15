import { WifiOffIcon } from "lucide-react"

import { useOnlineStore } from "@/stores/online-store"

/**
 * Offline banner (task 6.8, mailbox-ui spec "Offline banner"): a visible,
 * non-blocking indicator shown while the device is offline — it overlays
 * the top edge instead of displacing the layout, so the local-first
 * mailbox keeps working underneath. Reads the online store, which the
 * shell keeps in sync with initOnlineTracking (services/online).
 */
export function OfflineBanner() {
  const online = useOnlineStore((state) => state.online)
  if (online) return null
  return (
    <div
      role="status"
      data-testid="offline-banner"
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 border-b bg-muted/95 px-4 py-1.5 text-sm text-foreground backdrop-blur"
    >
      <WifiOffIcon aria-hidden="true" className="size-4 shrink-0" />
      <span>You're offline — changes will sync when you reconnect</span>
    </div>
  )
}
