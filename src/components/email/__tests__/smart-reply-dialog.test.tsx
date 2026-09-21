import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * Smart-reply dialog tests (task 4.5, ai-assistance spec "Writing-style
 * smart replies"). The AI services are mocked at their module seams (the
 * assertions target the frozen UI flow), while the INSERTION runs through
 * the REAL reply-opener against a seeded node:sqlite database — so "Use
 * reply" asserts the actual composer-store contract: openWith reply mode,
 * the suggestion replacing the quoted draft body, and the shell's
 * composerOpen bridge flag.
 */

const loadStyleProfileMock = vi.hoisted(() => vi.fn())
const buildWritingStyleProfileMock = vi.hoisted(() => vi.fn())
const deleteStyleProfileMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/ai/style-profile", () => ({
  loadStyleProfile: loadStyleProfileMock,
  buildWritingStyleProfile: buildWritingStyleProfileMock,
  deleteStyleProfile: deleteStyleProfileMock,
}))

const generateSmartReplyMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/ai/smart-replies", () => ({
  generateSmartReply: generateSmartReplyMock,
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
import { SmartReplyDialog } from "../smart-reply-dialog"

let executor: TestExecutor
let accountId: string
let threadId: string

const SUGGESTION = "Hi Grace — Thursday works for me. Best, Sam"

function storedProfile() {
  return {
    profile: {
      version: 1 as const,
      tone: "warm",
      formality: "business-casual",
      typicalLength: "short",
      greetings: ["Hi NAME"],
      signOffs: ["Best,"],
      phrasing: [],
    },
    builtAt: 1_700_000_500,
    sampleSize: 12,
  }
}

function renderDialog(onOpenChange = vi.fn()) {
  const onOpenChangeSpy = onOpenChange
  render(
    <SmartReplyDialog
      threadId={threadId}
      accountId={accountId}
      open
      onOpenChange={onOpenChangeSpy}
    />
  )
  return onOpenChangeSpy
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
  loadStyleProfileMock.mockReset()
  buildWritingStyleProfileMock.mockReset()
  generateSmartReplyMock.mockReset()
  deleteStyleProfileMock.mockReset()

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
  // Let in-flight promise chains settle against the live executor.
  await new Promise((resolve) => setTimeout(resolve, 0))
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  executorHolder.current = null
  executor.close()
})

describe("SmartReplyDialog consent step", () => {
  it("shows the consent card FIRST when no profile is stored", async () => {
    loadStyleProfileMock.mockResolvedValue(null)
    renderDialog()

    const consent = await screen.findByTestId("smart-reply-consent")
    // The spec's consent copy: recent sent mail is analyzed; nothing
    // sends on its own.
    expect(consent.textContent).toMatch(/analyzes your recent sent messages/)
    expect(consent.textContent).toMatch(/Nothing is sent automatically/)
    expect(screen.queryByTestId("smart-reply-generate")).toBeNull()
  })

  it("builds the profile on request, reports the sample size, and proceeds to Generate", async () => {
    loadStyleProfileMock.mockResolvedValue(null)
    buildWritingStyleProfileMock.mockResolvedValue({ ok: true, sampleSize: 12 })
    renderDialog()
    await screen.findByTestId("smart-reply-consent")

    fireEvent.click(screen.getByTestId("smart-reply-build"))

    expect(buildWritingStyleProfileMock).toHaveBeenCalledWith(
      executor,
      accountId
    )
    expect(
      (await screen.findByTestId("smart-reply-built-info")).textContent
    ).toContain("Profile built from 12 sent messages.")
    expect(screen.getByTestId("smart-reply-generate")).toBeTruthy()
  })

  it("renders build failures inline with the typed reason's copy", async () => {
    loadStyleProfileMock.mockResolvedValue(null)
    buildWritingStyleProfileMock.mockResolvedValue({
      ok: false,
      reason: "no-sent-mail",
    })
    renderDialog()
    await screen.findByTestId("smart-reply-consent")

    fireEvent.click(screen.getByTestId("smart-reply-build"))

    const error = await screen.findByTestId("smart-reply-error")
    expect(error.textContent).toContain(
      "No recent sent messages were found to analyze."
    )
    // Retry re-runs the build step.
    buildWritingStyleProfileMock.mockResolvedValue({ ok: true, sampleSize: 3 })
    fireEvent.click(screen.getByTestId("smart-reply-retry"))
    expect(await screen.findByTestId("smart-reply-generate")).toBeTruthy()
  })
})

