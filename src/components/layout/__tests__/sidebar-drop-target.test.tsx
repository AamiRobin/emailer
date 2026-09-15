import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import {
  at,
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { recomputeThreadCaches, setThreadLabels } from "@/services/db/threads"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  initAccountStore,
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import {
  setFolderCountsStoreExecutor,
  useFolderCountsStore,
} from "@/stores/folder-counts-store"
import { EMPTY_FOLDER_COUNTS } from "@/services/db/folder-counts"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { setSidebarDataExecutor } from "../use-sidebar-data"
import { Sidebar } from "../sidebar"

/**
 * Sidebar label rows as drop targets (task 10.5): jsdom cannot drive
 * dnd-kit's pointer sensors, so the hover state is forced through a
 * useDroppable mock (the test seam the task prescribes) and the render
 * contract is pinned — every user label row registers under its label id
 * and highlights with the token ring + accent tint while a thread drag
 * is over it, and stays unhighlighted otherwise.
 */

// Mutable state the useDroppable mock reads, so one file can render both
// the idle and the hovered contract.
const dropState = vi.hoisted(() => ({ isOver: false }))

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>()
  return {
    ...actual,
    useDroppable: (() => ({
      setNodeRef: () => {},
      isOver: dropState.isOver,
    })) as unknown as typeof actual.useDroppable,
  }
})

let executor: TestExecutor

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
  })
  useFolderCountsStore.setState({
    accountId: null,
    counts: EMPTY_FOLDER_COUNTS,
  })
}

beforeEach(() => {
  executor = createTestExecutor()
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
  setSidebarDataExecutor(executor)
  resetStores()
})

afterEach(() => {
  cleanup()
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  setSidebarDataExecutor(null)
  executor.close()
  resetStores()
})

async function seedLabel(): Promise<string> {
  const accountId = await createAccount(executor, "gmail")
  await executor.execute("UPDATE accounts SET is_active = 1 WHERE id = $1", [
    accountId,
  ])
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  const threadId = await createThread(executor, accountId)
  await createMessage(executor, {
    threadId,
    accountId,
    date: at(0),
  })
  await recomputeThreadCaches(executor, threadId)
  await setThreadLabels(executor, threadId, [inbox])
  const work = await createGmailLabel(
    executor,
    accountId,
    "Work",
    "Label_work",
    undefined,
    "user"
  )
  await initAccountStore()
  return work
}

function renderSidebar() {
  return render(
    <TooltipProvider delay={0}>
      <Sidebar isCollapsed={false} />
    </TooltipProvider>
  )
}

async function dropTargets() {
  const labelsNav = await screen.findByRole("navigation", { name: "Labels" })
  return labelsNav.querySelectorAll<HTMLElement>("[data-label-drop-target]")
}

describe("sidebar label rows as drop targets (task 10.5)", () => {
  it("registers every user label row under its label id", async () => {
    const work = await seedLabel()
    renderSidebar()
    const targets = await dropTargets()
    expect(targets).toHaveLength(1)
    expect(targets[0].getAttribute("data-label-drop-target")).toBe(work)
    const rowButton = targets[0].querySelector("button")
    expect(rowButton?.textContent).toContain("Work")
  })

  it("highlights the row (ring + accent) while a drag is over it", async () => {
    await seedLabel()
    dropState.isOver = true
    try {
      renderSidebar()
      const targets = await dropTargets()
      expect(targets[0].getAttribute("data-drag-over")).toBe("true")
      expect(targets[0].className).toContain("ring-2")
      expect(targets[0].className).toContain("bg-accent")
    } finally {
      dropState.isOver = false
    }
  })

  it("leaves the row unhighlighted when no drag hovers", async () => {
    await seedLabel()
    renderSidebar()
    const targets = await dropTargets()
    expect(targets[0].getAttribute("data-drag-over")).toBe("false")
    expect(targets[0].className).not.toContain("ring-2")
    expect(targets[0].className).not.toContain("bg-accent")
  })
})
