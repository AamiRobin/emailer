import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

/**
 * Quick steps settings section tests (task 3.2). Same executor-injection
 * pattern as the snippets/rules section suites: the executor module is
 * mocked to hand the section a seeded node:sqlite executor and the REAL
 * 3.1 service runs — create/reorder/delete assertions read back through
 * listQuickSteps, so the section's writes are checked against the same
 * validating reader the run affordances use.
 */

const executorHolder = vi.hoisted(() => ({
  current: null as unknown,
}))

vi.mock("@/services/db/executor", () => ({
  getExecutor: () => {
    const executor = executorHolder.current
    if (!executor) throw new Error("test executor not set")
    return executor
  },
  placeholders: (count: number, firstIndex = 1): string =>
    Array.from({ length: count }, (_, index) => `$${index + firstIndex}`).join(
      ", "
    ),
}))

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  createQuickStep,
  listQuickSteps,
} from "@/services/settings/quick-steps"
import type { QuickStepAction } from "@/services/settings/quick-steps"
import { QuickStepsSection } from "../quick-steps-section"

let executor: TestExecutor

const readArchive: QuickStepAction[] = [
  { kind: "mark_read", read: true },
  { kind: "archive" },
]

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  executor.close()
})

async function seedStep(
  name: string,
  shortcut?: string
): Promise<string> {
  const result = await createQuickStep(executor, {
    name,
    actions: readArchive,
    shortcut: shortcut ?? null,
  })
  if (!result.ok) throw new Error(`seed failed: ${result.error}`)
  return result.step.id
}

function row(name: string): HTMLElement {
  const rows = screen.getAllByTestId("settings-quick-step-row")
  const found = rows.find((row) => row.textContent?.includes(name))
  if (!found) throw new Error(`no quick step row for ${name}`)
  return found
}

/** Base UI Select ignores synthetic clicks that did not start with a
 * pointerdown on the item (drag-select guard), so send both. */
async function chooseOption(name: string): Promise<void> {
  const option = await screen.findByRole("option", { name })
  fireEvent.pointerDown(option)
  fireEvent.click(option)
}

describe("quick steps section (task 3.2)", () => {
  it("shows the empty state, then the Add dialog enforces the two-action minimum", async () => {
    render(<QuickStepsSection />)
    expect(await screen.findByText(/No quick steps yet/)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Add Quick Step" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getAllByRole("combobox").length).toBeGreaterThan(0)

    // Fill the name and one action only: Save stays disabled (the chain
    // shape is a spec guarantee).
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Cleanup" },
    })
    fireEvent.click(screen.getByRole("combobox", { name: "Add action" }))
    await chooseOption("Mark read")
    await waitFor(() => {
      expect(screen.getByTestId("quick-step-action-row-0")).toBeTruthy()
    })
    expect(
      (screen.getByRole("button", { name: "Create Quick Step" }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(within(dialog).getByText(/needs at least two actions/)).toBeTruthy()

    // The second action unlocks Save; creating lands in the service.
    fireEvent.click(screen.getByRole("combobox", { name: "Add action" }))
    await chooseOption("Archive")
    await waitFor(() => {
      expect(screen.getByTestId("quick-step-action-row-1")).toBeTruthy()
    })
    fireEvent.click(screen.getByRole("button", { name: "Create Quick Step" }))

    await waitFor(async () => {
      const steps = await listQuickSteps(executor)
      expect(steps.map((step) => step.name)).toEqual(["Cleanup"])
      expect(steps[0]!.actions).toEqual([
        { kind: "mark_read", read: true },
        { kind: "archive" },
      ])
    })
    expect(await screen.findByTestId("settings-quick-step-row")).toBeTruthy()
  })

  it("creates with a label action carrying its name, rendered as a chip", async () => {
    render(<QuickStepsSection />)
    fireEvent.click(await screen.findByRole("button", { name: "Add Quick Step" }))
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Newsletters" },
    })
    fireEvent.click(screen.getByRole("combobox", { name: "Add action" }))
    await chooseOption("Add label")
    fireEvent.change(
      screen.getByLabelText("Action 1 label name", { selector: "input" }),
      { target: { value: "Newsletters" } }
    )
    fireEvent.click(screen.getByRole("combobox", { name: "Add action" }))
    await chooseOption("Mark read")
    fireEvent.click(screen.getByRole("button", { name: "Create Quick Step" }))

    expect(
      await screen.findByTestId("settings-quick-step-row")
    ).toBeTruthy()
    const rowEl = row("Newsletters")
    expect(rowEl.textContent).toContain("+ Label “Newsletters”")
    expect(rowEl.textContent).toContain("Mark read")
    const stored = await listQuickSteps(executor)
    expect(stored[0]!.actions[0]).toEqual({
      kind: "add_label",
      label: "Newsletters",
    })
  })

  it("edits name and shortcut through the dialog; taken digits are disabled", async () => {
    await seedStep("First", "1")
    await seedStep("Second")
    render(<QuickStepsSection />)

    fireEvent.click(await screen.findByRole("button", { name: "Edit Second" }))
    const name = screen.getByLabelText("Name") as HTMLInputElement
    expect(name.value).toBe("Second")

    // Digit 1 is taken by "First" — disabled in the picker.
    fireEvent.click(screen.getByRole("combobox", { name: "Keyboard shortcut" }))
    const taken = await screen.findByRole("option", { name: /^1 — used by/ })
    expect(
      taken.getAttribute("aria-disabled") === "true" ||
        taken.hasAttribute("data-disabled")
    ).toBe(true)
    await chooseOption("3")
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    await waitFor(async () => {
      const steps = await listQuickSteps(executor)
      const second = steps.find((step) => step.name === "Second")
      expect(second?.shortcut).toBe("3")
    })
    // The row shows the new kbd badge.
    expect(row("Second").textContent).toContain("3")
  })

  it("reorders rows with the up control and persists the neighbor swap", async () => {
    await seedStep("A")
    await seedStep("B")
    render(<QuickStepsSection />)
    await screen.findByText("A")

    fireEvent.click(screen.getByRole("button", { name: "Move B up" }))

    await waitFor(async () => {
      const names = (await listQuickSteps(executor)).map((step) => step.name)
      expect(names).toEqual(["B", "A"])
    })
    // The DOM re-renders in the stored order.
    await waitFor(() => {
      const rows = screen.getAllByTestId("settings-quick-step-row")
      expect(rows[0]!.textContent).toContain("B")
    })
  })

  it("deletes a row through the service", async () => {
    await seedStep("Doomed")
    render(<QuickStepsSection />)
    await screen.findByTestId("settings-quick-step-row")

    fireEvent.click(screen.getByRole("button", { name: "Delete Doomed" }))

    await waitFor(async () => {
      expect(await listQuickSteps(executor)).toEqual([])
    })
    expect(screen.queryByTestId("settings-quick-step-row")).toBeNull()
  })
})
