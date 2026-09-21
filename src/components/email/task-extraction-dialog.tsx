import { useCallback, useEffect, useState } from "react"
import { format, fromUnixTime } from "date-fns"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "sonner"

import { getExecutor } from "@/services/db/executor"
import {
  extractTasks,
  type TaskSuggestion,
} from "@/services/ai/task-extraction"
import { createTaskFromSuggestion } from "@/services/tasks/create"

/**
 * The task-extraction review dialog (task 4.8, ai-assistance spec "Task
 * extraction"). Opened from the reading-pane toolbar's "Suggest tasks"
 * button (thread-view.tsx, rendered only when AI is configured and the
 * taskExtraction surface is enabled), it runs the extraction
 * (services/ai/task-extraction.ts, cached per design D2) and presents the
 * suggestions FOR REVIEW: per-item checkbox pre-checked, source line
 * (sender + date — the eventual task's back-link), an "Add N tasks"
 * accept button and a per-item Add button.
 *
 * Nothing is created until the user accepts: accepted suggestions go
 * through the frozen `services/tasks/create` seam one at a time —
 * un-checked (rejected) items are never passed to the seam, and closing
 * the dialog discards everything. Since task 5.6 (verified in task 5.8)
 * that seam creates REAL tasks through the same service path manual
 * creation uses, so a successful accept lands a task row with the source
 * links. The frozen union's `{ ok: false, reason: "unavailable" }`
 * branch can no longer fire through the real seam (creation failures
 * throw instead) — the dialog keeps it purely as a defensive path (one
 * frozen-text toast per batch, item dismissed) in case a seam
 * implementation ever reintroduces a non-throwing failure.
 *
 * Failure handling follows the AI spec: provider errors render inline with
 * a Retry affordance; a parse warning renders inline above the (possibly
 * empty) list. The dialog notes that suggestions are AI-generated (spec:
 * indicate AI-generated content).
 */

/**
 * Defensive toast for the frozen "unavailable" result (frozen text) —
 * unreachable via the real seam since task 5.6 (see module doc).
 */
const TASKS_UNAVAILABLE_TOAST = "The Tasks module arrives in a later update"

/** What happened to a suggestion the user acted on. */
type HandledState = "added" | "dismissed"

interface TaskExtractionDialogProps {
  threadId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function TaskExtractionDialog({
  threadId,
  open,
  onOpenChange,
}: TaskExtractionDialogProps) {
  const [phase, setPhase] = useState<"extracting" | "ready" | "error">(
    "extracting"
  )
  const [suggestions, setSuggestions] = useState<TaskSuggestion[]>([])
  const [warning, setWarning] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  /** Per-item review state; every fresh suggestion starts checked. */
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set())
  const [handled, setHandled] = useState<Record<string, HandledState>>({})
  /** An accept batch is in flight (buttons disabled while true). */
  const [accepting, setAccepting] = useState(false)
  /** Inline error from the accept path itself (the real seam throws —
   *  it never returns "unavailable"; see the module doc). */
  const [acceptError, setAcceptError] = useState<string | null>(null)

  const runExtraction = useCallback(() => {
    setPhase("extracting")
    setErrorMessage(null)
    setWarning(null)
    setSuggestions([])
    setCheckedIds(new Set())
    setHandled({})
    setAcceptError(null)
    try {
      extractTasks(getExecutor(), threadId)
        .then((result) => {
          setSuggestions(result.suggestions)
          setWarning(result.warning ?? null)
          setCheckedIds(
            new Set(result.suggestions.map((item) => item.messageId))
          )
          setPhase("ready")
        })
        .catch((error: unknown) => {
          setErrorMessage(
            error instanceof Error ? error.message : "Task extraction failed."
          )
          setPhase("error")
        })
    } catch {
      // No executor (plain vite / early startup) — same inline-error path.
      setErrorMessage("Task extraction is unavailable right now.")
      setPhase("error")
    }
  }, [threadId])

