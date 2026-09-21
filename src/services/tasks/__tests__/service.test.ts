import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { RecurrenceRule } from "../recurrence"
import {
  completeTask,
  createTask,
  deleteTask,
  getTask,
  listCompletedTasks,
  listOpenTasks,
  updateTask,
  type CompletedOccurrence,
} from "../service"

/**
 * Tasks service tests (task 5.6): CRUD round-trips over the real v12
 * schema, the from-due-date expansion on completion (the spec's core
 * "complete a weekly task → next instance due one week later, from the
 * DUE date not the completion time"), the completed-history trail and
 * series grouping, and the list/overdue derivations.
 *
 * Expansion dates use June 2026 anchors: no DST transition falls in the
 * +7d windows in either EU or US zones, so wall-clock-preserving weekly
 * expansion is exact unix-second arithmetic there.
 */

const DAY = 86400

function now(): number {
  return Math.floor(Date.now() / 1000)
}

/** Tuesday, June 9 2026, 09:00 local — a past due date ("completed late"). */
const JUN_9_2026_0900 = Math.floor(
  new Date(2026, 5, 9, 9, 0, 0, 0).getTime() / 1000
)

/** Jan 31 2026 09:30 local — the monthly-clamp anchor. */
const JAN_31_2026_0930 = Math.floor(
  new Date(2026, 0, 31, 9, 30, 0, 0).getTime() / 1000
)

function expectDueAt(actual: number | null, expectedSeconds: number): void {
  expect(actual).not.toBeNull()
  // Compare through local wall-clock components: recurrence preserves the
  // time of day, and exact-second equality holds away from DST shifts.
  const actualDate = new Date((actual as number) * 1000)
  const expectedDate = new Date(expectedSeconds * 1000)
  expect([
    actualDate.getFullYear(),
    actualDate.getMonth(),
    actualDate.getDate(),
    actualDate.getHours(),
    actualDate.getMinutes(),
  ]).toEqual([
    expectedDate.getFullYear(),
    expectedDate.getMonth(),
    expectedDate.getDate(),
    expectedDate.getHours(),
    expectedDate.getMinutes(),
  ])
}

/** Force created_at/completed_at for deterministic ORDER BY assertions. */
async function forceTimestamp(
  executor: TestExecutor,
  taskId: string,
  column: "created_at" | "completed_at",
  value: number
): Promise<void> {
  await executor.execute(`UPDATE tasks SET ${column} = $1 WHERE id = $2`, [
    value,
    taskId,
  ])
}

const WEEKLY: RecurrenceRule = { kind: "weekly", weekdays: [2] } // Tuesdays

describe("tasks schema (migration v12, task 5.6)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("creates the tasks table with the origin check and defaults", async () => {
    const tables = await executor.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    )
    expect(tables.map((row) => row.name)).toContain("tasks")

    const columns = await executor.select<{
      name: string
      notnull: number
      dflt_value: string | null
    }>("PRAGMA table_info(tasks)")
    const byName = new Map(columns.map((column) => [column.name, column]))
    expect(byName.get("title")?.notnull).toBe(1)
    expect(byName.get("origin")?.notnull).toBe(1)
    // created_at comes from the unixepoch() default, history starts '[]'.
    expect(byName.get("created_at")?.dflt_value).toContain("unixepoch")
    expect(byName.get("completed_history_json")?.dflt_value).toBe("'[]'")
    // Provenance back-links are nullable.
    for (const name of [
      "due_at",
      "recurrence_json",
      "completed_at",
      "series_id",
      "source_account_id",
      "source_message_id",
      "source_thread_id",
    ]) {
      expect(byName.get(name)?.notnull, `tasks.${name} nullable`).toBe(0)
    }

    // origin is CHECK-constrained to manual|email|ai.
    await executor.execute(
      "INSERT INTO tasks (id, title, origin) VALUES ('t-ok', 'x', 'email')"
    )
    await expect(
      executor.execute(
        "INSERT INTO tasks (id, title, origin) VALUES ('t-bad', 'x', 'fate')"
      )
    ).rejects.toThrow()
  })

  it("creates the open-due and series indexes", async () => {
    const rows = await executor.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index'"
    )
    const names = rows.map((row) => row.name)
    expect(names).toContain("idx_tasks_open_due")
    expect(names).toContain("idx_tasks_series")
  })
})