describe("SmartReplyDialog generate step", () => {
  it("skips consent when a profile is stored and generates on request", async () => {
    loadStyleProfileMock.mockResolvedValue(storedProfile())
    generateSmartReplyMock.mockResolvedValue({
      ok: true,
      reply: SUGGESTION,
      cached: false,
    })
    renderDialog()

    expect(await screen.findByTestId("smart-reply-generate")).toBeTruthy()
    expect(screen.queryByTestId("smart-reply-consent")).toBeNull()

    fireEvent.click(screen.getByTestId("smart-reply-generate"))

    expect(generateSmartReplyMock).toHaveBeenCalledWith(
      executor,
      accountId,
      threadId,
      {}
    )
    expect(
      (await screen.findByTestId("smart-reply-text")).textContent
    ).toContain(SUGGESTION)
  })

  it("regenerate re-calls the service with regenerate: true and shows the new text", async () => {
    loadStyleProfileMock.mockResolvedValue(storedProfile())
    generateSmartReplyMock.mockResolvedValueOnce({
      ok: true,
      reply: "First draft.",
      cached: true,
    })
    renderDialog()
    await screen.findByTestId("smart-reply-generate")
    fireEvent.click(screen.getByTestId("smart-reply-generate"))
    await screen.findByTestId("smart-reply-preview")

    generateSmartReplyMock.mockResolvedValueOnce({
      ok: true,
      reply: "Second draft.",
      cached: false,
    })
    fireEvent.click(screen.getByTestId("smart-reply-regenerate"))

    expect(generateSmartReplyMock).toHaveBeenLastCalledWith(
      executor,
      accountId,
      threadId,
      { regenerate: true }
    )
    expect(
      (await screen.findByTestId("smart-reply-text")).textContent
    ).toContain("Second draft.")
  })

  it("renders generation failures inline with a working Retry", async () => {
    loadStyleProfileMock.mockResolvedValue(storedProfile())
    generateSmartReplyMock.mockResolvedValueOnce({
      ok: false,
      reason: "provider",
      message: "network unreachable",
    })
    renderDialog()
    await screen.findByTestId("smart-reply-generate")
    fireEvent.click(screen.getByTestId("smart-reply-generate"))

    const error = await screen.findByTestId("smart-reply-error")
    expect(error.textContent).toContain("network unreachable")

    generateSmartReplyMock.mockResolvedValueOnce({
      ok: true,
      reply: SUGGESTION,
      cached: false,
    })
    fireEvent.click(screen.getByTestId("smart-reply-retry"))
    expect(await screen.findByTestId("smart-reply-preview")).toBeTruthy()
  })
})

describe("SmartReplyDialog use-reply insertion (composer-store contract)", () => {
  it("opens the composer in reply mode with the suggestion as the body and closes", async () => {
    loadStyleProfileMock.mockResolvedValue(storedProfile())
    generateSmartReplyMock.mockResolvedValue({
      ok: true,
      reply: SUGGESTION,
      cached: false,
    })
    const onOpenChange = vi.fn()
    renderDialog(onOpenChange)
    await screen.findByTestId("smart-reply-generate")
    fireEvent.click(screen.getByTestId("smart-reply-generate"))
    await screen.findByTestId("smart-reply-preview")

    fireEvent.click(screen.getByTestId("smart-reply-use"))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    const composer = useComposerStore.getState()
    expect(composer.open).toBe(true)
    expect(composer.mode).toMatchObject({
      kind: "reply",
      replyAll: false,
      sourceThreadId: threadId,
    })
    // Plain reply targets the thread's latest sender.
    expect(composer.to).toEqual([
      { name: "Grace Hopper", email: "grace@example.com" },
    ])
    expect(composer.subject).toBe("Re: Kickoff")
    // The suggestion REPLACES the quoted draft body (task 4.5 decision)…
    expect(composer.html).toContain("Thursday works for me")
    expect(composer.html).not.toContain("<blockquote")
    // …and the whole flow stays an editable draft: only the shell bridge
    // flag flipped — nothing was queued or sent anywhere.
    expect(useUiStore.getState().composerOpen).toBe(true)
  })

  it("keeps the dialog open when the insertion cannot run", async () => {
    loadStyleProfileMock.mockResolvedValue(storedProfile())
    generateSmartReplyMock.mockResolvedValue({
      ok: true,
      reply: SUGGESTION,
      cached: false,
    })
    // No thread behind the id: openSmartReplyForThread resolves false and
    // the composer must stay untouched.
    threadId = "no-such-thread"
    const onOpenChange = vi.fn()
    renderDialog(onOpenChange)
    await screen.findByTestId("smart-reply-generate")
    fireEvent.click(screen.getByTestId("smart-reply-generate"))
    await screen.findByTestId("smart-reply-preview")

    fireEvent.click(screen.getByTestId("smart-reply-use"))

    await waitFor(() => expect(onOpenChange).not.toHaveBeenCalled())
    expect(useComposerStore.getState().open).toBe(false)
  })
})
