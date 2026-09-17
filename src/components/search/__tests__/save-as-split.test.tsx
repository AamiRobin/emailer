import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { listSplits } from "@/services/settings/splits"
import { setSplitsSectionExecutor } from "@/components/layout/use-splits"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { SearchField } from "../search-field"

/**
 * "Save as Split" affordance (task 9.3, mailbox-ui spec "Create a split
 * from a search"): the button renders only while a search view with a
 * query is active, and saving goes through the real createSplitWithToast
 * flow (create + notify + ENTER the split) against a seeded node:sqlite
 * executor — the assertion reads the row back through the same CRUD layer
 * the tab bar reloads from. The toast is mocked (sonner renders nothing
 * under jsdom).
 */

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

const toastMock = vi.mocked(toast)

const QUERY = "from:boss@work.com"

function resetUiStore(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    previousView: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    listScope: null,
  })
}

beforeEach(() => {
  resetUiStore()
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  setSplitsSectionExecutor(null)
  resetUiStore()
})

describe("SaveAsSplitButton (task 9.3)", () => {
  it("shows no affordance outside a search view", () => {
    render(<SearchField />)
    expect(screen.queryByTestId("save-as-split-button")).toBeNull()
  })

  it("creates a split from the active query and enters it", async () => {
    const executor: TestExecutor = createTestExecutor()
    setSplitsSectionExecutor(executor)
    useUiStore.getState().setView({ kind: "search", query: QUERY })
    render(<SearchField />)

    fireEvent.click(screen.getByRole("button", { name: "Save as Split" }))

    // The dialog prefills the query from the current search.
    const dialog = await screen.findByRole("dialog")
    const queryInput = within(dialog).getByLabelText(
      "Query"
    ) as HTMLInputElement
    expect(queryInput.value).toBe(QUERY)
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Boss mail" },
    })
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create split" })
    )

    // Dialog closes on success and the toast confirms the save.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(toastMock.success).toHaveBeenCalledTimes(1)

    // The write went through the real CRUD layer — the exact rows the tab
    // bar lists — and the split became the active list scope.
    const stored = await listSplits(executor)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ name: "Boss mail", query: QUERY })
    await waitFor(() =>
      expect(useUiStore.getState().listScope).toEqual({
        kind: "split",
        name: "Boss mail",
        query: QUERY,
      })
    )
    executor.close()
  })

  it("keeps the dialog open with a form error on a duplicate name", async () => {
    const executor: TestExecutor = createTestExecutor()
    setSplitsSectionExecutor(executor)
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [
        "mail.splits",
        JSON.stringify([
          { id: "s-1", name: "Boss mail", query: "is:unread", position: 0 },
        ]),
      ]
    )
    useUiStore.getState().setView({ kind: "search", query: QUERY })
    render(<SearchField />)

    fireEvent.click(screen.getByRole("button", { name: "Save as Split" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "boss mail" },
    })
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create split" })
    )

    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(await listSplits(executor)).toHaveLength(1)
    executor.close()
  })

  it("does not create a split without a name", async () => {
    const executor: TestExecutor = createTestExecutor()
    setSplitsSectionExecutor(executor)
    useUiStore.getState().setView({ kind: "search", query: QUERY })
    render(<SearchField />)

    fireEvent.click(screen.getByRole("button", { name: "Save as Split" }))
    await screen.findByRole("dialog")
    expect(
      (
        screen.getByRole("button", {
          name: "Create split",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    expect(await listSplits(executor)).toEqual([])
    executor.close()
  })
})
