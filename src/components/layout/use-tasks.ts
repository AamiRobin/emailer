import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import {
  completeTask,
  createTask,
  listCompletedTasks,
  listOpenTasks,
  type Task,
} from "@/services/tasks/service"
import { useUiStore } from "@/stores/ui-store"

/**
 * Tasks-section data plumbing (task 5.7, design D6) — the use-todos.ts
 * pattern: an injectable SqlExecutor for tests plus a module-level notify
 * seam. The component lives in tasks-section.tsx.
 *
 * The list is CROSS-ACCOUNT by design (tasks spec "Tasks sidebar and
 * views"): the tasks service queries the `tasks` table directly and the
 * rows carry no account scope, so the hook needs no account id — it
 * reloads on mount, on sort changes and on notifyTasksChanged().
 *
 * - completeTaskById (the section row's checkbox): optimistic — the row is
 *   hidden from the open list synchronously (a module-level in-flight set
 *   the hook filters by) while the service write runs; the notify that
 *   follows the write re-queries SQLite, which moves the row into the
 *   completed view. A failed write restores the row.
 * - createTaskFromEmail (the reading-pane/context-menu conversion, tasks
 *   spec "Task from email"): writes through the tasks service with
 *   origin "email" + the source back-links and NOTHING else — the source
 *   thread's flags, folders and labels are deliberately untouched (the
 *   conversion is a pure tasks-table insert). The toast carries the jump
 *   affordance; the section reloads through the notify seam.
 * - openTaskSourceThread (the source link / toast jump): the exact
 *   openAttachmentSourceMessage sequence (use-attachment-browser.ts) —
 *   back to the mailbox view the user came from (previousView; the
 *   full-pane pages never clobber it), then into the reading pane, which
 *   resolves the thread's owning account itself.
 */

let sectionExecutorOverride: SqlExecutor | null = null

function resolveExecutor(): SqlExecutor {
  return sectionExecutorOverride ?? getExecutor()
}

/** Test hook: run the section's queries against `executor` (node:sqlite
 * under vitest); pass null to restore the production getExecutor()
 * binding. */
export function setTasksSectionExecutor(executor: SqlExecutor | null): void {
  sectionExecutorOverride = executor
}

// ---- Refresh seam: the conversion/complete flows notify subscribers
// after their mutation so the section re-queries SQLite. ----

const tasksChangedListeners = new Set<() => void>()

/** Tell useTasks subscribers to re-query the open + completed tasks. */
export function notifyTasksChanged(): void {
  for (const listener of tasksChangedListeners) listener()
}

/**
 * Tasks whose completion write is still in flight — hidden from the open
 * list immediately (the optimistic update) and pruned by the hook once
 * the post-write re-query lands them in the completed view.
 */
const optimisticCompleted = new Set<string>()

/**
 * The open + completed lists for the section (task 5.7). DB failures
 * render empty lists. Reloads on mount, on `sort` changes and on
 * notifyTasksChanged(); completed rows are bounded (the service default
 * window is plenty for a sidebar disclosure).
 */
export function useTasks(sort: "due" | "created"): {
  open: Task[]
  completed: Task[]
} {
  const [state, setState] = useState<{ open: Task[]; completed: Task[] }>({
    open: [],
    completed: [],
  })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const invalidate = (): void => setRevision((value) => value + 1)
    tasksChangedListeners.add(invalidate)
    return () => {
      tasksChangedListeners.delete(invalidate)
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    // The promise hop keeps the load (and the no-DB fallback —
    // resolveExecutor() throws outside Tauri) out of the effect body.
    Promise.resolve()
      .then(() =>
        Promise.all([
          listOpenTasks(resolveExecutor(), { sort }),
          listCompletedTasks(resolveExecutor(), { limit: 50 }),
        ])
      )
      .then(([open, completed]) => {
        if (cancelled) return
        // A completion write that landed while we re-queried: the fresh
        // open list no longer holds the row, so the optimistic hiding is
        // done (the completed list carries it now).
        for (const id of [...optimisticCompleted]) {
          if (!open.some((task) => task.id === id)) {
            optimisticCompleted.delete(id)
          }
        }
        setState({ open, completed })
      })
      .catch((error) => {
        console.warn("[tasks-section] failed to load tasks", error)
        if (!cancelled) setState({ open: [], completed: [] })
      })
    return () => {
      cancelled = true
    }
  }, [sort, revision])
  // Optimistic filtering happens at render: notifyTasksChanged() during
  // completeTaskById re-renders synchronously with the stale rows minus
  // the in-flight one.
  const open = state.open.filter((task) => !optimisticCompleted.has(task.id))
  return { open, completed: state.completed }
}

