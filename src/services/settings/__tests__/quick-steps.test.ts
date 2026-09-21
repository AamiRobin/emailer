import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  createQuickStep,
  deleteQuickStep,
  listQuickSteps,
  markDestructiveConfirmed,
  QUICK_STEPS_SETTING_KEY,
  QUICK_STEP_TRASH_CONFIRMED_KEY,
  reorderQuickSteps,
  shouldConfirmDestructive,
  stepIncludesTrash,
  updateQuickStep,
  type QuickStepAction,
} from "../quick-steps"

/**
 * Quick steps CRUD tests (task 3.1, design D13): round-trips against the
 * real settings table (node:sqlite) — one JSON row under
 * `organization.quickSteps`, read back through the same validating
 * reader the manage UI and the runner use, plus the one-time
 * destructive-confirmation flag row.
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

const readArchive: QuickStepAction[] = [
  { kind: "mark_read", read: true },
  { kind: "archive" },
]

async function names(): Promise<string[]> {
  return (await listQuickSteps(executor)).map((step) => step.name)
}

describe("quick steps CRUD (task 3.1)", () => {
  it("defaults to no quick steps", async () => {
    expect(await listQuickSteps(executor)).toEqual([])
  })

  it("creates quick steps appended in list order with dense orders", async () => {
    const first = await createQuickStep(executor, {
      name: "Cleanup",
      actions: readArchive,
    })
    const second = await createQuickStep(executor, {
      name: "Newsletter",
      actions: [
        { kind: "mark_read", read: true },
        { kind: "add_label", label: "Newsletters" },
        { kind: "archive" },
      ],
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(await listQuickSteps(executor)).toEqual([
      {
        id: first.ok ? first.step.id : "",
        name: "Cleanup",
        actions: readArchive,
        order: 0,
      },
      {
        id: second.ok ? second.step.id : "",
        name: "Newsletter",
        actions: [
          { kind: "mark_read", read: true },
          { kind: "add_label", label: "Newsletters" },
          { kind: "archive" },
        ],
        order: 1,
      },
    ])
  })

  it("rejects duplicate names case-insensitively and empty names", async () => {
    await createQuickStep(executor, { name: "Cleanup", actions: readArchive })
    expect(
      await createQuickStep(executor, { name: "cleanup", actions: readArchive })
    ).toEqual({ ok: false, error: "name-taken" })
    expect(
      await createQuickStep(executor, {
        name: "  CLEANUP ",
        actions: readArchive,
      })
    ).toEqual({ ok: false, error: "name-taken" })
    expect(
      await createQuickStep(executor, { name: "   ", actions: readArchive })
    ).toEqual({
      ok: false,
      error: "name-required",
    })
    expect(
      await createQuickStep(executor, { name: "", actions: readArchive })
    ).toEqual({
      ok: false,
      error: "name-required",
    })
  })

  it("enforces the two-action chain minimum at create AND update", async () => {
    // The spec defines a quick step as a chain of two or more actions —
    // a shape guarantee, so fewer than two is a typed error, not a warn.
    expect(
      await createQuickStep(executor, { name: "Solo", actions: [] })
    ).toEqual({ ok: false, error: "min-two-actions" })
    expect(
      await createQuickStep(executor, {
        name: "Solo",
        actions: [{ kind: "archive" }],
      })
    ).toEqual({ ok: false, error: "min-two-actions" })

    const created = await createQuickStep(executor, {
      name: "Cleanup",
      actions: readArchive,
    })
    if (!created.ok) throw new Error("seed failed")
    expect(
      await updateQuickStep(executor, created.step.id, {
        actions: [{ kind: "star" }],
      })
    ).toEqual({ ok: false, error: "min-two-actions" })
    // Omitting actions leaves the chain unchanged.
    const reread = await updateQuickStep(executor, created.step.id, {})
    expect(reread.ok && reread.step.actions).toEqual(readArchive)
  })

  it("updates name and actions in place, keeping order and enforcing uniqueness", async () => {
    const a = await createQuickStep(executor, {
      name: "A",
      actions: readArchive,
    })
    const b = await createQuickStep(executor, {
      name: "B",
      actions: [{ kind: "star" }, { kind: "mark_read", read: true }],
    })
    if (!a.ok || !b.ok) throw new Error("seed failed")

    const updated = await updateQuickStep(executor, b.step.id, {
      name: "  Bee  ",
      actions: [{ kind: "trash" }, { kind: "mark_read", read: true }],
    })
    expect(updated).toEqual({
      ok: true,
      step: {
        id: b.step.id,
        name: "Bee",
        actions: [{ kind: "trash" }, { kind: "mark_read", read: true }],
        order: 1,
      },
    })
    expect(await names()).toEqual(["A", "Bee"])

    expect(await updateQuickStep(executor, b.step.id, { name: "a" })).toEqual({
      ok: false,
      error: "name-taken",
    })
    expect(await updateQuickStep(executor, b.step.id, { name: " " })).toEqual({
      ok: false,
      error: "name-required",
    })
    expect(await updateQuickStep(executor, "nope", { name: "C" })).toEqual({
      ok: false,
      error: "not-found",
    })
  })

  it("reorders via id sequence, dense afterwards, unknown ids ignored", async () => {
    const a = await createQuickStep(executor, {
      name: "A",
      actions: readArchive,
    })
    const b = await createQuickStep(executor, {
      name: "B",
      actions: readArchive,
    })
    const c = await createQuickStep(executor, {
      name: "C",
      actions: readArchive,
    })
    if (!a.ok || !b.ok || !c.ok) throw new Error("seed failed")

    // A partial reorder: B moves before A; C (unmentioned) keeps its
    // relative position after the mentioned ones.
    await reorderQuickSteps(executor, [b.step.id, a.step.id])
    expect(await names()).toEqual(["B", "A", "C"])

    await reorderQuickSteps(executor, ["nope", c.step.id, b.step.id, a.step.id])
    const stored = await listQuickSteps(executor)
    expect(stored.map((step) => step.name)).toEqual(["C", "B", "A"])
    expect(stored.map((step) => step.order)).toEqual([0, 1, 2])
  })

  it("deletes a quick step and leaves the others intact", async () => {
    const a = await createQuickStep(executor, {
      name: "A",
      actions: readArchive,
    })
    const b = await createQuickStep(executor, {
      name: "B",
      actions: readArchive,
    })
    if (!a.ok || !b.ok) throw new Error("seed failed")

    await deleteQuickStep(executor, a.step.id)
    const remaining = await listQuickSteps(executor)
    expect(remaining.map((step) => step.name)).toEqual(["B"])
    expect(remaining[0]!.order).toBe(0)

    // Deleting an unknown id is a no-op.
    await deleteQuickStep(executor, "nope")
    expect(await names()).toEqual(["B"])
  })

  it("drops corrupt stored entries instead of throwing", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [
        QUICK_STEPS_SETTING_KEY,
        JSON.stringify([
          {
            id: "q-1",
            name: "Good",
            actions: [{ kind: "mark_read", read: true }, { kind: "archive" }],
            order: 0,
          },
          // Unknown action kind: the entry falls below two valid actions
          // and is dropped with them.
          {
            id: "q-2",
            name: "Bad kind",
            actions: [{ kind: "explode" }, { kind: "archive" }],
            order: 1,
          },
          // Mistyped parameter dropped, entry survives with two valid.
          {
            id: "q-3",
            name: "Trimmed",
            actions: [
              { kind: "add_label" },
              { kind: "mark_read", read: "yes" },
              { kind: "snooze", presetId: "next_year" },
              { kind: "star" },
              { kind: "trash" },
            ],
            order: 2,
          },
          null,
          { id: "q-5", name: "No actions", order: 3 },
        ]),
      ]
    )
    const stored = await listQuickSteps(executor)
    expect(stored.map((step) => step.name)).toEqual(["Good", "Trimmed"])
    expect(stored[1]!.actions).toEqual([{ kind: "star" }, { kind: "trash" }])

    // A non-array row means "no quick steps", not a crash.
    await executor.execute("UPDATE settings SET value = $1 WHERE key = $2", [
      JSON.stringify({ oops: true }),
      QUICK_STEPS_SETTING_KEY,
    ])
    expect(await listQuickSteps(executor)).toEqual([])
  })
})

// ---- Per-step keyboard shortcut (task 3.2) ----

describe("quick step shortcuts (task 3.2)", () => {
  const readArchive: QuickStepAction[] = [
    { kind: "mark_read", read: true },
    { kind: "archive" },
  ]

  async function seed(name: string, shortcut?: string): Promise<string> {
    const result = await createQuickStep(executor, {
      name,
      actions: readArchive,
      shortcut: shortcut ?? null,
    })
    if (!result.ok) throw new Error(`seed failed: ${result.error}`)
    return result.step.id
  }

  it("stores a digit shortcut on create and update, and clears on null", async () => {
    const id = await seed("Cleanup")
    expect(
      (await updateQuickStep(executor, id, { shortcut: "3" })).ok
    ).toBe(true)
    const loaded = await listQuickSteps(executor)
    expect(loaded[0]!.shortcut).toBe("3")

    // Omitting shortcut on update leaves it unchanged.
    await updateQuickStep(executor, id, { name: "Cleanup 2" })
    expect((await listQuickSteps(executor))[0]!.shortcut).toBe("3")

    // null clears it.
    await updateQuickStep(executor, id, { shortcut: null })
    expect((await listQuickSteps(executor))[0]!.shortcut).toBeUndefined()
  })

  it("rejects non-digit shortcuts and collisions (reject, not last-wins)", async () => {
    const first = await seed("First", "1")
    expect(
      await createQuickStep(executor, {
        name: "Second",
        actions: readArchive,
        shortcut: "1",
      })
    ).toEqual({ ok: false, error: "shortcut-taken" })
    expect(
      await createQuickStep(executor, {
        name: "Second",
        actions: readArchive,
        shortcut: "12",
      })
    ).toEqual({ ok: false, error: "shortcut-invalid" })
    expect(
      await createQuickStep(executor, {
        name: "Second",
        actions: readArchive,
        shortcut: "0",
      })
    ).toEqual({ ok: false, error: "shortcut-invalid" })
    // Updating the OTHER step onto the taken digit is rejected and the
    // first step keeps it.
    expect(
      await updateQuickStep(executor, first, {})
    ).toBeTruthy()
    const second = await seed("Second")
    expect(
      await updateQuickStep(executor, second, { shortcut: "1" })
    ).toEqual({ ok: false, error: "shortcut-taken" })
    expect((await listQuickSteps(executor)).find((s) => s.id === first)!.shortcut).toBe("1")
    // A step may keep its own shortcut through an update.
    expect(await updateQuickStep(executor, first, { shortcut: "1" })).toEqual({
      ok: true,
      step: expect.objectContaining({ id: first, shortcut: "1" }),
    })
  })

  it("drops invalid stored shortcuts on read (hand-edited rows never crash)", async () => {
    await seed("Good", "2")
    await executor.execute(
      "UPDATE settings SET value = $1 WHERE key = $2",
      [
        JSON.stringify([
          {
            id: "q-1",
            name: "Good",
            actions: readArchive,
            order: 0,
            shortcut: "forty-two",
          },
          {
            id: "q-2",
            name: "Also good",
            actions: readArchive,
            order: 1,
            shortcut: 7,
          },
        ]),
        QUICK_STEPS_SETTING_KEY,
      ]
    )
    const stored = await listQuickSteps(executor)
    expect(stored.map((step) => step.shortcut)).toEqual([undefined, undefined])
  })
})

// ---- One-time destructive confirmation (spec: confirms once) ----

describe("destructive confirmation flag (task 3.1)", () => {
  it("asks by default, stops asking after markDestructiveConfirmed", async () => {
    expect(await shouldConfirmDestructive(executor)).toBe(true)

    await markDestructiveConfirmed(executor)
    expect(await shouldConfirmDestructive(executor)).toBe(false)
  })

  it("treats a corrupt flag row as unconfirmed (asks again)", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [QUICK_STEP_TRASH_CONFIRMED_KEY, JSON.stringify("yes")]
    )
    expect(await shouldConfirmDestructive(executor)).toBe(true)
  })

  it("stepIncludesTrash detects the destructive action in a chain", () => {
    expect(
      stepIncludesTrash({
        id: "s",
        name: "Toss",
        actions: [{ kind: "mark_read", read: true }, { kind: "trash" }],
        order: 0,
      })
    ).toBe(true)
    expect(
      stepIncludesTrash({
        id: "s",
        name: "Clean",
        actions: [{ kind: "mark_read", read: true }, { kind: "archive" }],
        order: 0,
      })
    ).toBe(false)
  })
})
