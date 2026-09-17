import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Snippets settings section tests (task 6.1). Same executor-injection
 * pattern as the settings-page suite: the executor module is mocked to
 * hand every consumer the shared seeded node:sqlite executor, and the
 * section runs against the real snippets CRUD (no service mocks — the
 * create/update/delete assertions read back through the same executor).
 */

const executorHolder = vi.hoisted(() => ({
  current: null as SqlExecutor | null,
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

import { createSnippet, listSnippets } from "@/services/db/snippets"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { SnippetsSection } from "../snippets-section"

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  executor.close()
})

async function seedSnippet(input: {
  name: string
  body: string
  shortcut?: string
}): Promise<string> {
  return createSnippet(executor, input)
}

describe("SnippetsSection", () => {
  it("shows the empty state when no snippets exist", async () => {
    render(<SnippetsSection />)

    expect(await screen.findByText(/No snippets yet/)).toBeTruthy()
    expect(screen.queryByTestId("settings-snippet-row")).toBeNull()
  })

  it("lists snippets with name, shortcut and body preview", async () => {
    await seedSnippet({
      name: "Thanks",
      body: "Best regards, Alex",
      shortcut: "thx",
    })
    await seedSnippet({ name: "Plain", body: "Just text" })

    render(<SnippetsSection />)

    await screen.findByText("Thanks")
    expect(screen.getByText("Plain")).toBeTruthy()
    expect(screen.getByText("thx")).toBeTruthy()
    expect(screen.getByText("Best regards, Alex")).toBeTruthy()
    expect(screen.getAllByTestId("settings-snippet-row")).toHaveLength(2)
  })

  it("adds a snippet through the dialog and shows the new row", async () => {
    render(<SnippetsSection />)

    fireEvent.click(screen.getByRole("button", { name: "Add Snippet" }))

    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain("Add Snippet")
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Regards" },
    })
    fireEvent.change(screen.getByLabelText("Shortcut (optional)"), {
      target: { value: "rg" },
    })
    fireEvent.change(screen.getByLabelText("Body"), {
      target: { value: "Kind regards" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Snippet" }))

    // The list reloads with the created row…
    expect(await screen.findByText("Regards")).toBeTruthy()
    // …and the write went through the real CRUD layer.
    const rows = await listSnippets(executor)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: "Regards",
      body: "Kind regards",
      shortcut: "rg",
    })
  })

  it("edits a snippet through the dialog with prefilled fields", async () => {
    await seedSnippet({ name: "Old", body: "Old body", shortcut: "old" })

    render(<SnippetsSection />)
    fireEvent.click(await screen.findByRole("button", { name: "Edit Old" }))

    await screen.findByRole("dialog")
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Old"
    )
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed" },
    })
    fireEvent.change(screen.getByLabelText("Shortcut (optional)"), {
      target: { value: "" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    expect(await screen.findByText("Renamed")).toBeTruthy()
    const rows = await listSnippets(executor)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: "Renamed", shortcut: null })
  })

  it("deletes a snippet only after the destructive confirm", async () => {
    await seedSnippet({ name: "Doomed", body: "body" })
    await seedSnippet({ name: "Keeper", body: "body" })

    render(<SnippetsSection />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete Doomed" })
    )

    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain("Doomed")
    expect(dialog.textContent).toContain("cannot be undone")

    // Cancel keeps the row.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })
    expect(screen.getByText("Doomed")).toBeTruthy()

    // Confirm removes it (and only it).
    fireEvent.click(screen.getByRole("button", { name: "Delete Doomed" }))
    fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }))

    await waitFor(() => {
      expect(screen.queryByText("Doomed")).toBeNull()
    })
    expect(screen.getByText("Keeper")).toBeTruthy()
    const rows = await listSnippets(executor)
    expect(rows.map((snippet) => snippet.name)).toEqual(["Keeper"])
  })
})