/**
 * Complete a task (the section row's checkbox): hide the row
 * optimistically, run the service write, then notify so the re-query
 * moves the row into the completed view. Failures restore the row.
 */
export async function completeTaskById(taskId: string): Promise<void> {
  optimisticCompleted.add(taskId)
  notifyTasksChanged()
  try {
    await completeTask(resolveExecutor(), taskId)
  } catch (error) {
    console.warn("[tasks-section] complete failed", error)
    optimisticCompleted.delete(taskId)
    notifyTasksChanged()
    return
  }
  notifyTasksChanged()
}

/**
 * Jump to a task's source thread (the row's link icon and the creation
 * toast's action): the openAttachmentSourceMessage sequence — restore the
 * last mailbox view (the section is sidebar chrome, so the user may be in
 * a full-pane page), then open the thread in the reading pane.
 */
export function openTaskSourceThread(threadId: string): void {
  const ui = useUiStore.getState()
  ui.setView(ui.previousView)
  ui.setActiveThread(threadId)
}

/** Cap for the notes prefill (the newest message's snippet). */
export const TASK_NOTES_CAP = 200

/** The conversion dialog's prefill: title + notes computed from a thread. */
export interface TaskPrefill {
  title: string
  notes: string | null
}

/**
 * Compute the conversion dialog's prefill (task 5.7, tasks spec "Task
 * from email" — "confirms the prefilled title"): the thread subject is
 * the title ("Task from email" when the subject is empty — the service
 * rejects empty titles), and the newest message's snippet becomes the
 * notes, capped at TASK_NOTES_CAP characters.
 */
export function buildTaskPrefill(
  subject: string | null,
  snippet: string | null
): TaskPrefill {
  const trimmedSubject = subject?.trim() ?? ""
  const trimmedSnippet = snippet?.trim() ?? ""
  return {
    title: trimmedSubject !== "" ? trimmedSubject : "Task from email",
    notes: trimmedSnippet !== "" ? trimmedSnippet.slice(0, TASK_NOTES_CAP) : null,
  }
}

/** Payload for converting one thread into a task (task 5.7). */
export interface TaskFromEmailInput {
  threadId: string
  /** The thread's OWNING account (provenance only). */
  accountId: string
  /** The confirmed (possibly edited) title. */
  title: string
  /** Optional confirmed notes; empty/whitespace becomes no notes. */
  notes?: string | null
}

/**
 * Convert a thread into a task (tasks spec "Task from email"): one
 * tasks-table row with origin "email", the source back-links
 * (source_thread_id + the NEWEST message's id as the finer
 * source_message_id, resolved here best-effort) and nothing else — the
 * source thread's inbox state (unread, folders, labels, flags) is never
 * touched. Toasts "Task created" with an Open jump action; the section
 * reloads through the notify seam. Resolves null on failure (the dialog
 * stays open so the input is not lost).
 */
export async function createTaskFromEmail(
  input: TaskFromEmailInput
): Promise<Task | null> {
  try {
    const executor = resolveExecutor()
    let sourceMessageId: string | undefined
    try {
      const rows = await executor.select<{ id: string }>(
        "SELECT id FROM messages WHERE thread_id = $1 ORDER BY date DESC, rowid DESC LIMIT 1",
        [input.threadId]
      )
      sourceMessageId = rows[0]?.id
    } catch {
      // Best-effort back-link — never block creation on it.
    }
    const task = await createTask(executor, {
      title: input.title,
      ...(input.notes ? { notes: input.notes } : {}),
      origin: "email",
      sourceAccountId: input.accountId,
      ...(sourceMessageId ? { sourceMessageId } : {}),
      sourceThreadId: input.threadId,
    })
    notifyTasksChanged()
    toast.success("Task created", {
      action: {
        label: "Open",
        onClick: () => openTaskSourceThread(input.threadId),
      },
    })
    return task
  } catch (error) {
    console.warn("[tasks-section] create from email failed", error)
    toast.error("Could not create the task")
    return null
  }
}
