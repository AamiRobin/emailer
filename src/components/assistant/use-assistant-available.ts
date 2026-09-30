import { useEffect, useState } from "react"

import { isAiConfigured, isSurfaceEnabled } from "@/services/ai/settings"
import { getExecutor } from "@/services/db/executor"

/**
 * Whether the assistant panel may appear (task 3.2's gate, shared shape):
 * provider configured AND the `assistant` surface enabled — best-effort,
 * failing toward hidden (outside Tauri / before the DB is up, the panel
 * stays closed rather than erroring). Lives in its own module so both the
 * shell (gating the whole ResizablePanel pair — a gated panel that
 * rendered an empty docked column would be dead chrome, task 7.5 smoke)
 * and the panel body can consume one implementation; a component file
 * must only export components (react-refresh).
 */
export function useAssistantAvailable(
  active: boolean,
  recheckKey: unknown = null
): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    // Re-read the gate on EVERY open (the categorization-assist idiom —
    // live settings edits must take effect on the next open), and reset
    // while closed: a once-at-boot check would pin the boot-time gate
    // forever (the shell mounts this surface exactly once). `recheckKey`
    // forces a re-read across changes that don't flip `active` — the
    // shell passes the active VIEW, so a surface disabled in settings
    // (panel flag still set) is re-gated on the return to the mailbox.
    if (!active) {
      // The closed-reset is deliberately synchronous — the panel must not
      // flash a stale "available" across an open/close cycle (the
      // smart-reply dialog's reset-on-open precedent).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAvailable(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const executor = getExecutor()
        const ok =
          (await isAiConfigured(executor)) &&
          (await isSurfaceEnabled(executor, "assistant"))
        if (!cancelled) setAvailable(ok)
      } catch {
        // Fail toward hidden — the mount must not break the shell.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, recheckKey])
  return available
}