  // Fresh extraction on every open; Retry re-runs the same callback. The
  // synchronous reset is intentional — a deferred run would flash the
  // previous review state while the new extraction starts — so this uses
  // the same sanctioned set-state-in-effect escape hatch as
  // attachment-strip.tsx.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      runExtraction()
    }
  }, [open, runExtraction])

  /**
   * Accept the given suggestion ids (the batch button passes all checked
   * ids, a row's Add button just its own). Each id goes to the seam
   * individually and lands a real task row (task 5.6's seam, verified in
   * task 5.8); a seam throw leaves the item actionable for retry, and
   * the union's "unavailable" branch — dead through the real seam — is
   * kept defensive: dismissed + one frozen toast per batch.
   * Unchecked/untouched items are never sent: rejecting creates nothing.
   */
  const acceptSuggestions = useCallback(
    (ids: string[]) => {
      if (accepting || ids.length === 0) return
      const targets = suggestions.filter(
        (item) => handled[item.messageId] === undefined && ids.includes(item.messageId)
      )
      if (targets.length === 0) return
      setAccepting(true)
      setAcceptError(null)
      try {
        void (async () => {
          let unavailableCount = 0
          let failureCount = 0
          const handledNext: Record<string, HandledState> = {}
          for (const item of targets) {
            try {
              const result = await createTaskFromSuggestion(getExecutor(), {
                title: item.title,
                ...(item.notes !== undefined ? { notes: item.notes } : {}),
                ...(item.dueAt !== undefined ? { dueAt: item.dueAt } : {}),
                sourceMessageId: item.messageId,
                sourceThreadId: threadId,
                origin: "ai",
              })
              if (result.ok) {
                handledNext[item.messageId] = "added"
              } else {
                unavailableCount += 1
                handledNext[item.messageId] = "dismissed"
              }
            } catch {
              // The seam throwing is not a review verdict — leave the
              // suggestion actionable so the user can retry it.
              failureCount += 1
            }
          }
          setHandled((previous) => ({ ...previous, ...handledNext }))
          if (unavailableCount > 0) {
            // One toast per batch — N toasts for N items is noise.
            toast.info(TASKS_UNAVAILABLE_TOAST)
          }
          if (failureCount > 0) {
            setAcceptError(
              `${failureCount} suggestion${
                failureCount === 1 ? "" : "s"
              } could not be added. Try again.`
            )
          }
          setAccepting(false)
        })()
      } catch {
        // getExecutor() unavailable — nothing was created; recover the UI.
        setAcceptError("Tasks cannot be added right now. Try again.")
        setAccepting(false)
      }
    },
    [accepting, suggestions, handled, threadId]
  )

  const toggleChecked = (messageId: string, checked: boolean) => {
    setCheckedIds((previous) => {
      const next = new Set(previous)
      if (checked) next.add(messageId)
      else next.delete(messageId)
      return next
    })
  }

  const pendingCheckedIds = suggestions
    .filter(
      (item) =>
        checkedIds.has(item.messageId) && handled[item.messageId] === undefined
    )
    .map((item) => item.messageId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="task-extraction-dialog"
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Suggested tasks</DialogTitle>
          <DialogDescription>
            AI-generated suggestions from this conversation — review each one
            before adding. Nothing is created until you accept.
          </DialogDescription>
        </DialogHeader>
        {phase === "extracting" && (
          <div
            data-testid="task-extraction-busy"
            className="py-6 text-center text-sm text-muted-foreground"
          >
            Reviewing the conversation for tasks…
          </div>
        )}
        {phase === "error" && (
          <div
            data-testid="task-extraction-error"
            className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
          >
            <span className="text-destructive">
              {errorMessage ?? "Task extraction failed."}
            </span>
            <Button
              variant="outline"
              size="sm"
              data-testid="task-extraction-retry"
              onClick={runExtraction}
            >
              Retry
            </Button>
          </div>
        )}
        {phase === "ready" && (
          <>
            {warning !== null && (
              <div
                data-testid="task-extraction-warning"
                className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
              >
                {warning}
              </div>
            )}
            {acceptError !== null && (
              <div
                data-testid="task-extraction-accept-error"
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
              >
                {acceptError}
              </div>
            )}
            {suggestions.length === 0 ? (
              <div
                data-testid="task-extraction-empty"
                className="py-6 text-center text-sm text-muted-foreground"
              >
                No task suggestions were found in this conversation.
              </div>
            ) : (
              <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
                {suggestions.map((item, index) => (
                  <SuggestionRow
                    key={item.messageId}
                    suggestion={item}
                    index={index}
                    checked={checkedIds.has(item.messageId)}
                    handled={handled[item.messageId]}
                    disabled={accepting}
                    onToggle={(checked) =>
                      toggleChecked(item.messageId, checked)
                    }
                    onAccept={() => acceptSuggestions([item.messageId])}
                  />
                ))}
              </div>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                aria-label="Close task suggestions"
              >
                Close
              </Button>
              <Button
                data-testid="task-extraction-accept"
                disabled={accepting || pendingCheckedIds.length === 0}
                onClick={() => acceptSuggestions(pendingCheckedIds)}
              >
                Add {pendingCheckedIds.length} task
                {pendingCheckedIds.length === 1 ? "" : "s"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** One review row: checkbox, suggestion summary, source line, Add. */
function SuggestionRow({
  suggestion,
  index,
  checked,
  handled,
  disabled,
  onToggle,
  onAccept,
}: {
  suggestion: TaskSuggestion
  index: number
  checked: boolean
  /** undefined while still reviewable; "added"/"dismissed" once acted on. */
  handled: "added" | "dismissed" | undefined
  disabled: boolean
  onToggle: (checked: boolean) => void
  onAccept: () => void
}) {
  const isHandled = handled !== undefined
  return (
    <div
      data-testid={`task-suggestion-${index}`}
      className={`flex items-start gap-2.5 rounded-lg border border-border p-2.5 ${
        isHandled ? "opacity-55" : ""
      }`}
    >
      <Checkbox
        checked={!isHandled && checked}
        disabled={isHandled || disabled}
        onCheckedChange={(next) => onToggle(next === true)}
        aria-label={`Include "${suggestion.title}"`}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug">{suggestion.title}</p>
        {suggestion.notes !== undefined && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {suggestion.notes}
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {suggestion.dueAt !== undefined && (
            <span data-testid={`task-suggestion-due-${index}`}>
              Due {format(fromUnixTime(suggestion.dueAt), "MMM d, yyyy")} ·{" "}
            </span>
          )}
          <span data-testid={`task-suggestion-source-${index}`}>
            From {suggestion.messageFrom} ·{" "}
            {format(fromUnixTime(suggestion.messageDate), "MMM d, yyyy")}
          </span>
        </p>
      </div>
      {isHandled ? (
        <span
          data-testid={`task-suggestion-state-${index}`}
          className="shrink-0 pt-1 text-xs text-muted-foreground"
        >
          {handled === "added" ? "Added" : "Dismissed"}
        </span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          data-testid={`task-suggestion-add-${index}`}
          disabled={disabled}
          aria-label={`Add "${suggestion.title}"`}
          onClick={onAccept}
        >
          Add
        </Button>
      )}
    </div>
  )
}
