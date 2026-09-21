import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * The backfill progress surface (task 3.5, mail-organization spec
 * "Automatic categorization": back-categorization "with a progress
 * summary"). The backfill job module is faked with a controllable
 * snapshot + emitter (the same observable shape as the real module) so
 * the test drives the subscribable state: the status row renders while a
 * job is in flight with its "N of M" estimate, hides when idle/done, the
 * Cancel button reaches the job, and the done transition toasts the
 * summary once and refreshes the list.
 */

const backfillFake = vi.hoisted(() => {
  type Progress = {
    running: boolean
    scanned: number
    categorized: number
    done: boolean
    cancelled: boolean
  }
  const state: {
    progress: Progress
    listeners: Set<(progress: Progress) => void>
  } = {
    progress: {
      running: false,
      scanned: 0,
      categorized: 0,
      done: false,
      cancelled: false,
    },
    listeners: new Set(),
  }
  return {
    state,
    emit(patch: Partial<Progress>): void {
      state.progress = { ...state.progress, ...patch }
      for (const listener of state.listeners) listener(state.progress)
    },
    reset(): void {
      state.progress = {
        running: false,
        scanned: 0,
        categorized: 0,
        done: false,
        cancelled: false,
      }
      state.listeners.clear()
    },
  }
})

vi.mock("@/services/categorization/backfill", async (importOriginal) => {
  void importOriginal
  return {
    CATEGORY_BACKFILL_DUE_JOB: "categorization.backfill",
    CATEGORY_BACKFILL_BATCH_SIZE: 200,
    CATEGORY_BACKFILL_MAX_BATCHES_PER_RUN: 5,
    getCategoryBackfillProgress: () => backfillFake.state.progress,
    subscribeCategoryBackfillProgress: (
      listener: (progress: {
        running: boolean
        scanned: number
        categorized: number
        done: boolean
        cancelled: boolean
      }) => void
    ) => {
      backfillFake.state.listeners.add(listener)
      return () => {
        backfillFake.state.listeners.delete(listener)
      }
    },
    cancelCategoryBackfill: vi.fn(),
    startCategoryBackfill: vi.fn(),
  }
})

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

import { cancelCategoryBackfill } from "@/services/categorization/backfill"
import {
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  registerCategoryListRefresh,
  setCategoriesSectionExecutor,
  useCategoriesEnabled,
} from "../use-categories"
import { CategoryBackfillStatus } from "../category-backfill-status"
import {
  refreshThreadList,
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"

/** Mounts the status row (plus the enable hook, like the tab bar does). */
function StatusHarness() {
  useCategoriesEnabled()
  return <CategoryBackfillStatus />
}

let executor: TestExecutor

async function seedUncategorizedThreads(count: number): Promise<void> {
  const accountId = await createAccount(executor, "gmail")
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  for (let index = 0; index < count; index += 1) {
    const threadId = await createThread(executor, accountId, {
      subject: `Thread ${index}`,
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000 + index,
      subject: `Thread ${index}`,
      fromAddress: `s${index}@x.com`,
    })
    await executor.execute(
      "UPDATE threads SET folder_label_id = $1 WHERE id = $2",
      [inbox, threadId]
    )
  }
}

beforeEach(() => {
  backfillFake.reset()
  vi.clearAllMocks()
  executor = createTestExecutor()
  setCategoriesSectionExecutor(executor)
  setThreadListStoreExecutor(executor)
  // The status surface refreshes through the use-categories seam (the
  // tab bar normally registers the list store's refresh); here the test
  // registers the real one against the injected executor.
  registerCategoryListRefresh(refreshThreadList)
})

afterEach(() => {
  cleanup()
  setCategoriesSectionExecutor(null)
  setThreadListStoreExecutor(null)
  executor.close()
})

describe("category backfill status (task 3.5)", () => {
  it("renders nothing while no job ran", () => {
    render(<StatusHarness />)
    expect(screen.queryByTestId("category-backfill-status")).toBeNull()
  })

  it("shows 'Categorizing… N of M' while a job is in flight, with Cancel", async () => {
    // Two candidates remain → the total estimate is scanned + remaining.
    await seedUncategorizedThreads(2)
    render(<StatusHarness />)

    backfillFake.emit({ running: true, scanned: 1, categorized: 1 })

    const line = await screen.findByTestId("category-backfill-status")
    await waitFor(() =>
      expect(
        line.querySelector("[data-testid='category-backfill-progress']")
          ?.textContent
      ).toBe("Categorizing… 1 of 3")
    )
    expect(screen.getByTestId("category-backfill-cancel")).toBeTruthy()

    // The job is NOT done: the row stays up between scheduler slices.
    backfillFake.emit({ running: false })
    expect(screen.getByTestId("category-backfill-status")).toBeTruthy()
  })

  it("the Cancel button reaches the job's cancel entry point", async () => {
    await seedUncategorizedThreads(1)
    render(<StatusHarness />)
    backfillFake.emit({ running: true, scanned: 0, categorized: 0 })
    await screen.findByTestId("category-backfill-status")

    fireEvent.click(screen.getByTestId("category-backfill-cancel"))
    expect(cancelCategoryBackfill).toHaveBeenCalledTimes(1)
  })

  it("on done: hides the row, toasts the summary once, refreshes the list", async () => {
    await seedUncategorizedThreads(2)
    // Prime the list store so the post-done refresh is observable.
    await refreshThreadList()
    const threadsBefore = threadsSnapshot()
    render(<StatusHarness />)
    backfillFake.emit({ running: true, scanned: 2, categorized: 2 })
    await screen.findByTestId("category-backfill-status")

    backfillFake.emit({ running: false, done: true })

    await waitFor(() =>
      expect(screen.queryByTestId("category-backfill-status")).toBeNull()
    )
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Categorized 2 messages")
    )
    expect(toast.success).toHaveBeenCalledTimes(1)
    // The refresh re-read the (re-categorized) rows.
    await waitFor(() => expect(threadsSnapshot()).not.toBe(threadsBefore))
  })

  it("stays silent for a done job that categorized nothing", async () => {
    render(<StatusHarness />)
    backfillFake.emit({ running: true })
    backfillFake.emit({ running: false, done: true, scanned: 0 })
    await waitFor(() =>
      expect(screen.queryByTestId("category-backfill-status")).toBeNull()
    )
    expect(toast.success).not.toHaveBeenCalled()
  })
})

/** The thread-list store's current rows (the post-done refresh re-reads
 * them from the seeded database — same rows here, but a fresh array). */
function threadsSnapshot(): unknown {
  return useThreadListStore.getState().threads
}
