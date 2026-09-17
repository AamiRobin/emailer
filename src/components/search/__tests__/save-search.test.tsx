import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import { createTestExecutor } from "@/services/db/__tests__/test-executor"
import { listSavedSearches } from "@/services/db/saved-searches"
import { setSavedSearchesSectionExecutor } from "@/components/layout/use-saved-searches"
import { SearchField } from "../search-field"

/**
 * "Save search" affordance (task 7.2, mail-search spec "Save the current
 * query"): the button renders only while a search view with a query is
 * active, and saving goes through the real saveSearch flow (create +
 * notify) against a seeded node:sqlite executor — the assertion reads the
 * row back through the same CRUD layer the sidebar section reloads from.
 * The toast is mocked (sonner renders nothing under jsdom).
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

import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"

const QUERY = "is:unread from:client.com has:attachment"

function resetUiStore(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    previousView: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
  })
}

beforeEach(() => {
  resetUiStore()
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  setSavedSearchesSectionExecutor(null)
  resetUiStore()
})

describe("SaveSearchButton (task 7.2)", () => {
  it("shows no save affordance outside a search view", () => {
    render(<SearchField />)
    expect(screen.queryByTestId("save-search-button")).toBeNull()
    expect(screen.queryByTestId("search-query-chip")).toBeNull()
  })

  it("saves the active query under the entered name", async () => {
    const executor = createTestExecutor()
    setSavedSearchesSectionExecutor(executor)
    useUiStore.getState().setView({ kind: "search", query: QUERY })
    render(<SearchField />)

    // The affordance rides along with the query chip.
    expect(await screen.findByTestId("search-query-chip")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save search" }))

    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(QUERY)
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Client escalations" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    // Dialog closes on success and the toast confirms the save.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(toastMock.success).toHaveBeenCalledTimes(1)
    expect(String(toastMock.success.mock.calls[0]![0])).toContain(
      "Client escalations"
    )

    // The write went through the real CRUD layer — the exact rows the
    // Saved Searches section lists.
    const rows = await listSavedSearches(executor)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: "Client escalations",
      query: QUERY,
    })
    executor.close()
  })

  it("keeps the dialog open and does not create a row without a name", async () => {
    const executor = createTestExecutor()
    setSavedSearchesSectionExecutor(executor)
    useUiStore.getState().setView({ kind: "search", query: QUERY })
    render(<SearchField />)

    fireEvent.click(screen.getByRole("button", { name: "Save search" }))
    await screen.findByRole("dialog")
    // The submit is disabled while the name is blank.
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    expect(await listSavedSearches(executor)).toEqual([])
    executor.close()
  })
})
