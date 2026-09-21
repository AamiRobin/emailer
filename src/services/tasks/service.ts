import type { SqlExecutor } from "../db/executor"
import {
  nextOccurrenceFromUnix,
  parseRecurrenceJson,
  parseRecurrenceRule,
  serializeRecurrence,
  type RecurrenceRule,
} from "./recurrence"

/**
 * The tasks service (task 5.6, tasks spec "Task management", design D6):
 * CRUD + completion over the `tasks` table (migration v12).
 *
 * SERIES / HISTORY MODEL — the design's "completing a recurring task
 * inserts the next occurrence and keeps the instance in history":
 * - One ROW PER INSTANCE. Completing stamps `completed_at` on the row and
 *   KEEPS it — the completed instance IS the history record. For a
 *   recurring task, completing ALSO inserts a new OPEN row for the next
 *   occurrence, with the due date computed FROM THE COMPLETED INSTANCE'S
 *   DUE DATE (never the completion time — completing 3 days late still
 *   advances by one period from the due date; see recurrence.ts).
 * - `series_id` (generated uuid) groups the rows of one recurring series,
 *   so occurrences list/detail together. Set at creation when the task is
 *   born with a rule; a rule added later via updateTask gets its series id
 *   stamped lazily at first completion (backfill on both rows). NULL for
 *   tasks never given a rule.
 * - `completed_history_json` is a JSON array of
 *   `{ completedAt, dueAt }` (unix seconds), oldest first, service-capped
 *   at HISTORY_CAP (50 — drop oldest). Each completion appends one entry
 *   to the completing row and each expansion COPIES the appended array
 *   into the next occurrence, so the OPEN instance always carries the
 *   whole series trail (getTask shows it), while every completed row keeps
 *   the trail as of its own completion. listCompletedTasks reads the
 *   completed ROWS (the instances); the JSON trail is the second
 *   representation, exposed per task through getTask/list results.
 * - Edge case: a recurring task with NO due date expands from the
 *   completion time instead (there is no due date to schedule from) —
 *   documented deviation from the letter of "from the due date" for the
 *   due-less daily-chore style task the UI allows.
 *
 * Tasks are local to the machine and deliberately account-independent:
 * `source_account_id`/`source_message_id`/`source_thread_id` are nullable
 * provenance back-links (no FKs), the list queries span all accounts, and
 * rows survive account or thread deletion.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

/** Cap for the per-series completed-history trail (oldest dropped). */
export const HISTORY_CAP = 50

export type TaskOrigin = "manual" | "email" | "ai"

/** Raw `tasks` row (snake_case columns, JSON columns unparsed). */
export interface TaskRow {
  id: string
  title: string
  notes: string | null
  /** unix epoch seconds, or null when the task has no due date */
  due_at: number | null
  recurrence_json: string | null
  /** unix epoch seconds; null = open task */
  completed_at: number | null
  created_at: number
  completed_history_json: string
  series_id: string | null
  source_account_id: string | null
  source_message_id: string | null
  source_thread_id: string | null
  origin: TaskOrigin
}

/** One completed instance's entry in the per-series history trail. */
export interface CompletedOccurrence {
  /** unix epoch seconds — when the instance was completed */
  completedAt: number
  /** unix epoch seconds — the instance's due date (null if it had none) */
  dueAt: number | null
}

/** A task with the JSON columns parsed and derived state computed. */
export interface Task {
  id: string
  title: string
  notes: string | null
  /** unix epoch seconds, or null */
  dueAt: number | null
  recurrence: RecurrenceRule | null
  /** unix epoch seconds, or null while open */
  completedAt: number | null
  createdAt: number
  /** Completed-instance trail of this task's series (open instance: all). */
  completedHistory: CompletedOccurrence[]
  seriesId: string | null
  sourceAccountId: string | null
  sourceMessageId: string | null
  sourceThreadId: string | null
  origin: TaskOrigin
  /** Derived: open with a due date already past (spec "Overdue visibility"). */
  isOverdue: boolean
}

export interface CreateTaskInput {
  title: string
  notes?: string
  /** unix epoch seconds */
  dueAt?: number
  recurrence?: RecurrenceRule
  /** defaults to "manual"; the CHECK constraint enumerates the rest */
  origin?: TaskOrigin
  sourceAccountId?: string
  sourceMessageId?: string
  sourceThreadId?: string
}

export interface UpdateTaskInput {
  title?: string
  /** undefined = unchanged; null/"" clears */
  notes?: string | null
  /** unix epoch seconds; undefined = unchanged; null clears */
  dueAt?: number | null
  /** undefined = unchanged; null clears the rule */
  recurrence?: RecurrenceRule | null
}

export interface ListOpenTasksOptions {
  /** "due" (default): by due date ascending, due-less tasks last.
   *  "created": creation order (oldest first) with id tiebreak. */
  sort?: "due" | "created"
  /** default true; false hides tasks without a due date */
  includeNoDue?: boolean
}

