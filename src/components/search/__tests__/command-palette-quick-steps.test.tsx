import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * Command palette quick-step entries (task 3.2): one "Run quick step"
 * entry per stored chain in its own group, re-read on every open. The
 * runner is spied (its confirm-once behavior has its own suite); the
 * real stores + real quick-steps service run against a seeded
 * node:sqlite database, same injection pattern as the palette suite.
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

const runWithConfirmMock = vi.hoisted(() => vi.fn(async () => true))

vi.mock("@/services/quick-steps/run-with-confirm", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/services/quick-steps/run-with-confirm")
    >()
  return {
    ...actual,
    runQuickStepWithConfirm: runWithConfirmMock,
  }
})

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView = () => {}

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { createAccount } from "@/services/db/__tests__/fixtures"
import {
  createQuickStep,
  listQuickSteps,
} from "@/services/settings/quick-steps"
import { setAccountStoreExecutor, initAccountStore, useAccountStore } from "@/stores/account-store"
import { useThreadListStore } from "@/stores/thread-list-store"
import type { ThreadRow } from "@/services/db/threads"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { usePaletteStore } from "@/stores/palette-store"
import { CommandPalette } from "../command-palette"
import {
  setPaletteQuickStepsExecutor,
} from "../use-palette-quick-steps"

let executor: TestExecutor

function threadRow(id: string): ThreadRow {
  return {
    id,
    account_id: "acc1",
    subject: `Subject ${id}`,
    snippet: null,
    first_message_at: 1_700_000_000,
    last_message_at: 1_700_000_000,
    message_count: 1,
    unread_count: 1,
    has_attachments: 0,
    is_starred: 0,
    participants: null,
    gmail_thread_id: null,
    folder_label_id: null,
    is_archived: 0,
    is_trashed: 0,
    is_spam: 0,
    created_at: 1_700_000_000,
  }
}

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
  })
  usePaletteStore.setState({ open: false })
  useThreadListStore.setState({
    threads: [threadRow("t1"), threadRow("t2")],
    selectedIds: new Set(["t2"]),
  })
}

async function seedAndOpen(): Promise<void> {
  const accountId = await createAccount(executor, "gmail")
  await executor.execute("UPDATE accounts SET is_active = 1 WHERE id = $1", [
    accountId,
  ])
  await createQuickStep(executor, {
    name: "Cleanup",
    actions: [
      { kind: "mark_read", read: true },
      { kind: "archive" },
    ],
    shortcut: "2",
  })
  await initAccountStore()
  render(<CommandPalette />)
  act(() => {
    usePaletteStore.getState().setOpen(true)
  })
  const input = (await screen.findByRole("combobox")) as HTMLInputElement
  await waitFor(() => {
    expect(document.activeElement).toBe(input)
  })
}

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
  setAccountStoreExecutor(executor)
  setPaletteQuickStepsExecutor(executor)
  resetStores()
})

afterEach(() => {
  cleanup()
  setAccountStoreExecutor(null)
  setPaletteQuickStepsExecutor(null)
  executorHolder.current = null
  executor.close()
  runWithConfirmMock.mockClear()
  resetStores()
})

describe("command palette quick steps (task 3.2)", () => {
  it("lists stored steps in their own group and runs one against the selection", async () => {
    await seedAndOpen()

    expect(await screen.findByText("Quick steps")).toBeTruthy()
    const entry = await screen.findByRole("option", {
      name: "Run quick step: Cleanup",
    })
    fireEvent.click(entry)

    expect(runWithConfirmMock).toHaveBeenCalledTimes(1)
    const call = runWithConfirmMock.mock.calls[0] as unknown[] | undefined
    expect(call).toBeDefined()
    const step = call?.[0] as { name: string }
    const targets = call?.[1] as string[]
    expect(step.name).toBe("Cleanup")
    // The current multi-selection (not the cursor row) is the target.
    expect(targets).toEqual(["t2"])
    // Selecting closes the palette, like every other entry.
    expect(usePaletteStore.getState().open).toBe(false)
  })

  it("re-reads the steps on every open, so edits apply to the next open", async () => {
    await seedAndOpen()
    expect(
      await screen.findByRole("option", { name: "Run quick step: Cleanup" })
    ).toBeTruthy()
    act(() => {
      usePaletteStore.getState().setOpen(false)
    })

    await createQuickStep(executor, {
      name: "Toss",
      actions: [
        { kind: "star" },
        { kind: "trash" },
      ],
    })
    expect((await listQuickSteps(executor)).length).toBe(2)

    act(() => {
      usePaletteStore.getState().setOpen(true)
    })
    expect(
      await screen.findByRole("option", { name: "Run quick step: Toss" })
    ).toBeTruthy()
  })
})
