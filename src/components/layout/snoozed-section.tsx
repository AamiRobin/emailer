import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useAccountStore } from "@/stores/account-store"
import {
  cancelSnooze,
  formatSnoozedUntil,
  useSnoozedThreads,
} from "./use-snoozed-threads"

/**
 * The Snoozed sidebar section (task 2.4): the account's snoozed threads
 * with their wake-up times, each row offering a cancel (unsnooze)
 * button. Navigation into a dedicated view is deliberately out of scope
 * — there is no "snoozed" ViewSelection yet and the section is a live
 * inventory, not a folder.
 *
 * Renders only while the account holds snoozed threads, and — like the
 * labels section — yields to the icon rail (mounted expanded-only by the
 * sidebar). Data flows through useSnoozedThreads (./use-snoozed-threads,
 * the use-sidebar-data.ts pattern).
 */
export function SnoozedSection() {
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const snoozed = useSnoozedThreads(activeAccountId)
  if (snoozed.length === 0) return null
  return (
    <>
      <Separator />
      <nav
        aria-label="Snoozed"
        data-testid="snoozed-section"
        className="grid items-start gap-0.5 p-2"
      >
        <p className="px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Snoozed
        </p>
        {snoozed.map((thread) => {
          const subject = thread.subject || "(no subject)"
          return (
            <div
              key={thread.id}
              data-testid="snoozed-thread-row"
              className="group/snoozed flex w-full items-center gap-0.5 rounded-md pr-0.5 hover:bg-accent/50"
            >
              <div className="flex min-w-0 flex-1 flex-col px-2 py-1">
                <span className="truncate text-sm">{subject}</span>
                <span
                  data-testid="snoozed-wake-time"
                  className="text-xs text-muted-foreground tabular-nums"
                >
                  {thread.snoozed_until == null
                    ? ""
                    : formatSnoozedUntil(thread.snoozed_until)}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Cancel snooze for ${subject}`}
                onClick={() => {
                  void cancelSnooze(thread.id)
                }}
              >
                <X />
              </Button>
            </div>
          )
        })}
      </nav>
    </>
  )
}
