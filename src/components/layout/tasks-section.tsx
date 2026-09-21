import { useMemo, useState } from "react"
import { format, fromUnixTime, isToday, isTomorrow } from "date-fns"
import {
  ArrowDownUp,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { Task } from "@/services/tasks/service"
import { completeTaskById, openTaskSourceThread, useTasks } from "./use-tasks"

/**
 * The Tasks sidebar section (task 5.7, tasks spec "Tasks sidebar and
 * views", design D6 — "the sidebar section reuses the existing
 * sidebar-sections pattern"). The OPEN tasks across ALL accounts (the
 * tasks table is account-independent by design), sorted by due date or
 * creation order via the header toggle, each row showing its title and
 * formatted due date with the overdue state in the destructive tone
 * (spec "Overdue visibility"). The checkbox completes through
 * completeTaskById (use-tasks.ts — optimistic hide + refresh); a task
 * converted from email shows the source-link icon, which jumps to the
 * source thread through the existing deep routing (setActiveThread —
 * design D6 "the task link opens the source thread via existing deep
 * routing").
 *
 * "Today & overdue" is the spec's one-action entry point: one toggle
 * narrows the list to tasks due by the end of today (overdue ones
 * included) and carries the live count. The COMPLETED view is a
 * disclosure under the open list ("Completed (N)") listing the completed
 * instances with their completion dates — the service's completed rows.
 *
 * Unlike Todos/Snoozed this section renders ALWAYS (expanded layout only
 * — it yields to the icon rail like the other user sections) with an
 * empty state, because it is the task manager's home surface rather than
 * an ephemeral inventory. It deliberately coexists with the lightweight
 * Todos list (design D6 non-goals).
 */
export function TasksSection() {
  const [sort, setSort] = useState<"due" | "created">("due")
  const [todayOnly, setTodayOnly] = useState(false)
  const [completedOpen, setCompletedOpen] = useState(false)
  const { open, completed } = useTasks(sort)
  const todayCount = useMemo(
    () => open.filter(isTodayOrOverdue).length,
    [open]
  )
  const visible = useMemo(
    () => (todayOnly ? open.filter(isTodayOrOverdue) : open),
    [open, todayOnly]
  )
  return (
    <>
      <Separator />
      <nav
        aria-label="Tasks"
        data-testid="tasks-section"
        className="grid items-start gap-0.5 p-2"
      >
        <div className="flex items-center justify-between gap-1 pr-0.5">
          <p className="px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Tasks
          </p>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="tasks-sort-toggle"
            aria-label={
              sort === "due"
                ? "Sorted by due date — switch to creation order"
                : "Sorted by creation order — switch to due date"
            }
            title={
              sort === "due"
                ? "Sorted by due date — switch to creation order"
                : "Sorted by creation order — switch to due date"
            }
            onClick={() => setSort((current) => (current === "due" ? "created" : "due"))}
          >
            <ArrowDownUp />
          </Button>
        </div>
        {/* The spec's one-action entry point (tasks spec "Today's and
            overdue tasks SHALL be reachable in one action"): the pill is
            the live count of open tasks due by the end of today. */}
        <button
          type="button"
          data-testid="tasks-today-toggle"
          aria-pressed={todayOnly}
          className={cn(
            buttonRowClasses,
            todayOnly ? "bg-muted text-foreground" : "text-muted-foreground"
          )}
          onClick={() => setTodayOnly((value) => !value)}
        >
          Today &amp; overdue
          {todayCount > 0 && (
            <span className="ml-auto rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums">
              {todayCount}
            </span>
          )}
        </button>
        {visible.length === 0 ? (
          <p
            data-testid="tasks-empty"
            className="px-2 py-1 text-sm text-muted-foreground"
          >
            {todayOnly ? "Nothing due today" : "No open tasks"}
          </p>
        ) : (
          visible.map((task) => <TaskRow key={task.id} task={task} />)
        )}
        {/* The completed view (tasks spec "a completed view"): a bounded
            disclosure of the completed instances, most recent first, each
            with its completion date. */}
        {completed.length > 0 && (
          <>
            <button
              type="button"
              data-testid="tasks-completed-toggle"
              aria-expanded={completedOpen}
              className={cn(buttonRowClasses, "text-muted-foreground")}
              onClick={() => setCompletedOpen((value) => !value)}
            >
              {completedOpen ? (
                <ChevronDown className="size-3.5 shrink-0" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0" />
              )}
              Completed ({completed.length})
            </button>
            {completedOpen &&
              completed.map((task) => (
                <div
                  key={task.id}
                  data-testid="task-completed-row"
                  data-task-id={task.id}
                  className="flex min-w-0 items-center gap-1.5 py-1 pl-2 pr-2"
                >
                  <Check
                    aria-hidden
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground line-through">
                    {task.title}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {format(fromUnixTime(task.completedAt ?? task.createdAt), "MMM d")}
                  </span>
                </div>
              ))}
          </>
        )}
      </nav>
    </>
  )
}

/** Shared row-button styling for the section's full-width text rows. */
const buttonRowClasses =
  "flex w-full items-center gap-1 rounded-md px-2 py-1 text-start text-sm hover:bg-accent/50"

/**
 * The spec's one-action filter membership: open tasks due by the END of
 * today — which subsumes every overdue task (its due date already
 * passed) and adds the rest of today's, while due-less tasks stay out.
 */
function isTodayOrOverdue(task: Task): boolean {
  if (task.dueAt === null) return false
  return task.isOverdue || task.dueAt <= endOfTodaySeconds()
}

function endOfTodaySeconds(): number {
  const now = new Date()
  return Math.floor(
    new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59
    ).getTime() / 1000
  )
}

