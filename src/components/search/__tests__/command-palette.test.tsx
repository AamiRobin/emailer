import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

// The assistant command's gate seam (task 3.3, design D6): the palette
// resolves configured+enabled through the AI settings service off the
// shared executor. Mocked here like the ask-inbox suite so the gating is
// deterministic; the rest of the suite is unaffected (the beforeEach
// pins the gate open).
vi.mock("@/services/db/executor", () => ({
  getExecutor: () => ({}),
  placeholders: (count: number, firstIndex = 1): string =>
    Array.from({ length: count }, (_, index) => `$${index + firstIndex}`).join(
      ", "
    ),
}))

vi.mock("@/services/ai/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/ai/settings")>()),
  isAiConfigured: vi.fn(async () => true),
  isSurfaceEnabled: vi.fn(async () => true),
}))

import {
  createAccount,
  createGmailLabel,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { isAiConfigured, isSurfaceEnabled } from "@/services/ai/settings"
import {
  initAccountStore,
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { usePaletteStore } from "@/stores/palette-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { CommandPalette } from "../command-palette"
import { setPaletteLabelsExecutor } from "../use-palette-labels"

/**
 * Render tests drive the real stores against a seeded node:sqlite
 * database (injected via the set*Executor hooks), like the sidebar suite.
 * jsdom lacks two browser APIs cmdk relies on, so they are stubbed:
 * Element.scrollIntoView (selection scrolling) and ResizeObserver
 * (list-height measurement).
 */

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView = () => {}

let executor: TestExecutor

const isAiConfiguredMock = vi.mocked(isAiConfigured)
const isSurfaceEnabledMock = vi.mocked(isSurfaceEnabled)

function resetStores(): void {
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
    assistantOpen: false,
  })
  usePaletteStore.setState({ open: false })
}

/** Active gmail account with three user labels, plus a second account to
 * switch to. */
async function seedAccountsAndLabels(): Promise<{
  firstId: string
  secondId: string
  invoicesId: string
}> {
  const firstId = await createAccount(executor, "gmail")
  await createGmailLabel(
    executor,
    firstId,
    "Work",
    "Label_work",
    undefined,
    "user"
  )
  const invoicesId = await createGmailLabel(
    executor,
    firstId,
    "Work/Invoices",
    "Label_inv",
    undefined,
    "user"
  )
  await createGmailLabel(
    executor,
    firstId,
    "Zeta",
    "Label_zeta",
    undefined,
    "user"
  )
  const secondId = await createAccount(executor, "imap")
  // is_active defaults to 1 per row, so pin the flag deterministically
  // (mirrors account-store's persistActiveAccount) — restore semantics
  // otherwise pick the lexicographically-first id.
  await executor.execute("UPDATE accounts SET is_active = 0")
  await executor.execute("UPDATE accounts SET is_active = 1 WHERE id = $1", [
    firstId,
  ])
  return { firstId, secondId, invoicesId }
}

async function seedAndOpen(): Promise<{
  secondId: string
  invoicesId: string
  input: HTMLInputElement
}> {
  const { secondId, invoicesId } = await seedAccountsAndLabels()
  await initAccountStore()
  render(<CommandPalette />)
  act(() => {
    usePaletteStore.getState().setOpen(true)
  })
  const input = (await screen.findByRole("combobox")) as HTMLInputElement
  await waitFor(() => {
    expect(document.activeElement).toBe(input)
  })
  return { secondId, invoicesId, input }
}

beforeEach(() => {
  executor = createTestExecutor()
  setAccountStoreExecutor(executor)
  setPaletteLabelsExecutor(executor)
  resetStores()
  // Pin the assistant gate open; the gating tests below override with
  // mockResolvedValue, so each states its own expectation.
  isAiConfiguredMock.mockResolvedValue(true)
  isSurfaceEnabledMock.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  setAccountStoreExecutor(null)
  setPaletteLabelsExecutor(null)
  executor.close()
  resetStores()
})

