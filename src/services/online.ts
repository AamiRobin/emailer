import { useOnlineStore } from "../stores/online-store"

/**
 * Online/offline detection (task 4.5). In the Tauri 2 webview,
 * navigator.onLine plus the window 'online'/'offline' events track the
 * host's connectivity. The zustand online store (src/stores/online-store.ts)
 * is the single source of truth: initOnlineTracking() mirrors the browser
 * events into it, services read isOnline(), UI components subscribe with
 * the hook, and non-React consumers (queue processor wiring) use
 * onOnlineChange/onBackOnline.
 */

const changeListeners = new Set<(online: boolean) => void>()

let tracking = false

function setOnlineState(online: boolean): void {
  const changed = useOnlineStore.getState().online !== online
  useOnlineStore.getState().setOnline(online)
  if (!changed) return
  for (const listener of changeListeners) {
    try {
      listener(online)
    } catch (error) {
      // A broken subscriber must not break the others or the store update.
      console.error("online-change listener failed", error)
    }
  }
}

function handleOnline(): void {
  setOnlineState(true)
}

function handleOffline(): void {
  setOnlineState(false)
}

/**
 * Start mirroring window connectivity events into the online store.
 * Idempotent (StrictMode mounts init paths twice in dev).
 */
export function initOnlineTracking(): void {
  if (tracking || typeof window === "undefined") return
  tracking = true
  setOnlineState(window.navigator.onLine)
  window.addEventListener("online", handleOnline)
  window.addEventListener("offline", handleOffline)
}

/** Current connectivity per the online store (defaults to navigator.onLine). */
export function isOnline(): boolean {
  return useOnlineStore.getState().online
}

/**
 * Subscribe to connectivity transitions (fires only on change). Returns an
 * unsubscribe function.
 */
export function onOnlineChange(
  listener: (online: boolean) => void
): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

/** Subscribe to "back online" transitions — the queue replay trigger. */
export function onBackOnline(listener: () => void): () => void {
  return onOnlineChange((online) => {
    if (online) listener()
  })
}

/** Test/cleanup seam: detach listeners and reset module state. */
export function resetOnlineTrackingForTests(): void {
  if (typeof window !== "undefined" && tracking) {
    window.removeEventListener("online", handleOnline)
    window.removeEventListener("offline", handleOffline)
  }
  tracking = false
  changeListeners.clear()
  useOnlineStore
    .getState()
    .setOnline(typeof navigator !== "undefined" ? navigator.onLine : true)
}