export interface CompleteTaskResult {
  /** false when the id is unknown (no-op, mirroring the todos service) */
  completed: boolean
  /** id of the inserted next occurrence, null for non-recurring tasks */
  nextTaskId: string | null
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** Defensive history parse: garbage in the column degrades to an empty trail. */
function parseHistory(json: string | null): CompletedOccurrence[] {
  if (json === null || json === "") return []
  try {
    const raw: unknown = JSON.parse(json)
    if (!Array.isArray(raw)) return []
    return raw.flatMap((entry) => {
      const record = entry as Record<string, unknown> | null
      if (record === null || typeof record !== "object") return []
      if (typeof record.completedAt !== "number") return []
      return [{
        completedAt: record.completedAt,
        dueAt: typeof record.dueAt === "number" ? record.dueAt : null,
      }]
    })
  } catch {
    return []
  }
}

function rowToTask(row: TaskRow): Task {
  const completedHistory = parseHistory(row.completed_history_json)
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    dueAt: row.due_at,
    recurrence: parseRecurrenceJson(row.recurrence_json),
    completedAt: row.completed_at,
    createdAt: row.created_at,
    completedHistory,
    seriesId: row.series_id,
    sourceAccountId: row.source_account_id,
    sourceMessageId: row.source_message_id,
    sourceThreadId: row.source_thread_id,
    origin: row.origin,
    isOverdue:
      row.completed_at === null &&
      row.due_at !== null &&
      row.due_at < nowSeconds(),
  }
}

function assertTitle(title: string): string {
  const trimmed = title.trim()
  if (trimmed === "") {
    throw new Error("Task title must not be empty")
  }
  return trimmed
}

function assertOrigin(origin: TaskOrigin): TaskOrigin {
  if (origin !== "manual" && origin !== "email" && origin !== "ai") {
    throw new Error(`Invalid task origin: ${String(origin)}`)
  }
  return origin
}

/**
 * Create one task instance. Tasks born with a recurrence rule get their
 * series id immediately; throws on an empty title or an invalid rule
 * (programmer/UI errors — since task 5.6 the AI create seam lets them
 * throw as retryable per-item errors rather than converting them; the
 * UI validates before calling).
 */
export async function createTask(
  executor: SqlExecutor,
  input: CreateTaskInput
): Promise<Task> {
  const title = assertTitle(input.title)
  const origin = assertOrigin(input.origin ?? "manual")
  const recurrence = input.recurrence === undefined
    ? null
    : parseRecurrenceRule(input.recurrence)
  if (input.recurrence !== undefined && recurrence === null) {
    throw new Error("Invalid recurrence rule")
  }
  const notes = input.notes === undefined || input.notes.trim() === ""
    ? null
    : input.notes
  const id = crypto.randomUUID()
  await executor.execute(
    `
    INSERT INTO tasks (
      id, title, notes, due_at, recurrence_json, completed_history_json,
      series_id, source_account_id, source_message_id, source_thread_id,
      origin
    )
    VALUES ($1, $2, $3, $4, $5, '[]', $6, $7, $8, $9, $10)
    `,
    [
      id,
      title,
      notes,
      input.dueAt === undefined ? null : Math.floor(input.dueAt),
      recurrence === null ? null : serializeRecurrence(recurrence),
      recurrence === null ? null : crypto.randomUUID(),
      input.sourceAccountId ?? null,
      input.sourceMessageId ?? null,
      input.sourceThreadId ?? null,
      origin,
    ]
  )
  const task = await getTask(executor, id)
  if (task === null) {
    throw new Error("Task insert did not persist")
  }
  return task
}

/**
 * Update the editable fields of one task instance. `null` clears an
 * optional field; `undefined` leaves it untouched. Adding a recurrence to
 * a task born without one does NOT allocate the series id here — the
 * series materializes at first completion (see the module doc). Returns
 * false when the id is unknown.
 */