describe("task CRUD", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("creates a task with defaults and reads it back parsed", async () => {
    const futureDue = now() + 3600
    const created = await createTask(executor, {
      title: "File the expense report",
      notes: "Legal first",
      dueAt: futureDue,
    })
    expect(created.title).toBe("File the expense report")
    expect(created.notes).toBe("Legal first")
    expect(created.dueAt).toBe(futureDue)
    expect(created.origin).toBe("manual")
    expect(created.completedAt).toBeNull()
    expect(created.completedHistory).toEqual([])
    expect(created.recurrence).toBeNull()
    expect(created.seriesId).toBeNull()
    expect(created.sourceAccountId).toBeNull()
    expect(created.sourceThreadId).toBeNull()
    // Future due date, so not overdue.
    expect(created.isOverdue).toBe(false)
    expect(created.createdAt).toBeGreaterThan(0)

    const fetched = await getTask(executor, created.id)
    expect(fetched).not.toBeNull()
    expect(fetched?.id).toBe(created.id)
  })

  it("stores recurrence, origin and provenance back-links", async () => {
    const created = await createTask(executor, {
      title: "Weekly review",
      recurrence: WEEKLY,
      origin: "email",
      sourceAccountId: "acc-1",
      sourceMessageId: "msg-1",
      sourceThreadId: "thread-1",
    })
    expect(created.origin).toBe("email")
    expect(created.recurrence).toEqual(WEEKLY)
    expect(created.seriesId).not.toBeNull()
    expect(created.sourceAccountId).toBe("acc-1")
    expect(created.sourceMessageId).toBe("msg-1")
    expect(created.sourceThreadId).toBe("thread-1")
  })

  it("rejects empty titles and invalid recurrence rules", async () => {
    await expect(createTask(executor, { title: "   " })).rejects.toThrow()
    await expect(
      createTask(executor, {
        title: "x",
        recurrence: { kind: "weekly", weekdays: [] } as unknown as RecurrenceRule,
      })
    ).rejects.toThrow()
    await expect(
      createTask(executor, {
        title: "x",
        recurrence: { kind: "nope" } as unknown as RecurrenceRule,
      })
    ).rejects.toThrow()
  })

  it("updates editable fields and clears them with null", async () => {
    const task = await createTask(executor, {
      title: "Draft",
      notes: "old",
      dueAt: JUN_9_2026_0900,
    })
    expect(
      await updateTask(executor, task.id, {
        title: "Draft v2",
        notes: "new",
        dueAt: JUN_9_2026_0900 + DAY,
        recurrence: WEEKLY,
      })
    ).toBe(true)
    const updated = await getTask(executor, task.id)
    expect(updated).toMatchObject({
      title: "Draft v2",
      notes: "new",
    })
    expect(updated?.recurrence).toEqual(WEEKLY)
    expectDueAt(updated?.dueAt as number, JUN_9_2026_0900 + DAY)

    await updateTask(executor, task.id, {
      notes: null,
      dueAt: null,
      recurrence: null,
    })
    const cleared = await getTask(executor, task.id)
    expect(cleared).toMatchObject({ notes: null, dueAt: null, recurrence: null })
  })

  it("reports false for updates to unknown ids", async () => {
    expect(await updateTask(executor, "nope", { title: "x" })).toBe(false)
  })

  it("deletes a single instance and tolerates unknown ids", async () => {
    const task = await createTask(executor, { title: "Gone soon" })
    await deleteTask(executor, task.id)
    expect(await getTask(executor, task.id)).toBeNull()
    // Unknown id delete is a no-op, not a throw.
    await deleteTask(executor, "nope")
  })
})

