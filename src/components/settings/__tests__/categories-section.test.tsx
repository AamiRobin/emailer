import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * Categories settings section tests (task 3.5, design D4, mailbox-ui
 * spec "Category tab presentation" + mail-organization spec "Automatic
 * categorization"). The section's data hook is the REAL use-categories
 * module against the injected node:sqlite executor (the executor-module
 * seam + setCategoriesSectionExecutor, the tab-bar suite's pattern) —
 * the enable toggle and the backfill affordance exercise the real
 * persistence and the real notify/reactivity path. Only the backfill
 * JOB module is faked (the same observable snapshot shape the
 * category-backfill-status suite uses), because the job's own slicing
 * has its own suites; the toast is mocked (sonner renders nothing under
 * jsdom).
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
    startCategoryBackfill: vi.fn(async () => backfillFake.state.progress),
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

import { startCategoryBackfill } from "@/services/categorization/backfill"
import {
  getCategoriesEnabled,
  CATEGORIES_ENABLED_SETTING_KEY,
} from "@/services/settings/categories"
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
import { setCategoriesSectionExecutor } from "@/components/layout/use-categories"
import { useUiStore } from "@/stores/ui-store"
import { CategoriesSection } from "../categories-section"

const startBackfillMock = vi.mocked(startCategoryBackfill)

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
  useUiStore.setState({ listScope: null })
})

afterEach(() => {
  cleanup()
  setCategoriesSectionExecutor(null)
  executor.close()
})

describe("CategoriesSection tab visibility toggle", () => {
  it("defaults to off and persists an enable through the real setting", async () => {
    render(<CategoriesSection />)
    const toggle = screen.getByTestId("categories-enabled-switch")
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    )

    fireEvent.click(toggle)
    // The click's persist-then-notify lands the re-render first; the
    // settings row is readable right after.
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"))
    expect(await getCategoriesEnabled(executor)).toBe(true)
  })

  it("hides the back-categorization row while disabled and shows it when enabled", async () => {
    render(<CategoriesSection />)
    await waitFor(() =>
      expect(
        screen
          .getByTestId("categories-enabled-switch")
          .getAttribute("aria-checked")
      ).toBe("false")
    )
    expect(
      screen.queryByTestId("categorize-existing-button")
    ).toBeNull()

    fireEvent.click(screen.getByTestId("categories-enabled-switch"))

    expect(
      await screen.findByTestId("categorize-existing-button")
    ).toBeTruthy()
    // The progress surface ships with the enabled state.
    expect(screen.getByLabelText("Categorize existing mail")).toBeTruthy()
  })

  it("shows the persisted on state on a fresh mount and persists a disable", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [CATEGORIES_ENABLED_SETTING_KEY, JSON.stringify(true)]
    )

    render(<CategoriesSection />)
    expect(
      await screen.findByTestId("categorize-existing-button")
    ).toBeTruthy()

    fireEvent.click(screen.getByTestId("categories-enabled-switch"))

    await waitFor(() =>
      expect(
        screen
          .getByTestId("categories-enabled-switch")
          .getAttribute("aria-checked")
      ).toBe("false")
    )
    expect(await getCategoriesEnabled(executor)).toBe(false)
    await waitFor(() =>
      expect(
        screen.queryByTestId("categorize-existing-button")
      ).toBeNull()
    )
  })
})

describe("CategoriesSection back-categorization affordance", () => {
  it("launches a fresh backfill through the hook's real entry point", async () => {
    render(<CategoriesSection />)
    fireEvent.click(screen.getByTestId("categories-enabled-switch"))
    const button = await screen.findByTestId("categorize-existing-button")

    fireEvent.click(button)

    await waitFor(() => expect(startBackfillMock).toHaveBeenCalledTimes(1))
    const [executorArg, options] = startBackfillMock.mock.calls[0]
    expect(executorArg).toBe(executor)
    expect(options).toEqual({ fresh: true })
  })

  it("disables the affordance while the job is in flight", async () => {
    render(<CategoriesSection />)
    fireEvent.click(screen.getByTestId("categories-enabled-switch"))
    const button = await screen.findByTestId("categorize-existing-button")

    // Nothing ran yet: enabled.
    await waitFor(() => expect(button).toHaveProperty("disabled", false))

    backfillFake.emit({ running: true, scanned: 1, categorized: 1 })
    await waitFor(() => expect(button).toHaveProperty("disabled", true))

    // The job finishing (even between slices) re-opens the entry.
    backfillFake.emit({ running: false, done: true, scanned: 2 })
    await waitFor(() => expect(button).toHaveProperty("disabled", false))
  })

  it("shows the job's progress line while it runs and hides it when done", async () => {
    await seedUncategorizedThreads(2)
    render(<CategoriesSection />)
    fireEvent.click(screen.getByTestId("categories-enabled-switch"))
    await screen.findByTestId("categorize-existing-button")

    expect(screen.queryByTestId("category-backfill-status")).toBeNull()

    backfillFake.emit({ running: true, scanned: 1, categorized: 1 })
    const line = await screen.findByTestId("category-backfill-status")
    // "N of M": 1 scanned + the 2 remaining NULL-category candidates the
    // live SQL counts (the fake never writes categories) → 1 of 3.
    await waitFor(() =>
      expect(
        line.querySelector("[data-testid='category-backfill-progress']")
          ?.textContent
      ).toBe("Categorizing… 1 of 3")
    )

    backfillFake.emit({ running: false, done: true })
    await waitFor(() =>
      expect(screen.queryByTestId("category-backfill-status")).toBeNull()
    )
  })
})