/** Due-date display: "Today 6:00 PM" / "Tomorrow 9:00 AM", else a short
 * date (the snoozed-section formatter's shape, minus the time beyond
 * tomorrow). */
function formatTaskDue(dueAt: number): string {
  const date = fromUnixTime(dueAt)
  if (isToday(date)) return format(date, "'Today' h:mm a")
  if (isTomorrow(date)) return format(date, "'Tomorrow' h:mm a")
  return format(date, "EEE, MMM d")
}

function TaskRow({ task }: { task: Task }) {
  const title = task.title
  const sourceThreadId = task.sourceThreadId
  const openSource = sourceThreadId
    ? () => openTaskSourceThread(sourceThreadId)
    : undefined
  return (
    <div
      data-testid="task-row"
      data-task-id={task.id}
      data-overdue={task.isOverdue ? "true" : "false"}
      className="group/task flex w-full items-center gap-0.5 rounded-md pr-0.5 hover:bg-accent/50"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="task-complete"
        aria-label={`Complete task ${title}`}
        onClick={() => {
          void completeTaskById(task.id)
        }}
      >
        <Check />
      </Button>
      {openSource ? (
        <button
          type="button"
          title="Open the source message"
          className="flex min-w-0 flex-1 flex-col px-0.5 py-1 text-start"
          onClick={openSource}
        >
          <span
            className={cn(
              "min-w-0 truncate text-sm",
              task.isOverdue && "text-destructive"
            )}
          >
            {title}
          </span>
          <TaskDueLine task={task} />
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col px-0.5 py-1">
          <span
            className={cn(
              "min-w-0 truncate text-sm",
              task.isOverdue && "text-destructive"
            )}
          >
            {title}
          </span>
          <TaskDueLine task={task} />
        </div>
      )}
      {openSource && (
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="task-source-link"
          aria-label={`Open source message for ${title}`}
          onClick={openSource}
        >
          <ExternalLink />
        </Button>
      )}
    </div>
  )
}

/** The formatted due date; overdue renders in the destructive tone (the
 * spec's overdue visual state). Due-less tasks render no date line. */
function TaskDueLine({ task }: { task: Task }) {
  if (task.dueAt === null) return null
  return (
    <span
      data-testid="task-due"
      className={cn(
        "text-xs tabular-nums",
        task.isOverdue ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {task.isOverdue ? "Overdue · " : ""}
      {formatTaskDue(task.dueAt)}
    </span>
  )
}