describe("listOpenTasks", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("sorts by due date with due-less tasks last, hiding completed", async () => {
    const later = await createTask(executor, {
      title: "later",
      dueAt: JUN_9_2026_0900 + 2 * DAY,
    })
    const earlier = await createTask(executor, {
      title: "earlier",
      dueAt: JUN_9_2026_0900 + DAY,
    })
    const noDue = await createTask(executor, { title: "someday" })
    const done = await createTask(executor, {
      title: "done",
      dueAt: JUN_9_2026_0900,
    })
    await completeTask(executor, done.id)

    const byDue = await listOpenTasks(executor)
    expect(byDue.map((task) => task.id)).toEqual([earlier.id, later.id, noDue.id])

    const datedOnly = await listOpenTasks(executor, { includeNoDue: false })
    expect(datedOnly.map((task) => task.id)).toEqual([earlier.id, later.id])
  })

  it("supports creation order via raw timestamps for determinism", async () => {
    const first = await createTask(executor, { title: "first" })
    const second = await createTask(executor, { title: "second" })
    const third = await createTask(executor, { title: "third" })
    // Same-second inserts tie-break randomly by id — pin creation order.
    await forceTimestamp(executor, first.id, "created_at", 1000)
    await forceTimestamp(executor, second.id, "created_at", 2000)
    await forceTimestamp(executor, third.id, "created_at", 3000)

    const byCreated = await listOpenTasks(executor, { sort: "created" })
    expect(byCreated.map((task) => task.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ])
  })
})

describe("overdue derivation", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("flags open past-due tasks only", async () => {
    const overdue = await createTask(executor, {
      title: "overdue",
      dueAt: now() - 100,
    })
    const upcoming = await createTask(executor, {
      title: "upcoming",
      dueAt: now() + 100,
    })
    expect((await getTask(executor, overdue.id))?.isOverdue).toBe(true)
    expect((await getTask(executor, upcoming.id))?.isOverdue).toBe(false)

    // Completion clears the overdue state (the row is kept, but closed).
    await completeTask(executor, overdue.id)
    expect((await getTask(executor, overdue.id))?.isOverdue).toBe(false)
  })
})

describe("completeTask (non-recurring)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("stamps completion, appends history, creates nothing else", async () => {
    const dueAt = now() - 50
    const task = await createTask(executor, {
      title: "one-off",
      dueAt,
    })
    const result = await completeTask(executor, task.id)
    expect(result).toEqual({ completed: true, nextTaskId: null })

    const completed = await getTask(executor, task.id)
    expect(completed?.completedAt).not.toBeNull()
    expect(completed?.completedHistory).toHaveLength(1)
    expect(completed?.completedHistory[0]).toMatchObject({
      dueAt,
      completedAt: expect.any(Number),
    })

    // No phantom rows: the completed instance is the only row.
    const all = await executor.select<{ id: string }>(
      "SELECT id FROM tasks"
    )
    expect(all.map((row) => row.id)).toEqual([task.id])

    expect((await listOpenTasks(executor)).map((t) => t.id)).toEqual([])
    const completedList = await listCompletedTasks(executor)
    expect(completedList.map((t) => t.id)).toEqual([task.id])
  })

  it("no-ops on unknown ids", async () => {
    const result = await completeTask(executor, "nope")
    expect(result).toEqual({ completed: false, nextTaskId: null })
  })
})