describe("command palette", () => {
  it("renders nothing until the palette store opens it", async () => {
    await seedAccountsAndLabels()
    await initAccountStore()
    render(<CommandPalette />)
    expect(screen.queryByText("Actions")).toBeNull()
    expect(usePaletteStore.getState().open).toBe(false)
  })

  it("renders all groups, focuses the input, and closes on escape", async () => {
    const { input } = await seedAndOpen()

    expect(screen.getByText("Actions")).toBeTruthy()
    expect(screen.getByText("Folders")).toBeTruthy()
    // labels load from the DB via an effect, so their group may land a
    // tick after the open commit
    expect(await screen.findByText("Labels")).toBeTruthy()
    expect(screen.getByText("Accounts")).toBeTruthy()
    expect(screen.getByRole("option", { name: "Compose new message" }))
    expect(screen.getByRole("option", { name: "Search mail" }))
    expect(screen.getByRole("option", { name: "Open settings" }))
    expect(screen.getByRole("option", { name: "Inbox" }))
    expect(screen.getByRole("option", { name: "Trash" }))
    expect(screen.getByRole("option", { name: "Work/Invoices" }))
    expect(screen.queryByText("No matching commands")).toBeNull()

    fireEvent.keyDown(input, { key: "Escape" })
    expect(usePaletteStore.getState().open).toBe(false)
  })

  it("typing filters items across groups", async () => {
    const { input } = await seedAndOpen()

    fireEvent.change(input, { target: { value: "trash" } })

    await waitFor(() => {
      expect(screen.getAllByRole("option").length).toBe(1)
    })
    expect(screen.getByRole("option", { name: "Trash" })).toBeTruthy()
    expect(
      screen.queryByRole("option", { name: "Compose new message" })
    ).toBeNull()
    expect(screen.queryByRole("option", { name: "Work/Invoices" })).toBeNull()
  })

  it("shows the no-results state for a query nothing matches", async () => {
    const { input } = await seedAndOpen()

    fireEvent.change(input, { target: { value: "zzzzzz" } })

    expect(await screen.findByText("No matching commands")).toBeTruthy()
    expect(screen.queryByRole("option")).toBeNull()
  })

  it("selecting a folder sets the view and closes the palette", async () => {
    await seedAndOpen()

    fireEvent.click(screen.getByRole("option", { name: "Trash" }))

    expect(useUiStore.getState().view).toEqual({
      kind: "folder",
      folder: { kind: "specialUse", specialUse: "trash" },
    })
    expect(usePaletteStore.getState().open).toBe(false)
  })

  it("the compose action opens the composer and closes the palette", async () => {
    await seedAndOpen()

    fireEvent.click(screen.getByRole("option", { name: "Compose new message" }))

    expect(useUiStore.getState().composerOpen).toBe(true)
    expect(usePaletteStore.getState().open).toBe(false)
  })

  it("search mail searches for the typed query and closes", async () => {
    const { input } = await seedAndOpen()

    fireEvent.change(input, { target: { value: "mail" } })
    fireEvent.click(await screen.findByRole("option", { name: "Search mail" }))

    expect(useUiStore.getState().view).toEqual({
      kind: "search",
      query: "mail",
    })
    expect(usePaletteStore.getState().open).toBe(false)
    expect(input.getAttribute("value")).toBe("mail")
  })

  it("selecting a label navigates with the full label name", async () => {
    const { invoicesId } = await seedAndOpen()

    fireEvent.click(screen.getByRole("option", { name: "Work/Invoices" }))

    expect(useUiStore.getState().view).toEqual({
      kind: "label",
      labelId: invoicesId,
      name: "Work/Invoices",
    })
    expect(usePaletteStore.getState().open).toBe(false)
  })

  it("an account entry switches the active account and closes", async () => {
    const { secondId } = await seedAndOpen()

    fireEvent.click(
      screen.getByRole("option", {
        name: `Switch to ${secondId}@example.com`,
      })
    )

    expect(useAccountStore.getState().activeAccountId).toBe(secondId)
    expect(usePaletteStore.getState().open).toBe(false)
  })

  it("arrow down + enter executes the next item (keyboard navigation)", async () => {
    const { input } = await seedAndOpen()

    // First item is "Compose new message"; ArrowDown moves the selection
    // to "Search mail", Enter runs it (empty query → empty search view).
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(useUiStore.getState().view).toEqual({ kind: "search", query: "" })
    expect(usePaletteStore.getState().open).toBe(false)
  })
})

/**
 * The assistant command (task 3.3, design D6): the third self-gating
 * entry — offered only while a provider is configured AND the assistant
 * surface is enabled, and its run only flips ui-store.assistantOpen.
 */
describe("command palette — AI assistant command (task 3.3)", () => {
  it("offers the command when configured and enabled; run sets the flag and closes", async () => {
    await seedAndOpen()

    fireEvent.click(screen.getByRole("option", { name: "Open AI assistant" }))

    expect(useUiStore.getState().assistantOpen).toBe(true)
    expect(usePaletteStore.getState().open).toBe(false)
  })

  it("hides the command while the assistant surface is disabled", async () => {
    isSurfaceEnabledMock.mockResolvedValue(false)
    await seedAndOpen()
    // The gate resolved before the assertion — absence is the decision,
    // not a race.
    await waitFor(() => expect(isSurfaceEnabledMock).toHaveBeenCalled())
    expect(
      screen.queryByRole("option", { name: "Open AI assistant" })
    ).toBeNull()
  })

  it("hides the command while no provider is configured", async () => {
    isAiConfiguredMock.mockResolvedValue(false)
    await seedAndOpen()
    await waitFor(() => expect(isAiConfiguredMock).toHaveBeenCalled())
    expect(
      screen.queryByRole("option", { name: "Open AI assistant" })
    ).toBeNull()
  })
})
