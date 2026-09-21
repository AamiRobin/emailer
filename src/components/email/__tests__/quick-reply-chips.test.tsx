import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

/**
 * Quick-reply chips tests (parity-round-2 task 2.4, ai-assistance spec
 * "AI quick reply suggestions"). The generation service is mocked at its
 * module seam (the assertions target the frozen UI flow), while the
 * INSERTION runs through the REAL reply-opener against a seeded
 * node:sqlite database — so tapping a chip asserts the actual
 * composer-store contract: reply mode addressed to the sender, the
 * suggestion as the editable body, and NOTHING sent automatically (only
 * the shell's composerOpen bridge flag flips; no send path exists in the
 * chips at all).
 */

const generateQuickRepliesMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/ai/quick-replies", () => ({
  generateQuickReplies: generateQuickRepliesMock,
  MAX_QUICK_REPLIES: 3,
}))

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

import { createMessage, createThread } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { useComposerStore } from "@/stores/composer-store"
import { setFolderCountsStoreExecutor } from "@/stores/folder-counts-store"
import {
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { QuickReplyChips } from "../quick-reply-chips"

let executor: TestExecutor
let accountId: string
let threadId: string

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
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
  useThreadListStore.setState({
    accountId: null,
    view: null,
    threads: [],
    drafts: [],
    labelsByThreadId: {},
    loading: false,
    loaded: false,
  })
}

beforeEach(async () => {
  resetStores()
  executor = createTestExecutor()
  executorHolder.current = executor
  setThreadListStoreExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
  generateQuickRepliesMock.mockReset()

  accountId = "acc-1"
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [accountId, "gmail", "me@example.com"]
  )
  threadId = await createThread(executor, accountId, { subject: "Kickoff" })
  await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000,
    subject: "Kickoff",
    fromName: "Grace Hopper",
    fromAddress: "grace@example.com",
    bodyText: "Can we move the review to Thursday?",
    isRead: true,
  })
  useAccountStore.setState({ activeAccountId: accountId, loaded: true })
})

afterEach(async () => {
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  executorHolder.current = null
  executor.close()
})

function renderChips(props: { disabled?: boolean } = {}) {
  render(
    <QuickReplyChips
      threadId={threadId}
      accountId={accountId}
      disabled={props.disabled ?? false}
    />
  )
}

describe("QuickReplyChips rendering", () => {
  it("renders up to three suggestion chips once generation lands", async () => {
    generateQuickRepliesMock.mockResolvedValue({
      ok: true,
      replies: ["Thursday works for me.", "Wednesday instead?", "What time?"],
      cached: false,
    })
    renderChips()

    const chips = await screen.findByTestId("quick-reply-chips")
    expect(chips).toBeTruthy()
    expect(screen.getAllByTestId("quick-reply-chip")).toHaveLength(3)
    expect(screen.getByText("Thursday works for me.")).toBeTruthy()
    expect(generateQuickRepliesMock).toHaveBeenCalledWith(
      executor,
      accountId,
      threadId
    )
  })

  it("renders nothing while the suggestions are loading", async () => {
    generateQuickRepliesMock.mockReturnValue(new Promise(() => {}))
    renderChips()

    expect(screen.queryByTestId("quick-reply-chips")).toBeNull()
  })

  it("renders nothing for a closed gate or a failed generation (hide posture)", async () => {
    generateQuickRepliesMock.mockResolvedValue({
      ok: false,
      reason: "surface-disabled",
    })
    const { container: first } = render(
      <QuickReplyChips threadId={threadId} accountId={accountId} />
    )
    await vi.waitFor(() => {
      expect(first.querySelector('[data-testid="quick-reply-chips"]')).toBeNull()
    })

    generateQuickRepliesMock.mockResolvedValue({
      ok: false,
      reason: "provider",
      message: "boom",
    })
    const { container: second } = render(
      <QuickReplyChips threadId={threadId} accountId={accountId} />
    )
    await vi.waitFor(() => {
      expect(
        second.querySelector('[data-testid="quick-reply-chips"]')
      ).toBeNull()
    })
  })
})

describe("QuickReplyChips insertion (composer-store contract)", () => {
  it("opens the composer as an editable reply to the sender — nothing sent", async () => {
    generateQuickRepliesMock.mockResolvedValue({
      ok: true,
      replies: ["Thursday works for me."],
      cached: true,
    })
    renderChips()
    fireEvent.click(await screen.findByTestId("quick-reply-chip"))

    await vi.waitFor(() => {
      expect(useComposerStore.getState().open).toBe(true)
    })
    const composer = useComposerStore.getState()
    // Reply mode against the thread, addressed to its latest sender.
    expect(composer.mode).toMatchObject({
      kind: "reply",
      replyAll: false,
      sourceThreadId: threadId,
    })
    expect(composer.to).toEqual([
      { name: "Grace Hopper", email: "grace@example.com" },
    ])
    expect(composer.subject).toBe("Re: Kickoff")
    // The suggestion IS the editable draft body…
    expect(composer.html).toContain("Thursday works for me.")
    expect(composer.html).not.toContain("<blockquote")
    // …and NOTHING was sent: the chips hold no send path — the only
    // effect is the composer store + the shell bridge flag (the composer
    // overlay opens for the user to edit and, explicitly, to send).
    expect(useUiStore.getState().composerOpen).toBe(true)
  })

  it("keeps the chips when the composer cannot open (no draft is lost silently)", async () => {
    generateQuickRepliesMock.mockResolvedValue({
      ok: true,
      replies: ["Sounds good."],
      cached: false,
    })
    // No thread behind the id: the opener resolves false, composer stays
    // closed, the chips remain for a retry.
    render(
      <QuickReplyChips
        threadId="no-such-thread"
        accountId={accountId}
      />
    )
    fireEvent.click(await screen.findByTestId("quick-reply-chip"))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useComposerStore.getState().open).toBe(false)
    expect(screen.getByTestId("quick-reply-chip")).toBeTruthy()
  })
})
