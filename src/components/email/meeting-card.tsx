import { useEffect, useState } from "react"
import {
  CalendarX2,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  MapPin,
  Users,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { getExecutor } from "@/services/db/executor"
import type { SqlExecutor } from "@/services/db/executor"
import type { MessageRow } from "@/services/db/messages"
import type { EmailAccount } from "@/services/email/types"
import { describeIcsEventTime } from "@/services/calendar/ics"
import { detectInvite } from "@/services/calendar/invites"
import type { DetectedInvite, LinkedEventInfo } from "@/services/calendar/invites"
import type { AttachmentDeps } from "@/services/attachments"
import {
  respondToInvite,
  rsvpAnswerBadgeClass,
  rsvpAnswerLabel,
  type RsvpAnswer,
  type RsvpScope,
} from "@/services/calendar/rsvp"

/**
 * MeetingInviteCard (parity-round-3 task 8.2, design D5): the meeting
 * card in the reading pane. SELF-GATING — the card loads the message's
 * text/calendar part through the invites service on mount and renders
 * NOTHING for non-invites (spec: a non-invite message is untouched);
 * an invitation renders title/time/location/organizer/attendees/join
 * link with Accept/Tentative/Decline.
 *
 * Every mail account gets the card — with or without a connected
 * calendar (spec: "No calendar connection"): without one the buttons
 * only send the organizer REPLY mail (the RSVP flow reports the skipped
 * write-back); with one, the source's write-back rides along.
 *
 * States:
 * - METHOD:CANCEL invites render the cancelled state — the thread's
 *   invitation card shows the meeting was cancelled (spec) — with no
 *   answer buttons.
 * - A recorded answer (the linked row's partstat, else the invite's own
 *   PARTSTAT for this user) renders as the current-status badge.
 * - Recurring invitations carrying a RECURRENCE-ID offer the
 *   occurrence-vs-series choice (default: whole series, the task's
 *   scoping rule) and pass it through write-back + REPLY.
 *
 * Failure surfacing (spec: answer never lost, send failures retryable):
 * a write-back failure toasts its message while the queued REPLY
 * proceeds; a REPLY failure toasts the retryable-send note — the answer
 * itself is always already stamped on the calendar event.
 */

/** Injectable seams (tests): db, detection, RSVP, link opening. */
export interface MeetingCardDeps {
  executor?: SqlExecutor
  detect?: typeof detectInvite
  respond?: typeof respondToInvite
  openUrl?: (url: string) => void | Promise<void>
}

export function MeetingInviteCard({
  message,
  account,
  attachmentDeps,
  deps = {},
}: {
  message: MessageRow
  account: EmailAccount | null
  /** Attachment seam for the calendar-part content (production: the D15
   * attachment deps; the detection degrades to nothing without one). */
  attachmentDeps?: AttachmentDeps
  deps?: MeetingCardDeps
}) {
  const [invite, setInvite] = useState<DetectedInvite | null>(null)
  const [busy, setBusy] = useState(false)
  /** The occurrence-vs-series choice (only offered when the invite
   * carries a RECURRENCE-ID); the series is the default. */
  const [scope, setScope] = useState<RsvpScope>("series")

  useEffect(() => {
    if (!account) return
    let cancelled = false
    const detect = deps.detect ?? detectInvite
    void (async () => {
      try {
        const executor = deps.executor ?? (await getExecutor())
        const detected = await detect(executor, account, message, {
          attachmentDeps,
        })
        if (!cancelled) setInvite(detected)
      } catch (error) {
        // No db / unreadable part — the card simply does not render.
        console.warn("[meeting-card] invite detection failed", error)
        if (!cancelled) setInvite({ ok: false, reason: "unreadable" })
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id, message.id])

  // Narrowed locals: the async respond closure and the JSX below cannot
  // see through the guard's narrowing of the prop/state unions.
  const activeAccount = account
  const current = invite && invite.ok ? invite : null
  if (!activeAccount || !current) return null

  const { event, kind, linkedEvent, joinLink, currentPartstat } = current
  const time = describeIcsEventTime(event.start, event.end)
  const isCancelled = kind === "cancel"

  // A const arrow (not a hoisted declaration) so TS keeps the narrowed
  // account/invite types inside the closure.
  const handleRespond = async (answer: RsvpAnswer): Promise<void> => {
    if (busy || !event.uid) return
    setBusy(true)
    try {
      const respond = deps.respond ?? respondToInvite
      const executor = deps.executor ?? (await getExecutor())
      const outcome = await respond(
        executor,
        activeAccount.id,
        {
          uid: event.uid!,
          event,
          row: linkedEvent
            ? {
                rowId: linkedEvent.rowId,
                sourceId: linkedEvent.sourceId,
                provider: linkedEvent.provider,
                uid: linkedEvent.uid,
                calendarId: linkedEvent.calendarId,
              }
            : null,
        },
        answer,
        scope
      )
      if (outcome.reply.status === "queued") {
        if (outcome.writeBack.status === "applied") {
          toast.success(
            `Response ${answer === "yes" ? "accepted" : answer === "no" ? "declined" : "marked tentative"} — calendar updated, reply queued`
          )
        } else if (outcome.writeBack.status === "failed") {
          toast.warning(
            `Reply to the organizer queued, but the calendar update failed: ${outcome.writeBack.message}`
          )
        } else {
          toast.success("Reply to the organizer queued")
        }
        setInvite(refreshAnswer(current, linkedEvent, answer))
      } else {
        // Queued-send failure: the standard retryable queued-send path
        // owns it; the answer stays recorded either way.
        toast.error(
          `The response mail could not be queued: ${outcome.reply.message}`
        )
      }
    } catch (error) {
      console.warn("[meeting-card] RSVP failed", error)
      toast.error("The response could not be sent.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-testid="meeting-card"
      data-invite-kind={kind}
      className={cn(
        "rounded-lg border p-3",
        isCancelled
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-muted/30"
      )}
    >
      <div className="flex items-start gap-2">
        {isCancelled ? (
          <CalendarX2 className="mt-0.5 size-4 shrink-0 text-destructive" />
        ) : (
          <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              data-testid="meeting-card-title"
              className={cn(
                "text-sm font-semibold text-foreground",
                isCancelled && "line-through"
              )}
            >
              {event.summary ?? "(untitled meeting)"}
            </span>
            {isCancelled && (
              <Badge
                variant="outline"
                data-testid="meeting-card-cancelled"
                className="border-destructive/30 bg-destructive/10 text-destructive"
              >
                Cancelled
              </Badge>
            )}
            {!isCancelled && currentPartstat && (
              <Badge
                variant="outline"
                data-testid="meeting-card-answer"
                data-partstat={currentPartstat}
                className={rsvpAnswerBadgeClass(currentPartstat)}
              >
                {rsvpAnswerLabel(currentPartstat)}
              </Badge>
            )}
          </div>
          {time && (
            <p
              data-testid="meeting-card-time"
              className="text-xs tabular-nums text-muted-foreground"
            >
              {time}
            </p>
          )}
          {(event.location || joinLink) && (
            <p className="flex items-center gap-1 text-xs text-foreground">
              <MapPin className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{event.location ?? joinLink?.url}</span>
            </p>
          )}
          {event.organizer && (
            <p
              data-testid="meeting-card-organizer"
              className="truncate text-xs text-muted-foreground"
            >
              Organizer: {describePerson(event.organizer)}
            </p>
          )}
          {event.attendees.length > 0 && (
            <p
              data-testid="meeting-card-attendees"
              className="flex items-start gap-1 text-xs text-muted-foreground"
            >
              <Users className="mt-0.5 size-3 shrink-0" />
              <span className="line-clamp-2">
                {event.attendees.map(describePerson).filter(Boolean).join(", ")}
              </span>
            </p>
          )}
        </div>
      </div>

      {/* Join link (task 8.4): the curated extractor's result, opened in
          the OS browser through the existing opener path. */}
      {joinLink && !isCancelled && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 gap-1"
          data-testid="meeting-card-join"
          onClick={() => {
            if (!joinLink.url) return
            void Promise.resolve(
              deps.openUrl ? deps.openUrl(joinLink.url) : openJoinLink(joinLink.url)
            ).catch((error) => {
              console.warn("[meeting-card] join-link open failed", error)
            })
          }}
        >
          <ExternalLink className="size-3.5" />
          Join{joinLink.url ? ` — ${joinLink.label}` : ` (${joinLink.label})`}
        </Button>
      )}

      {/* Recurring invitation: the occurrence-vs-series choice (task
          8.3). The series is the default; the RECURRENCE-ID rides both
          the write-back and the REPLY when one occurrence is chosen. */}
      {!isCancelled && event.recurrenceId && (
        <div
          data-testid="meeting-card-scope"
          className="mt-2 flex items-center gap-1 text-xs text-muted-foreground"
        >
          <span>Respond to:</span>
          <Button
            variant={scope === "series" ? "secondary" : "ghost"}
            size="xs"
            data-testid="meeting-card-scope-series"
            aria-pressed={scope === "series"}
            onClick={() => setScope("series")}
          >
            Whole series
          </Button>
          <Button
            variant={scope === "occurrence" ? "secondary" : "ghost"}
            size="xs"
            data-testid="meeting-card-scope-occurrence"
            aria-pressed={scope === "occurrence"}
            onClick={() => setScope("occurrence")}
          >
            This occurrence
          </Button>
        </div>
      )}

      {!isCancelled && (
        <div className="mt-2 flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            data-testid="meeting-card-accept"
            disabled={busy}
            onClick={() => void handleRespond("yes")}
          >
            <CircleCheck className="size-3.5 text-emerald-600" />
            Accept
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            data-testid="meeting-card-tentative"
            disabled={busy}
            onClick={() => void handleRespond("maybe")}
          >
            <CircleDashed className="size-3.5 text-amber-600" />
            Tentative
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-destructive hover:text-destructive"
            data-testid="meeting-card-decline"
            disabled={busy}
            onClick={() => void handleRespond("no")}
          >
            <CircleX className="size-3.5" />
            Decline
          </Button>
        </div>
      )}
      {!isCancelled && !linkedEvent && (
        <p
          data-testid="meeting-card-no-calendar"
          className="mt-1.5 text-xs text-muted-foreground"
        >
          No connected calendar for this event — your answer is sent to the
          organizer by email.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** openJoinLink — the existing link-opening path (task 7.4's opener
 * routing sends http(s) to the OS browser). */
async function openJoinLink(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener")
  await openUrl(url)
}

/** "Jane Doe <jane@x>" / email / name fallback (the ics.ts rule). */
function describePerson(person: {
  name: string | null
  email: string | null
}): string {
  if (person.name && person.email) return `${person.name} <${person.email}>`
  return person.email ?? person.name ?? ""
}

/** After a successful respond, flip the card's badge locally (the db
 * already carries it; a remount would re-read the same value). */
function refreshAnswer(
  invite: DetectedInvite & { ok: true },
  linkedEvent: LinkedEventInfo | null,
  answer: RsvpAnswer
): DetectedInvite {
  const partstat =
    answer === "yes" ? "ACCEPTED" : answer === "no" ? "DECLINED" : "TENTATIVE"
  return {
    ...invite,
    currentPartstat: partstat,
    ...(linkedEvent !== null
      ? { linkedEvent: { ...linkedEvent, partstat } }
      : {}),
  }
}
