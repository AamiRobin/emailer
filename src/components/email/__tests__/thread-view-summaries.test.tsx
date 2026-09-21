import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"
import { createMessage, createThread } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
// The provider transport is the seam under mock: everything else in the
// AI stack (settings, summaries service, ai_cache) runs REAL against the
// seeded test executor, so the assertions cover the whole click path
// (toolbar → panel → cache) with only the network faked.
import { AiProviderError } from "@/services/ai/client"
import {
  addProvider,
  setActiveProvider,
  setAiEnabled,
} from "@/services/ai/settings"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { setFolderCountsStoreExecutor } from "@/stores/folder-counts-store"
import {
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { useComposerStore } from "@/stores/composer-store"
import { ThreadView } from "../thread-view"

const aiChatMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/ai/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/client")>()
  return { ...actual, aiChat: aiChatMock }
})

// The quick-reply chips (task 2.4) mount alongside the summary panel in
// ThreadView and share this file's aiChat mock; this suite's call-count
// assertions are about the summaries transport, so the chips surface is
// closed here (its own behavior lives in quick-reply-chips.test.tsx).
vi.mock("@/services/ai/quick-replies", () => ({
  generateQuickReplies: vi.fn().mockResolvedValue({
    ok: false,
    reason: "surface-disabled",
  }),
  MAX_QUICK_REPLIES: 3,
}))

/**
 * Thread-summary reading-pane tests (task 4.4, ai-assistance spec
 * "Thread summaries"). The summaries service, its cache and the AI
 * settings run REAL against the seeded node:sqlite database; only the
 * provider transport (aiChat) is mocked. Covered: the toolbar affordance
 * hides while AI is unconfigured (spec "No provider configured") and
 * appears once configured + the summaries surface is on; a click shows
 * the loading state then the panel with the explicit "AI summary" label
 * and model hint; an unchanged re-open renders the cached summary
 * instantly (the client is NOT called again); a provider failure renders
 * inline with a working Retry; and Regenerate re-calls the transport.
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

let executor: TestExecutor
let accountId: string

function setSelection(threadId: string | null): void {
  useUiStore.setState({ activeThread: threadId })
}

function resetStores(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
  })
  useComposerStore.getState().reset()
  useAccountStore.setState({
    accounts: [
      {
        id: "acc-1",
        type: "gmail",
        email: "acc-1@example.com",
        displayName: null,
        status: "active",
        unreadCount: 0,
      },
    ],
    activeAccountId: null,
    loaded: true,
  })
  useThreadListStore.setState({
    accountId: null,
    view: null,
    threads: [],
    labelsByThreadId: {},
    loading: false,
    loaded: false,
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  resetStores()
  executor = createTestExecutor()
  executorHolder.current = executor
  setThreadListStoreExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
  aiChatMock.mockReset()
})

afterEach(async () => {
  // Let in-flight promise chains (summary loads) settle against the live
  // executor before it is closed.
  await new Promise((resolve) => setTimeout(resolve, 0))
  cleanup()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  executorHolder.current = null
  executor.close()
})

/** A one-message READ thread (no mark-read-on-open refresh noise). */
async function seedThread(): Promise<string> {
  accountId = "acc-1"
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [accountId, "gmail", "me@example.com"]
  )
  const threadId = await createThread(executor, accountId, {
    subject: "Launch plan",
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000,
    subject: "Launch plan",
    fromName: "Alice",
    fromAddress: "alice@example.com",
    bodyText: "We are launching on the 14th.",
    isRead: true,
  })
  return threadId
}

/** Enable AI with an active key-less provider (the mocked aiChat never
 * resolves keys, so no sealing is exercised). */
async function seedActiveProvider(): Promise<void> {
  await setAiEnabled(executor, true)
  const created = await addProvider(executor, {
    kind: "anthropic",
    label: "Work",
    model: "claude-sonnet-4-5",
  })
  await setActiveProvider(executor, created.id)
}

async function openThread(threadId: string): Promise<void> {
  useAccountStore.setState({ activeAccountId: accountId })
  setSelection(threadId)
  await screen.findByTestId("thread-subject")
}