describe("completeTask (recurring expansion)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("schedules the next occurrence FROM THE DUE DATE, not completion", async () => {
    // Due Tuesday June 9 09:00 local (months in the past — i.e. completed
    // very late). Weekly rule → next due must be June 16 09:00, the due
    // date + exactly one period, NOT completion time + one period.
    const task = await createTask(executor, {
      title: "Weekly review",
      dueAt: JUN_9_2026_0900,
      recurrence: WEEKLY,
    })
    const result = await completeTask(executor, task.id)
    expect(result.completed).toBe(true)
    expect(result.nextTaskId).not.toBeNull()

    const next = await getTask(executor, result.nextTaskId as string)
    expect(next).not.toBeNull()
    expectDueAt(next?.dueAt as number, JUN_9_2026_0900 + 7 * DAY)
    expect(next?.completedAt).toBeNull()
    // Same series, same identity fields.
    expect(next?.seriesId).toBe(task.seriesId)
    expect(next?.title).toBe("Weekly review")
    expect(next?.recurrence).toEqual(WEEKLY)
    // The completed instance stays behind with its history entry.
    const completed = await getTask(executor, task.id)
    expect(completed?.completedAt).not.toBeNull()
    expect(completed?.completedHistory).toHaveLength(1)
    expect(completed?.completedHistory[0]?.dueAt).toBe(JUN_9_2026_0900)
    // The trail is copied forward onto the open instance.
    expect(
      (next?.completedHistory as CompletedOccurrence[]).map((e) => e.dueAt)
    ).toEqual([JUN_9_2026_0900])
  })

  it("expands with monthly clamping at the service level (Jan 31 → Feb 28)", async () => {
    const task = await createTask(executor, {
      title: "Month-end close",
      dueAt: JAN_31_2026_0930,
      recurrence: { kind: "monthly" },
    })
    const result = await completeTask(executor, task.id)
    const next = await getTask(executor, result.nextTaskId as string)
    expectDueAt(next?.dueAt as number, JAN_31_2026_0930 + 28 * DAY)
  })

  it("grows the series trail across successive completions", async () => {
    const first = await createTask(executor, {
      title: "Chore",
      dueAt: JUN_9_2026_0900,
      recurrence: WEEKLY,
    })
    const r1 = await completeTask(executor, first.id)
    const secondId = r1.nextTaskId as string
    const r2 = await completeTask(executor, secondId)
    const thirdId = r2.nextTaskId as string

    // Two completed instances kept, one open instance remains.
    const completed = await listCompletedTasks(executor)
    expect(completed).toHaveLength(2)
    const open = await listOpenTasks(executor)
    expect(open.map((task) => task.id)).toEqual([thirdId])

    // Third instance due two weeks after the original due date, and its
    // trail carries BOTH completions.
    const third = await getTask(executor, thirdId)
    expectDueAt(third?.dueAt as number, JUN_9_2026_0900 + 14 * DAY)
    const trail = third?.completedHistory as CompletedOccurrence[]
    expect(trail).toHaveLength(2)
    expect(trail[0]?.dueAt).toBe(JUN_9_2026_0900)
    expect(trail[1]?.dueAt).toBe(JUN_9_2026_0900 + 7 * DAY)
  })

  it("backfills a series id when the rule is added after creation", async () => {
    const task = await createTask(executor, {
      title: "Becomes recurring",
      dueAt: JUN_9_2026_0900,
    })
    expect(task.seriesId).toBeNull()
    await updateTask(executor, task.id, { recurrence: WEEKLY })

    const result = await completeTask(executor, task.id)
    const next = await getTask(executor, result.nextTaskId as string)
    const completed = await getTask(executor, task.id)
    expect(completed?.seriesId).not.toBeNull()
    expect(next?.seriesId).toBe(completed?.seriesId)
  })

  it("caps the series trail at HISTORY_CAP entries", async () => {
    const task = await createTask(executor, {
      title: "Daily grind",
      dueAt: JUN_9_2026_0900,
      recurrence: { kind: "daily" },
    })
    let currentId: string | null = task.id
    for (let index = 0; index < 50; index += 1) {
      const result = await completeTask(executor, currentId as string)
      currentId = result.nextTaskId
    }
    expect(currentId).not.toBeNull()
    const open = await getTask(executor, currentId as string)
    expect(open?.completedHistory).toHaveLength(50)
  })
})

describe("listCompletedTasks", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("returns completed instances newest-first with a limit", async () => {
    const a = await createTask(executor, { title: "a" })
    const b = await createTask(executor, { title: "b" })
    const c = await createTask(executor, { title: "c" })
    await completeTask(executor, a.id)
    await completeTask(executor, b.id)
    await completeTask(executor, c.id)
    // Same-second completions tie-break randomly — pin the order.
    await forceTimestamp(executor, a.id, "completed_at", 1000)
    await forceTimestamp(executor, b.id, "completed_at", 2000)
    await forceTimestamp(executor, c.id, "completed_at", 3000)

    const all = await listCompletedTasks(executor)
    expect(all.map((task) => task.id)).toEqual([c.id, b.id, a.id])

    const limited = await listCompletedTasks(executor, { limit: 2 })
    expect(limited.map((task) => task.id)).toEqual([c.id, b.id])
  })
})
