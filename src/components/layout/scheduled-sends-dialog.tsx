import { useEffect, useState } from "react"
import { Clock, Pencil, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { useAccountStore } from "@/stores/account-store"
import {
  parseScheduledRecipients,
  type ScheduledSendRow,
} from "@/services/db/scheduled-sends"
import {
  cancelScheduledSendById,
  editScheduledSend,
  summarizeRecipients,
  useScheduledSends,
} from "./use-scheduled-sends"
import { formatSnoozedUntil } from "./use-snoozed-threads"

/**
 * The Scheduled sidebar section + dialog (tasks 10.1/10.3). A scheduled
 * send is NOT a threads view — rows are pending sends for the active
 * account (recipient summary, subject, due time), each with Edit (back
 * into the composer; the schedule is cancelled until re-sent) and Cancel
 * — plus a muted history group of sent/failed rows (the schema keeps the
 * rows). The pending copy tells the timing truth: a past-due row reads
 * "Due — sends within a minute" (the runner fires it on the next 60s
 * tick while the app runs), and a claimed row ('sending' — its op queued
 * through an offline hold or retry backoff) reads "Queued — will send
 * when online".
 *
 * This is deliberately a dialog from a sidebar entry, not a ViewSelection
 * or list scope: there is no threads query behind it, and the view/scope
 * unions stay untouched. The entry renders whenever the sidebar is
 * expanded (like Labels) so the surface is discoverable before the first
 * scheduled send exists; the badge counts pending sends.
 */

function RecipientSummary({ row }: { row: ScheduledSendRow }) {
  const summary = summarizeRecipients(
    parseScheduledRecipients(row.recipients_json)
  )
  return (
    <span className="truncate text-xs text-muted-foreground">
      {summary === "" ? "(no recipients)" : summary}
    </span>
  )
}

/** How often the dialog's clock re-samples while it is open: a row
 * crossing its due time (or the reverse) flips its copy within half a
 * minute without waiting for a list reload. */
const NOW_REFRESH_INTERVAL_MS = 30_000

function PendingRow({
  row,
  now,
  busy,
  onEdit,
  onCancel,
}: {
  row: ScheduledSendRow
  now: number
  busy: boolean
  onEdit: (row: ScheduledSendRow) => void
  onCancel: (row: ScheduledSendRow) => void
}) {
  const title = row.subject || "(no subject)"
  return (
    <div
      data-testid="scheduled-send-row"
      className="flex w-full items-center gap-0.5 rounded-md pr-0.5 hover:bg-accent/50"
    >
      <div className="flex min-w-0 flex-1 flex-col px-2 py-1">
        <span className="truncate text-sm">{title}</span>
        <RecipientSummary row={row} />
        <span
          data-testid="scheduled-due-time"
          className="text-xs text-muted-foreground tabular-nums"
        >
          {row.due_at <= now
            ? "Due — sends within a minute"
            : `Will send ${formatSnoozedUntil(row.due_at)}`}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Edit scheduled send ${title}`}
        disabled={busy}
        onClick={() => onEdit(row)}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Cancel scheduled send ${title}`}
        disabled={busy}
        onClick={() => onCancel(row)}
      >
        <X />
      </Button>
    </div>
  )
}

/**
 * A claimed row ('sending'): its op is queued and the queue still owns
 * it, so the honest copy is "will send when online". It stays visible —
 * and cancellable (the pre-transmit re-check drops the transmission) —
 * instead of vanishing from the view while it waits.
 */