export async function updateTask(
  executor: SqlExecutor,
  taskId: string,
  patch: UpdateTaskInput
): Promise<boolean> {
  const existing = await executor.select<Pick<TaskRow, "id">>(
    "SELECT id FROM tasks WHERE id = $1",
    [taskId]
  )
  if (existing.length === 0) return false

  // Placeholders ascend by first occurrence in the assembled SQL.
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.title !== undefined) {
    params.push(assertTitle(patch.title))
    sets.push(`title = $${params.length}`)
  }
  if (patch.notes !== undefined) {
    params.push(patch.notes === null || patch.notes.trim() === "" ? null : patch.notes)
    sets.push(`notes = $${params.length}`)
  }
  if (patch.dueAt !== undefined) {
    params.push(patch.dueAt === null ? null : Math.floor(patch.dueAt))
    sets.push(`due_at = $${params.length}`)
  }
  if (patch.recurrence !== undefined) {
    if (patch.recurrence === null) {
      params.push(null)
      sets.push(`recurrence_json = $${params.length}`)
    } else {
      const rule = parseRecurrenceRule(patch.recurrence)
      if (rule === null) {
        throw new Error("Invalid recurrence rule")
      }
      params.push(serializeRecurrence(rule))
      sets.push(`recurrence_json = $${params.length}`)
    }
  }
  if (sets.length === 0) return true
  params.push(taskId)
  await executor.execute(
    `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params
  )
  return true
}

/**
 * Delete ONE task instance (open or completed). The rest of a recurring
 * series is deliberately untouched — v1 has instance-level delete only;
 * series-wide operations can be built on `series_id` later.
 */
export async function deleteTask(
  executor: SqlExecutor,
  taskId: string
): Promise<void> {
  await executor.execute("DELETE FROM tasks WHERE id = $1", [taskId])
}

/** One task by id (parsed), or null. */
export async function getTask(
  executor: SqlExecutor,
  taskId: string
): Promise<Task | null> {
  const rows = await executor.select<TaskRow>(
    "SELECT * FROM tasks WHERE id = $1",
    [taskId]
  )
  const row = rows[0]
  return row === undefined ? null : rowToTask(row)
}

/**
 * Open tasks (completed_at IS NULL) across ALL accounts. Default sort is
 * by due date ascending with due-less tasks last; "created" is creation
 * order. `includeNoDue: false` limits the list to schedulable tasks.
 */
export async function listOpenTasks(
  executor: SqlExecutor,
  options?: ListOpenTasksOptions
): Promise<Task[]> {
  const sort = options?.sort ?? "due"
  const includeNoDue = options?.includeNoDue ?? true
  const where = includeNoDue
    ? "completed_at IS NULL"
    : "completed_at IS NULL AND due_at IS NOT NULL"
  const order = sort === "created"
    ? "created_at ASC, id ASC"
    // `(due_at IS NULL)` is 0 for dated rows — they sort before due-less.
    : "(due_at IS NULL) ASC, due_at ASC, created_at ASC, id ASC"
  const rows = await executor.select<TaskRow>(
    `SELECT * FROM tasks WHERE ${where} ORDER BY ${order}`
  )
  return rows.map(rowToTask)
}

/**
 * Completed instances, most recently completed first (bounded — the rows
 * accumulate one per recurring completion). The CURRENT open instance of
 * a series is not a completion and never appears here; the trail on each
 * row (Task.completedHistory) carries the series' older completions.
 */
export async function listCompletedTasks(
  executor: SqlExecutor,
  options?: { limit?: number }
): Promise<Task[]> {
  const limit = Math.min(Math.max(options?.limit ?? 200, 1), 1000)
  const rows = await executor.select<TaskRow>(
    `
    SELECT * FROM tasks
    WHERE completed_at IS NOT NULL
    ORDER BY completed_at DESC, id ASC
    LIMIT $1
    `,
    [limit]
  )
  return rows.map(rowToTask)
}

/**
 * Complete one task (spec "Recurring task completion"): stamp
 * completed_at, append the history entry, and — when a valid recurrence
 * rule is present — insert the NEXT occurrence as a new open row in the
 * same series, due FROM THE COMPLETED INSTANCE'S DUE DATE (falling back
 * to the completion time only when the task has no due date at all). The
 * next row copies the appended trail forward, so the open instance always
 * shows the full series history.
 */
export async function completeTask(
  executor: SqlExecutor,
  taskId: string
): Promise<CompleteTaskResult> {
  const rows = await executor.select<TaskRow>(
    "SELECT * FROM tasks WHERE id = $1",
    [taskId]
  )
  const row = rows[0] as TaskRow | undefined
  if (row === undefined) {
    return { completed: false, nextTaskId: null }
  }

  const now = nowSeconds()
  const trail: CompletedOccurrence[] = [
    ...parseHistory(row.completed_history_json),
    { completedAt: now, dueAt: row.due_at },
  ].slice(-HISTORY_CAP)

  // Rule-driven series: backfill the series id when the rule was added
  // after creation (both rows are stamped below in one statement).
  const rule = parseRecurrenceJson(row.recurrence_json)
  const seriesId = row.series_id ?? (rule === null ? null : crypto.randomUUID())

  await executor.execute(
    `
    UPDATE tasks
    SET completed_at = $1,
        completed_history_json = $2,
        series_id = COALESCE(series_id, $3)
    WHERE id = $4
    `,
    [now, JSON.stringify(trail), seriesId, taskId]
  )

  let nextTaskId: string | null = null
  if (rule !== null) {
    // The spec's core math: next due from the DUE date, not completion.
    const nextDueAt = nextOccurrenceFromUnix(rule, row.due_at ?? now)
    if (nextDueAt !== null) {
      nextTaskId = crypto.randomUUID()
      await executor.execute(
        `
        INSERT INTO tasks (
          id, title, notes, due_at, recurrence_json, completed_history_json,
          series_id, source_account_id, source_message_id, source_thread_id,
          origin
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        [
          nextTaskId,
          row.title,
          row.notes,
          nextDueAt,
          row.recurrence_json,
          // Trail copied forward: the open instance carries the series
          // history (see module doc).
          JSON.stringify(trail),
          seriesId,
          row.source_account_id,
          row.source_message_id,
          row.source_thread_id,
          row.origin,
        ]
      )
    }
  }

  return { completed: true, nextTaskId }
}