describe("thread summary toolbar affordance (task 4.4)", () => {
  it("is hidden while AI is unconfigured (spec: no AI affordances)", async () => {
    const threadId = await seedThread()
    render(<ThreadView />)
    await openThread(threadId)

    // The availability effect failed toward hidden — the button never
    // appears anywhere (not even disabled).
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByTestId("toolbar-summarize")).toBeNull()
  })

  it("appears when configured and the summaries surface is enabled", async () => {
    const threadId = await seedThread()
    await seedActiveProvider()
    render(<ThreadView />)
    await openThread(threadId)

    expect(await screen.findByTestId("toolbar-summarize")).not.toBeNull()
    // Nothing is requested until the user asks: no panel, no provider call.
    expect(screen.queryByTestId("thread-summary")).toBeNull()
    expect(aiChatMock).not.toHaveBeenCalled()
  })
})

describe("thread summary panel (task 4.4)", () => {
  it("click → loading → summary with the AI label and model hint", async () => {
    const threadId = await seedThread()
    await seedActiveProvider()
    let resolveSummary: (value: string) => void = () => {}
    aiChatMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveSummary = resolve
      })
    )
    render(<ThreadView />)
    await openThread(threadId)

    fireEvent.click(await screen.findByTestId("toolbar-summarize"))

    // Loading state while the (mocked) provider round-trip is pending.
    const panel = await screen.findByTestId("thread-summary")
    expect(
      screen.getByTestId("thread-summary-loading").textContent
    ).toContain("Summarizing")

    resolveSummary("Alice confirmed the launch for the 14th.")
    const text = await screen.findByTestId("thread-summary-text")
    expect(text.textContent).toBe("Alice confirmed the launch for the 14th.")
    // Explicit AI-content labeling (spec) + the model hint.
    expect(panel.textContent).toContain("AI summary")
    expect(panel.textContent).toContain("Generated by claude-sonnet-4-5")
    expect(panel.textContent).not.toContain("cached")
    // The transport saw the summaries surface exactly once.
    expect(aiChatMock).toHaveBeenCalledTimes(1)
    expect(aiChatMock.mock.calls[0][0]).toMatchObject({
      surface: "summaries",
    })
  })

  it("re-opening the unchanged thread renders the cached summary instantly", async () => {
    const threadId = await seedThread()
    await seedActiveProvider()
    aiChatMock.mockResolvedValue("Alice confirmed the launch for the 14th.")
    render(<ThreadView />)
    await openThread(threadId)

    fireEvent.click(await screen.findByTestId("toolbar-summarize"))
    await screen.findByTestId("thread-summary-text")

    // Leave and re-open the thread: a fresh mount (the panel starts
    // closed again) whose Summarize click must hit the ai_cache — no
    // second provider call, instant render.
    aiChatMock.mockClear()
    setSelection(null)
    await screen.findByTestId("thread-empty")
    await openThread(threadId)
    fireEvent.click(await screen.findByTestId("toolbar-summarize"))

    const text = await screen.findByTestId("thread-summary-text")
    expect(text.textContent).toBe("Alice confirmed the launch for the 14th.")
    expect(aiChatMock).not.toHaveBeenCalled()
    expect(screen.getByTestId("thread-summary").textContent).toContain(
      "cached"
    )
  })

  it("renders a provider failure inline and Retry recovers", async () => {
    const threadId = await seedThread()
    await seedActiveProvider()
    aiChatMock.mockRejectedValueOnce(
      new AiProviderError("network", "provider unreachable")
    )
    render(<ThreadView />)
    await openThread(threadId)

    fireEvent.click(await screen.findByTestId("toolbar-summarize"))

    const error = await screen.findByTestId("thread-summary-error")
    expect(error.textContent).toContain("provider unreachable")

    aiChatMock.mockResolvedValueOnce("Recovered summary.")
    fireEvent.click(screen.getByTestId("thread-summary-retry"))
    const text = await screen.findByTestId("thread-summary-text")
    expect(text.textContent).toBe("Recovered summary.")
    expect(aiChatMock).toHaveBeenCalledTimes(2)
  })

  it("Regenerate re-calls the transport for a fresh summary", async () => {
    const threadId = await seedThread()
    await seedActiveProvider()
    aiChatMock.mockResolvedValue("First summary.")
    render(<ThreadView />)
    await openThread(threadId)

    fireEvent.click(await screen.findByTestId("toolbar-summarize"))
    await screen.findByTestId("thread-summary-text")
    expect(aiChatMock).toHaveBeenCalledTimes(1)

    aiChatMock.mockResolvedValue("Fresh look at the thread.")
    fireEvent.click(screen.getByTestId("thread-summary-regenerate"))
    const text = await screen.findByTestId("thread-summary-text")
    expect(text.textContent).toBe("Fresh look at the thread.")
    expect(aiChatMock).toHaveBeenCalledTimes(2)
  })
})