function QueuedRow({
  row,
  busy,
  onCancel,
}: {
  row: ScheduledSendRow
  busy: boolean
  onCancel: (row: ScheduledSendRow) => void
}) {
  const title = row.subject || "(no subject)"
  return (
    <div
      data-testid="scheduled-send-queued-row"
      className="flex w-full items-center gap-0.5 rounded-md pr-0.5 hover:bg-accent/50"
    >
      <div className="flex min-w-0 flex-1 flex-col px-2 py-1">
        <span className="truncate text-sm">{title}</span>
        <RecipientSummary row={row} />
        <span
          data-testid="scheduled-queued-time"
          className="text-xs text-muted-foreground tabular-nums"
        >
          Queued — will send when online
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Cancel scheduled send ${title}`}
        disabled={busy}
        onClick={() => onCancel(row)}
      >
        <X />
      </Button>
    </div>
  )
}

function HistoryRow({ row }: { row: ScheduledSendRow }) {
  const title = row.subject || "(no subject)"
  return (
    <div
      data-testid="scheduled-send-history-row"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 opacity-70"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {row.status === "sent"
            ? row.sent_at !== null
              ? `Sent ${formatSnoozedUntil(row.sent_at)}`
              : "Sent"
            : row.last_error
              ? `Failed — ${row.last_error}`
              : "Failed"}
        </span>
      </div>
      <span className="shrink-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {row.status === "sent" ? "Sent" : "Failed"}
      </span>
    </div>
  )
}

function ScheduledSendsDialog({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void
}) {
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const rows = useScheduledSends(activeAccountId)
  const pending = rows.filter((row) => row.status === "scheduled")
  const queued = rows.filter((row) => row.status === "sending")
  const history = rows.filter(
    (row) => row.status === "sent" || row.status === "failed"
  )
  const [busyId, setBusyId] = useState<string | null>(null)
  // The dialog's clock: sampled on mount, then refreshed on a 30s interval
  // for as long as the dialog stays open (cleared when it closes), so a
  // row crossing its due time flips to the due copy without a reload.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000))
    }, NOW_REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  const handleCancel = (row: ScheduledSendRow): void => {
    setBusyId(row.id)
    void (async () => {
      const cancelled = await cancelScheduledSendById(row.id)
      if (cancelled) {
        toast.success("Scheduled send cancelled")
      } else {
        toast.error("Could not cancel the scheduled send.")
        setBusyId(null)
      }
    })()
  }

  const handleEdit = (row: ScheduledSendRow): void => {
    setBusyId(row.id)
    void (async () => {
      const restored = await editScheduledSend(row)
      if (restored) {
        onOpenChange(false)
      } else {
        toast.error("Could not restore the scheduled message for editing.")
        setBusyId(null)
      }
    })()
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-testid="scheduled-sends-dialog">
        <DialogHeader>
          <DialogTitle>Scheduled sends</DialogTitle>
          <DialogDescription>
            Messages send while the app is running — one that comes due while
            Emailer is closed will send at the next launch.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-96 flex-col gap-1 overflow-y-auto">
          {pending.length === 0 && queued.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              No scheduled sends.
            </p>
          ) : (
            pending.map((row) => (
              <PendingRow
                key={row.id}
                row={row}
                now={now}
                busy={busyId === row.id}
                onEdit={handleEdit}
                onCancel={handleCancel}
              />
            ))
          )}
          {queued.length > 0 ? (
            <>
              <Separator className="my-1" />
              <p className="px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Queued — will send when online
              </p>
              {queued.map((row) => (
                <QueuedRow
                  key={row.id}
                  row={row}
                  busy={busyId === row.id}
                  onCancel={handleCancel}
                />
              ))}
            </>
          ) : null}
          {history.length > 0 ? (
            <>
              <Separator className="my-1" />
              <p className="px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                History
              </p>
              {history.map((row) => (
                <HistoryRow key={row.id} row={row} />
              ))}
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The sidebar entry (expanded layout only, like the other sections). */
export function ScheduledSendsSection() {
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const rows = useScheduledSends(activeAccountId)
  // Both cancellable states count as pending: a claimed row still waits
  // for its queue op, so the badge keeps showing it.
  const pendingCount = rows.filter(
    (row) => row.status === "scheduled" || row.status === "sending"
  ).length
  const [open, setOpen] = useState(false)

  return (
    <>
      <Separator />
      <nav
        aria-label="Scheduled"
        data-testid="scheduled-section"
        className="grid items-start gap-0.5 p-2"
      >
        <button
          type="button"
          className="flex w-full items-center justify-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
          onClick={() => setOpen(true)}
        >
          <Clock aria-hidden />
          Scheduled
          {pendingCount > 0 && (
            <span
              data-testid="scheduled-count"
              className="ml-auto rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums"
            >
              {pendingCount}
            </span>
          )}
        </button>
      </nav>
      {open && <ScheduledSendsDialog onOpenChange={setOpen} />}
    </>
  )
}
