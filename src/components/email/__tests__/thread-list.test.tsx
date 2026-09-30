import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

const executorHolder = vi.hoisted(() => ({
  current: null as unknown,
}))

// The catch-me-up affordance's dialog (task 7.1) reads through the shared
// executor seam; its digest build is mocked here — the dialog's own suite
// owns its behavior, these tests target the affordance's gates. All other
// stores/services run REAL against the seeded node:sqlite database.
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

const buildFolderDigestMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/ai/folder-digest", () => ({
  buildFolderDigest: buildFolderDigestMock,
}))

import {
  addProvider,
  setActiveProvider,
  setAiEnabled,
  setSurfaceEnabled,
} from "@/services/ai/settings"
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
import { saveDraft } from "@/services/composer/drafts"
import { getActiveComposerDraftKey } from "@/components/email/reply-opener"
import {
  recomputeThreadCaches,
  setThreadLabels,
  setThreadStarred,
} from "@/services/db/threads"
import { updateLabel } from "@/services/db/labels"
import { getSnoozePresets } from "@/services/email-actions/snooze"
import * as threadActions from "@/services/email-actions/thread-actions"
import {
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { setFolderCountsStoreExecutor } from "@/stores/folder-counts-store"
import { useComposerStore } from "@/stores/composer-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import {
  installResizeObserverMock,
  setMockViewportHeight,
  uninstallResizeObserverMock,
} from "./resize-observer-mock"
import { ThreadList } from "../thread-list"

/**
 * Render tests for the real thread list (task 6.4). The ResizeObserver
 * mock gives the virtualizer a viewport; with a tall viewport every group
 * header and row mounts (assertable), with a small one only a bounded
 * window renders (the 10k virtualization proof).
 */

let executor: TestExecutor

function secondsAgo(seconds: number): number {
  return Math.floor(Date.now() / 1000) - seconds
}

const HOUR = 3600
const DAY = 86400

function resetStores(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
    listScope: null,
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
    scope: null,
    threads: [],
    drafts: [],
    labelsByThreadId: {},
    loading: false,
    loaded: false,
    selectedIds: new Set<string>(),
    selectionAnchor: null,
    unreadOnly: false,
  })
}

beforeEach(() => {
  resetStores()
  installResizeObserverMock()
  setMockViewportHeight(10_000)
  executor = createTestExecutor()
  executorHolder.current = executor
  setThreadListStoreExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
})

afterEach(() => {
  cleanup()
  uninstallResizeObserverMock()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  executorHolder.current = null
  executor.close()
})

interface RowSeed {
  subject: string
  seconds: number
  unread?: boolean
  starred?: boolean
  attachments?: boolean
  fromName?: string
  fromAddress?: string
  snippet?: string
}

async function seedThread(
  accountId: string,
  labelIds: string[],
  seed: RowSeed
): Promise<string> {
  const threadId = await createThread(executor, accountId, {
    subject: seed.subject,
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: secondsAgo(seed.seconds),
    subject: seed.subject,
    snippet: seed.snippet ?? `${seed.subject} body preview`,
    fromName: seed.fromName,
    fromAddress: seed.fromAddress,
    isRead: !seed.unread,
    hasAttachments: seed.attachments,
  })
  await recomputeThreadCaches(executor, threadId)
  if (labelIds.length) {
    await setThreadLabels(executor, threadId, labelIds)
  }
  if (seed.starred) {
    await setThreadStarred(executor, threadId)
  }
  return threadId
}

async function setupAccount(): Promise<string> {
  const accountId = await createAccount(executor, "gmail")
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  await seedThread(accountId, [inbox], {
    subject: "Newest unread",
    seconds: 60,
    unread: true,
    attachments: true,
    fromName: "Alice",
    fromAddress: "alice@example.com",
  })
  await seedThread(accountId, [inbox], {
    subject: "Starred read",
    seconds: 90,
    starred: true,
    fromName: "Bob",
    fromAddress: "bob@example.com",
  })
  await seedThread(accountId, [inbox], {
    subject: "Yesterday read",
    seconds: 25 * HOUR,
  })
  await seedThread(accountId, [inbox], {
    subject: "This week read",
    seconds: 3 * DAY,
  })
  await seedThread(accountId, [inbox], {
    subject: "Earlier read",
    seconds: 40 * DAY,
  })
  useAccountStore.setState({ activeAccountId: accountId, loaded: true })
  return accountId
}

describe("thread list rows", () => {
  it("emphasizes unread rows over read rows", async () => {
    await setupAccount()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(
        container.querySelector('[data-thread-row][data-unread="true"]')
      ).not.toBeNull()
    )

    const unreadRow = container.querySelector(
      '[data-thread-row][data-unread="true"]'
    )
    expect(unreadRow?.textContent).toContain("Alice")
    expect(unreadRow?.textContent).toContain("Newest unread")
    // Bolder sender + subject on unread rows.
    expect(unreadRow?.querySelector(".font-semibold")).not.toBeNull()
    expect(unreadRow?.querySelector(".font-medium")).not.toBeNull()
    // Unread dot present.
    expect(unreadRow?.querySelector('[aria-label="Unread"]')).not.toBeNull()

    const readRow = container.querySelector(
      '[data-thread-row][data-unread="false"]'
    )
    expect(readRow?.querySelector(".font-semibold")).toBeNull()
  })

  it("renders star and attachment indicators", async () => {
    await setupAccount()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )

    const starredRow = container.querySelector(
      '[data-thread-row][data-starred="true"]'
    )
    expect(starredRow?.textContent).toContain("Starred read")
    expect(
      starredRow?.querySelector('[aria-pressed="true"][aria-label="Starred"]')
    ).not.toBeNull()

    const unstarredRow = container.querySelector(
      '[data-thread-row][data-starred="false"]'
    )
    expect(
      unstarredRow?.querySelector('[aria-label="Not starred"]')
    ).not.toBeNull()

    const attachmentRow = container.querySelector(
      '[data-thread-row][data-has-attachments="true"]'
    )
    expect(attachmentRow?.textContent).toContain("Newest unread")
    expect(
      attachmentRow?.querySelector('[aria-label="Has attachments"]')
    ).not.toBeNull()
  })

  it("selects a thread through ui-store on click; star clicks do not select", async () => {
    await setupAccount()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )

    const rows = container.querySelectorAll("[data-thread-row]")
    fireEvent.click(rows[0])
    expect(useUiStore.getState().activeThread).toBe(
      rows[0].getAttribute("data-thread-row")
    )
    expect(rows[0].getAttribute("aria-current")).toBe("true")

    // A star click on another row must not move the selection — the star
    // toggles the row's thread (default wiring), never the open state.
    const otherStar = rows[1].querySelector(
      '[aria-label="Starred"], [aria-label="Not starred"]'
    )
    expect(otherStar).not.toBeNull()
    fireEvent.click(otherStar as Element)
    expect(useUiStore.getState().activeThread).toBe(
      rows[0].getAttribute("data-thread-row")
    )
  })

  it("renders gmail label chips with data-color dots, capped at three", async () => {
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const work = await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    const personal = await createGmailLabel(
      executor,
      accountId,
      "Personal",
      "Label_personal",
      undefined,
      "user"
    )
    await updateLabel(executor, personal, { color: "#ff8800" })
    const travel = await createGmailLabel(
      executor,
      accountId,
      "Travel",
      "Label_travel",
      undefined,
      "user"
    )
    const receipts = await createGmailLabel(
      executor,
      accountId,
      "Receipts",
      "Label_receipts",
      undefined,
      "user"
    )
    const threadId = await seedThread(accountId, [inbox], {
      subject: "Chipped",
      seconds: 60,
    })
    await setThreadLabels(executor, threadId, [
      inbox,
      work,
      personal,
      travel,
      receipts,
    ])
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })

    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(
        container.querySelector('[data-label-chip="Personal"]')
      ).not.toBeNull()
    )

    // System labels (INBOX) are folders, not chips; user labels render
    // name-ASC, capped at three with a "+N" overflow.
    const chips = Array.from(
      container.querySelectorAll("[data-label-chip]")
    ).map((chip) => chip.getAttribute("data-label-chip"))
    expect(chips).toEqual(["Personal", "Receipts", "Travel"])
    expect(container.textContent).toContain("+1")

    // Data-color exception: label.color is DB content rendered as-is.
    const dot = container.querySelector('[data-label-chip="Personal"] span')
    expect(dot?.getAttribute("style")).toContain("rgb(255, 136, 0)")
  })

  it("derives row spacing from the --density-row token", async () => {
    await setupAccount()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const row = container.querySelector("[data-thread-row]")
    expect(row?.className).toContain("--density-row")
  })

  it("shows an empty state for an empty folder", async () => {
    await setupAccount()
    useUiStore.setState({
      view: {
        kind: "folder",
        folder: { kind: "specialUse", specialUse: "trash" },
      },
    })
    render(<ThreadList />)
    expect(await screen.findByText(/Nothing in Trash/)).not.toBeNull()
  })
})

describe("thread list date groups", () => {
  it("renders rows newest-first with no date group headers", async () => {
    await setupAccount()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )

    // Date group headers are gone — each card carries its own timestamp.
    expect(container.querySelectorAll("[data-group-header]").length).toBe(0)

    // Rows stay newest-first across what used to be group boundaries.
    const rowIds = Array.from(
      container.querySelectorAll("[data-thread-row]")
    ).map((row) => row.getAttribute("data-thread-row"))
    const storeThreads = useThreadListStore
      .getState()
      .threads.map((thread) => thread.id)
    expect(rowIds).toEqual(storeThreads)
  })
})

describe("thread list virtualization with 10k threads", () => {
  it("mounts a bounded window of rows, not the whole mailbox", async () => {
    setMockViewportHeight(600)
    const TOTAL = 10_000
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    useUiStore.setState({
      view: {
        kind: "folder",
        folder: { kind: "specialUse", specialUse: "inbox" },
      },
    })

    // Bulk-seed 10k threads with caches directly (no messages needed —
    // the list reads the denormalized columns).
    const CHUNK = 1000
    const now = Math.floor(Date.now() / 1000)
    for (let start = 0; start < TOTAL; start += CHUNK) {
      const values: string[] = []
      const params: unknown[] = []
      for (let index = start; index < start + CHUNK; index += 1) {
        const first = params.length
        values.push(
          `($${first + 1}, $${first + 2}, $${first + 3}, $${first + 4}, $${first + 5}, $${first + 6}, $${first + 7}, $${first + 8}, $${first + 9}, $${first + 10}, $${first + 11})`
        )
        params.push(
          `perf-${index}`,
          accountId,
          `Subject ${index}`,
          `Snippet ${index}`,
          now - index * 600,
          1,
          index % 2,
          index % 20 === 0 ? 1 : 0,
          index % 10 === 0 ? 1 : 0,
          JSON.stringify([
            { name: `Sender ${index}`, email: `s${index}@example.com` },
          ]),
          now
        )
      }
      await executor.execute(
        `INSERT INTO threads (
          id, account_id, subject, snippet, last_message_at,
          message_count, unread_count, has_attachments, is_starred,
          participants, created_at
        ) VALUES ${values.join(", ")}`,
        params
      )
      const memberships: string[] = []
      const memberParams: unknown[] = []
      for (let index = start; index < start + CHUNK; index += 1) {
        const first = memberParams.length
        memberships.push(`($${first + 1}, $${first + 2}, $${first + 3})`)
        memberParams.push(`perf-${index}`, inbox, accountId)
      }
      await executor.execute(
        `INSERT INTO thread_labels (thread_id, label_id, account_id)
         VALUES ${memberships.join(", ")}`,
        memberParams
      )
    }

    const startedAt = performance.now()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const elapsedMs = performance.now() - startedAt

    // The store holds the full mailbox…
    expect(useThreadListStore.getState().threads).toHaveLength(TOTAL)
    // …but only a visible window (+ overscan) is mounted — the
    // virtualization proof: rendered rows ≪ 10k.
    const renderedRows = container.querySelectorAll("[data-thread-row]").length
    expect(renderedRows).toBeGreaterThan(0)
    expect(renderedRows).toBeLessThan(200)
    // Reasonable render budget for the first paint of the list.
    expect(elapsedMs).toBeLessThan(5000)

    // Scrolling swaps the window: jump deep into the list and different
    // threads render.
    const scroller = container.querySelector<HTMLDivElement>(
      '[data-testid="thread-list-scroll"]'
    )
    expect(scroller).not.toBeNull()
    Object.defineProperty(scroller, "scrollTop", { value: 400_000 })
    scroller?.dispatchEvent(new Event("scroll"))
    await waitFor(() => {
      const ids = Array.from(
        container.querySelectorAll("[data-thread-row]")
      ).map((row) => row.getAttribute("data-thread-row"))
      expect(ids.length).toBeGreaterThan(0)
      expect(ids).not.toContain("perf-0")
    })
  })
})

describe("star from the list (default wiring, mail-organization)", () => {
  /**
   * The default star path runs the REAL thread-actions setThreadStarred,
   * which also enqueues the server op — a gmail account needs a provider
   * identity on every message (gmail_message_id) or the enqueue refuses.
   */
  async function setupStarAccount(): Promise<string> {
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const threadId = await createThread(executor, accountId, {
      subject: "Star target",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: secondsAgo(60),
      subject: "Star target",
      fromName: "Alice",
      fromAddress: "alice@example.com",
      gmailMessageId: "g-star-1",
    })
    await recomputeThreadCaches(executor, threadId)
    await setThreadLabels(executor, threadId, [inbox])
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    return accountId
  }

  it("star click toggles the thread through thread-actions and refreshes", async () => {
    await setupStarAccount()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const rows = container.querySelectorAll("[data-thread-row]")
    const targetId = rows[0].getAttribute("data-thread-row")
    if (!targetId) throw new Error("row id missing")

    // Unstarred → starred: the indicator flips after the refresh.
    const star = rows[0].querySelector('[aria-label="Not starred"]')
    expect(star).not.toBeNull()
    fireEvent.click(star as Element)
    await waitFor(() => {
      const row = container.querySelector(`[data-thread-row="${targetId}"]`)
      expect(row?.getAttribute("data-starred")).toBe("true")
    })
    // The db proves the real action ran (message flags + thread cache).
    const flags = await executor.select<{ is_flagged: number }>(
      "SELECT is_flagged FROM messages WHERE thread_id = $1",
      [targetId]
    )
    expect(flags.every((flag) => flag.is_flagged === 1)).toBe(true)
    const threads = await executor.select<{ is_starred: number }>(
      "SELECT is_starred FROM threads WHERE id = $1",
      [targetId]
    )
    expect(threads[0]?.is_starred).toBe(1)
    // A star click never opens the thread.
    expect(useUiStore.getState().activeThread).toBeNull()

    // And back: starred → unstarred (indicator toggles both ways).
    const starredButton = container
      .querySelector(`[data-thread-row="${targetId}"]`)
      ?.querySelector('[aria-label="Starred"]')
    fireEvent.click(starredButton as Element)
    await waitFor(() => {
      const row = container.querySelector(`[data-thread-row="${targetId}"]`)
      expect(row?.getAttribute("data-starred")).toBe("false")
    })
  })

  it("the onStarToggle prop overrides the default (tests)", async () => {
    await setupAccount()
    const onStarToggle = vi.fn()
    const { container } = render(<ThreadList onStarToggle={onStarToggle} />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const row = container.querySelector("[data-thread-row]")
    const targetId = row?.getAttribute("data-thread-row")
    fireEvent.click(row?.querySelector('[aria-label="Not starred"]') as Element)

    expect(onStarToggle).toHaveBeenCalledTimes(1)
    expect(onStarToggle).toHaveBeenCalledWith(targetId, true)
    // The default action did not run — the row's star is unchanged.
    const threads = await executor.select<{ is_starred: number }>(
      "SELECT is_starred FROM threads WHERE id = $1",
      [targetId]
    )
    expect(threads[0]?.is_starred).toBe(0)
  })
})

describe("local drafts in the Drafts folder (task 8.6 UI half)", () => {
  /** One account, one synced thread in the Drafts folder + two local drafts. */
  async function setupDraftsView(): Promise<string> {
    const accountId = await createAccount(executor, "gmail")
    const draftsLabel = await createGmailLabel(
      executor,
      accountId,
      "DRAFTS",
      "DRAFTS",
      "drafts"
    )
    const threadId = await createThread(executor, accountId, {
      subject: "Synced drafts thread",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: secondsAgo(120),
      subject: "Synced drafts thread",
      isRead: true,
    })
    await recomputeThreadCaches(executor, threadId)
    await setThreadLabels(executor, threadId, [draftsLabel])
    await saveDraft(executor, {
      accountId,
      draftKey: "key-1",
      draft: {
        to: [{ name: "Grace Hopper", email: "grace@example.com" }],
        cc: [],
        bcc: [],
        subject: "Re: Quarterly report",
        bodyHtml: "<p>Half-written</p>",
        inReplyTo: "<original@example.com>",
        threadId,
      },
    })
    await saveDraft(executor, {
      accountId,
      draft: {
        to: [{ email: "someone@example.com" }],
        cc: [],
        bcc: [],
        subject: "",
        bodyHtml: "<p>Note to self</p>",
      },
    })
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    useUiStore.setState({
      view: {
        kind: "folder",
        folder: { kind: "specialUse", specialUse: "drafts" },
      },
    })
    return accountId
  }

  function draftRows(container: HTMLElement): NodeListOf<HTMLElement> {
    return container.querySelectorAll("[data-draft-row]")
  }

  it("renders draft rows above the thread rows with badge and preview", async () => {
    await setupDraftsView()
    const { container } = render(<ThreadList />)

    await waitFor(() => expect(draftRows(container).length).toBe(2))
    const rows = Array.from(draftRows(container))
    const replyDraft = rows.find((row) => row.textContent?.includes("Re:"))
    expect(replyDraft).toBeDefined()
    expect(replyDraft?.getAttribute("data-draft-key")).toBe("key-1")
    expect(replyDraft?.textContent).toContain("To: Grace Hopper")
    // The "(no subject)" fallback for a blank subject.
    const blank = rows.find(
      (row) => row.getAttribute("data-draft-key") === null
    )
    expect(blank?.textContent).toContain("(no subject)")
    expect(blank?.textContent).toContain("To: someone@example.com")
    // Every draft row carries the Draft badge and a relative timestamp.
    for (const row of rows) {
      expect(row.querySelector('[data-draft-badge="true"]')).not.toBeNull()
      expect(row.textContent).toMatch(/ago/)
    }

    // Drafts sit ABOVE the synced thread rows.
    const firstThread = container.querySelector("[data-thread-row]")
    if (!firstThread) throw new Error("thread row not mounted")
    expect(
      rows[0].compareDocumentPosition(firstThread) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    // Draft activation must not look like a thread row to the selection
    // machinery — no checkbox, no star.
    expect(rows[0].querySelector("[data-thread-checkbox]")).toBeNull()
    expect(rows[0].querySelector('[aria-label="Not starred"]')).toBeNull()
  })

  it("clicking a draft row resumes the composer, never opens the thread", async () => {
    await setupDraftsView()
    const { container } = render(<ThreadList />)
    await waitFor(() => expect(draftRows(container).length).toBe(2))
    const replyDraft = Array.from(draftRows(container)).find((row) =>
      row.getAttribute("data-draft-key")
    )
    if (!replyDraft) throw new Error("reply draft row not mounted")
    fireEvent.click(replyDraft)

    await waitFor(() => expect(useComposerStore.getState().open).toBe(true))
    const composer = useComposerStore.getState()
    expect(composer.mode).toMatchObject({
      kind: "reply",
      replyAll: false,
      inReplyTo: "<original@example.com>",
    })
    expect(composer.to).toEqual([
      { name: "Grace Hopper", email: "grace@example.com" },
    ])
    expect(composer.subject).toBe("Re: Quarterly report")
    expect(composer.html).toBe("<p>Half-written</p>")
    expect(useUiStore.getState().composerOpen).toBe(true)
    // The thread reading pane was NOT opened, and the draftKey join
    // carries the row's key so autosave updates the same draft.
    expect(useUiStore.getState().activeThread).toBeNull()
    expect(getActiveComposerDraftKey()).toBe("key-1")
  })

  it("drafts render even when the folder holds no synced threads", async () => {
    const accountId = await createAccount(executor, "gmail")
    await saveDraft(executor, {
      accountId,
      draft: {
        to: [],
        cc: [],
        bcc: [],
        subject: "Lone draft",
        bodyHtml: "<p>x</p>",
      },
    })
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    useUiStore.setState({
      view: {
        kind: "folder",
        folder: { kind: "specialUse", specialUse: "drafts" },
      },
    })

    const { container } = render(<ThreadList />)
    await waitFor(() => expect(draftRows(container).length).toBe(1))
    expect(screen.queryByTestId("empty-state")).toBeNull()
  })

  it("lists no draft rows outside the Drafts view", async () => {
    await setupDraftsView()
    // Back to the (empty) inbox: the drafts data stays in the store only
    // for the Drafts view; the reload clears it everywhere else.
    useUiStore.setState({ view: DEFAULT_VIEW })
    const { container } = render(<ThreadList />)
    await screen.findByTestId("empty-state")
    expect(draftRows(container).length).toBe(0)
  })
})

describe("thread list sort selector (task 4.1)", () => {
  it("renders in the header; choosing an option re-sorts through the store", async () => {
    await setupAccount()
    useThreadListStore.setState({ sort: "date_desc" })
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )

    const rowSubjects = () =>
      Array.from(container.querySelectorAll("[data-thread-row]")).map((row) =>
        row.getAttribute("data-thread-row")
      )
    const bySubject = () =>
      useThreadListStore.getState().threads.map((thread) => thread.subject)

    // Default: newest first.
    expect(bySubject()).toEqual([
      "Newest unread",
      "Starred read",
      "Yesterday read",
      "This week read",
      "Earlier read",
    ])

    // The header exposes the selector; picking "Oldest first" calls the
    // store's setSort, which persists and re-runs the reload.
    fireEvent.click(screen.getByTestId("thread-sort-selector"))
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Oldest first" })
    )
    expect(useThreadListStore.getState().sort).toBe("date_asc")
    await waitFor(() =>
      expect(bySubject()).toEqual([
        "Earlier read",
        "This week read",
        "Yesterday read",
        "Starred read",
        "Newest unread",
      ])
    )
    // The mounted rows follow the reloaded store order.
    await waitFor(() => {
      const storeOrder = useThreadListStore
        .getState()
        .threads.map((thread) => thread.id)
      expect(rowSubjects()).toEqual(storeOrder)
    })
  })
})

describe("group-by-sender bundles (task 9.4)", () => {
  /**
   * Six inbox threads whose date_desc order is
   * [alice1, alice2, bob, alice3, carol, nosender]: the first two Alice
   * rows are CONSECUTIVE (with mixed-case addresses — grouping identity
   * is case-insensitive), the third Alice row is NOT consecutive (Bob
   * sits between), and the last row has no cached sender at all — so
   * grouping must produce one bundle of 2 plus four standalone rows.
   * Every message carries a gmail id so the bundle's real thread-actions
   * runs (which enqueue server ops for gmail) go through unrefused.
   */

  let ids: Record<string, string>

  async function setupBundleAccount(): Promise<void> {
    ids = {}
    // Each test starts from the per-account inbox view (no scope leak
    // between cases in this file).
    useUiStore.setState({ listScope: null })
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    // The trash action adds the trash-role label (gmail model) — the row
    // must exist for the bundle's Trash to have a local effect.
    await createGmailLabel(executor, accountId, "TRASH", "TRASH", "trash")
    const seed = async (
      key: string,
      subject: string,
      seconds: number,
      fromName?: string,
      fromAddress?: string,
      unread = false
    ): Promise<void> => {
      const threadId = await createThread(executor, accountId, { subject })
      await createMessage(executor, {
        threadId,
        accountId,
        date: secondsAgo(seconds),
        subject,
        fromName,
        fromAddress,
        isRead: !unread,
        gmailMessageId: `g-${key}`,
      })
      await recomputeThreadCaches(executor, threadId)
      await setThreadLabels(executor, threadId, [inbox])
      ids[key] = threadId
    }
    await seed("alice1", "Alice latest", 60, "Alice", "ALICE@Example.com", true)
    await seed("alice2", "Alice older", 120, "Alice", "alice@example.com")
    await seed("bob", "Bob note", 180, "Bob", "bob@example.com")
    await seed("alice3", "Alice oldest", 240, "Alice", "alice@example.com")
    await seed("carol", "Carol note", 300, "Carol", "carol@example.com")
    await seed("nosender", "No sender", 360)
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
  }

  async function threadFlags(id: string): Promise<{
    unread_count: number
    is_archived: number
    is_trashed: number
    snoozed_until: number | null
  }> {
    const rows = await executor.select<{
      unread_count: number
      is_archived: number
      is_trashed: number
      snoozed_until: number | null
    }>(
      "SELECT unread_count, is_archived, is_trashed, snoozed_until FROM threads WHERE id = $1",
      [id]
    )
    return rows[0]
  }

  /** Render, switch grouping on, wait for the collapsed bundle. */
  async function renderGrouped(): Promise<HTMLElement> {
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    fireEvent.click(screen.getByTestId("group-by-sender-toggle"))
    await waitFor(() =>
      expect(container.querySelector("[data-bundle-row]")).not.toBeNull()
    )
    return container
  }

  it("collapses consecutive same-sender runs into one counted bundle row", async () => {
    await setupBundleAccount()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]").length).toBe(6)
    )
    // Grouping off (the default): flat list, no bundle chrome.
    expect(container.querySelector("[data-bundle-row]")).toBeNull()

    fireEvent.click(screen.getByTestId("group-by-sender-toggle"))
    const bundle = await waitFor(() => {
      const el = container.querySelector("[data-bundle-row]")
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    expect(bundle.getAttribute("data-bundle-count")).toBe("2")
    expect(bundle.getAttribute("data-bundle-expanded")).toBe("false")
    // Sender display name (participants cache), count chip, latest subject.
    expect(bundle.textContent).toContain("Alice")
    expect(bundle.textContent).toContain("2 threads")
    expect(bundle.textContent).toContain("Alice latest")

    // The members collapse; every other thread renders alone (bob, the
    // NON-consecutive alice3, carol, and the senderless row).
    expect(container.querySelectorAll("[data-thread-row]").length).toBe(4)
    expect(
      container.querySelector(`[data-thread-row="${ids.alice1}"]`)
    ).toBeNull()
    expect(
      container.querySelector(`[data-thread-row="${ids.alice2}"]`)
    ).toBeNull()
    expect(
      container.querySelector(`[data-thread-row="${ids.alice3}"]`)
    ).not.toBeNull()
  })

  it("expanding a bundle reveals its member threads; collapsing hides them again", async () => {
    await setupBundleAccount()
    const container = await renderGrouped()

    fireEvent.click(container.querySelector("[data-bundle-row]") as Element)
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]").length).toBe(6)
    )
    expect(
      container
        .querySelector("[data-bundle-row]")
        ?.getAttribute("data-bundle-expanded")
    ).toBe("true")
    for (const key of ["alice1", "alice2"] as const) {
      const member = container.querySelector(`[data-thread-row="${ids[key]}"]`)
      expect(member).not.toBeNull()
      expect(member?.getAttribute("data-bundle-member")).toBe("true")
    }

    fireEvent.click(container.querySelector("[data-bundle-row]") as Element)
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]").length).toBe(4)
    )
    expect(
      container
        .querySelector("[data-bundle-row]")
        ?.getAttribute("data-bundle-expanded")
    ).toBe("false")
  })

  it("bundle mark-read applies to every member", async () => {
    await setupBundleAccount()
    const container = await renderGrouped()

    fireEvent.click(
      within(
        container.querySelector("[data-bundle-row]") as HTMLElement
      ).getByRole("button", { name: "Mark read" })
    )
    // Both members flip to read (the rows stay in the inbox view).
    await waitFor(() =>
      expect(container.querySelectorAll('[data-unread="true"]').length).toBe(0)
    )
    expect((await threadFlags(ids.alice1)).unread_count).toBe(0)
    expect((await threadFlags(ids.alice2)).unread_count).toBe(0)
  })

  it("bundle archive applies to every member and empties the bundle", async () => {
    await setupBundleAccount()
    const container = await renderGrouped()

    fireEvent.click(
      within(
        container.querySelector("[data-bundle-row]") as HTMLElement
      ).getByRole("button", { name: "Archive" })
    )
    // Both members leave the inbox → the run disappears entirely.
    await waitFor(() =>
      expect(container.querySelector("[data-bundle-row]")).toBeNull()
    )
    expect(container.querySelectorAll("[data-thread-row]").length).toBe(4)
    expect((await threadFlags(ids.alice1)).is_archived).toBe(1)
    expect((await threadFlags(ids.alice2)).is_archived).toBe(1)
  })

  it("bundle trash applies to every member", async () => {
    await setupBundleAccount()
    // Gmail trash keeps the INBOX membership (it adds the TRASH role), so
    // the membership-based specialUse-inbox selector legitimately still
    // lists it; the unified scope runs the PRESET inbox whose predicate
    // excludes trashed rows — and doubles as the mixed-scope coverage of
    // design decision 4 (bundles + unified actions via the row's account).
    useUiStore.setState({ listScope: { kind: "unified" } })
    const container = await renderGrouped()

    fireEvent.click(
      within(
        container.querySelector("[data-bundle-row]") as HTMLElement
      ).getByRole("button", { name: "Trash" })
    )
    await waitFor(() =>
      expect(container.querySelector("[data-bundle-row]")).toBeNull()
    )
    expect(container.querySelectorAll("[data-thread-row]").length).toBe(4)
    expect((await threadFlags(ids.alice1)).is_trashed).toBe(1)
    expect((await threadFlags(ids.alice2)).is_trashed).toBe(1)
  })

  it("bundle snooze snoozes every member through the shared flow", async () => {
    await setupBundleAccount()
    const container = await renderGrouped()

    fireEvent.click(
      within(
        container.querySelector("[data-bundle-row]") as HTMLElement
      ).getByLabelText("Snooze bundle")
    )
    const preset = getSnoozePresets().presets.find(
      (entry) => entry.id === "tomorrow"
    )
    if (!preset) throw new Error("tomorrow preset missing")
    fireEvent.click(await screen.findByRole("menuitem", { name: preset.label }))

    await waitFor(async () => {
      expect((await threadFlags(ids.alice1)).snoozed_until).toBe(preset.until)
      expect((await threadFlags(ids.alice2)).snoozed_until).toBe(preset.until)
    })
  })

  it("toggling off restores the flat list and persists the flag", async () => {
    await setupBundleAccount()
    const container = await renderGrouped()
    expect(container.querySelectorAll("[data-bundle-row]").length).toBe(1)

    // The first toggle persisted "on" through the preferences service.
    await waitFor(async () => {
      const stored = await executor.select<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'mail.groupBySender'"
      )
      expect(JSON.parse(stored[0].value)).toBe(true)
    })

    fireEvent.click(screen.getByTestId("group-by-sender-toggle"))
    await waitFor(() =>
      expect(container.querySelector("[data-bundle-row]")).toBeNull()
    )
    expect(container.querySelectorAll("[data-thread-row]").length).toBe(6)

    // And the second toggle persisted "off".
    await waitFor(async () => {
      const stored = await executor.select<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'mail.groupBySender'"
      )
      expect(JSON.parse(stored[0].value)).toBe(false)
    })
  })
})

describe("select-all and bulk actions under the unread filter", () => {
  /** Two unread + two read inbox threads (gmail ids: archive enqueues). */
  async function setupMixedReadState(): Promise<{
    unread: string[]
    read: string[]
  }> {
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const ids: { unread: string[]; read: string[] } = { unread: [], read: [] }
    for (const [key, subject, seconds, unread] of [
      ["u1", "Unread one", 60, true],
      ["u2", "Unread two", 120, true],
      ["r1", "Read one", 180, false],
      ["r2", "Read two", 240, false],
    ] as const) {
      const threadId = await createThread(executor, accountId, { subject })
      await createMessage(executor, {
        threadId,
        accountId,
        date: secondsAgo(seconds),
        subject,
        fromName: "Alice",
        fromAddress: "alice@example.com",
        isRead: !unread,
        gmailMessageId: `g-${key}`,
      })
      await recomputeThreadCaches(executor, threadId)
      await setThreadLabels(executor, threadId, [inbox])
      ;(unread ? ids.unread : ids.read).push(threadId)
    }
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    return ids
  }

  it("select-all selects only the visible unread rows; bulk archive applies to them", async () => {
    const ids = await setupMixedReadState()
    useThreadListStore.getState().setUnreadOnly(true)
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]")).toHaveLength(2)
    )

    // Open the selection bar with one checkbox, then select-all.
    const firstId = ids.unread[0]
    const firstWrap = container
      .querySelector(`[data-thread-row="${firstId}"]`)
      ?.querySelector(`[data-thread-checkbox="${firstId}"]`)
    expect(firstWrap).not.toBeNull()
    fireEvent.click(firstWrap as Element)
    expect(screen.getByTestId("thread-selection-bar")).not.toBeNull()
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))

    // Exactly the VISIBLE (unread) rows joined — the two read rows hidden
    // by the filter never do…
    expect([...useThreadListStore.getState().selectedIds].sort()).toEqual(
      [...ids.unread].sort()
    )
    // …and "all selected" reads against the visible set.
    expect(
      screen.getByRole("checkbox", { name: "Clear selection" })
    ).not.toBeNull()

    // The bulk action applies to the selected (visible) rows only.
    fireEvent.click(screen.getByRole("button", { name: "Archive" }))
    await waitFor(() =>
      expect(useThreadListStore.getState().selectedIds.size).toBe(0)
    )
    for (const id of ids.unread) {
      const rows = await executor.select<{ is_archived: number }>(
        "SELECT is_archived FROM threads WHERE id = $1",
        [id]
      )
      expect(rows[0]?.is_archived).toBe(1)
    }
    for (const id of ids.read) {
      const rows = await executor.select<{ is_archived: number }>(
        "SELECT is_archived FROM threads WHERE id = $1",
        [id]
      )
      expect(rows[0]?.is_archived).toBe(0)
    }
  })
})

describe("bulk action failure isolation across account groups", () => {
  it("a rejected group does not skip the rest; the list still refreshes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const seedAccountThread = async (
      email: string,
      subject: string,
      seconds: number,
      key: string
    ): Promise<{ accountId: string; threadId: string }> => {
      const accountId = await createAccount(executor, "gmail")
      const inbox = await createGmailLabel(
        executor,
        accountId,
        "INBOX",
        "INBOX",
        "inbox"
      )
      const threadId = await createThread(executor, accountId, { subject })
      await createMessage(executor, {
        threadId,
        accountId,
        date: secondsAgo(seconds),
        subject,
        fromName: subject,
        fromAddress: email,
        isRead: false,
        gmailMessageId: `g-${key}`,
      })
      await recomputeThreadCaches(executor, threadId)
      await setThreadLabels(executor, threadId, [inbox])
      return { accountId, threadId }
    }
    // A's row is older, so B's account group is the FIRST bulkApply call.
    const a = await seedAccountThread("a@example.com", "A mail", 240, "iso-a")
    const b = await seedAccountThread("b@example.com", "B mail", 60, "iso-b")
    useAccountStore.setState({
      accounts: [
        {
          id: a.accountId,
          type: "gmail",
          email: "a@example.com",
          displayName: null,
          status: "active",
          unreadCount: 1,
        },
        {
          id: b.accountId,
          type: "gmail",
          email: "b@example.com",
          displayName: null,
          status: "active",
          unreadCount: 1,
        },
      ],
      activeAccountId: a.accountId,
      loaded: true,
    })
    useUiStore.setState({ listScope: { kind: "unified" } })

    const spy = vi
      .spyOn(threadActions, "bulkApply")
      .mockImplementationOnce(async () => {
        throw new Error("account B apply exploded")
      })
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]")).toHaveLength(2)
    )

    for (const id of [b.threadId, a.threadId]) {
      const row = container.querySelector(`[data-thread-row="${id}"]`)
      const wrap = row?.querySelector(`[data-thread-checkbox="${id}"]`)
      expect(wrap).not.toBeNull()
      fireEvent.click(wrap as Element)
    }
    fireEvent.click(screen.getByRole("button", { name: "Archive" }))

    // Both groups ran despite the first rejection…
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    expect(spy).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      b.accountId,
      [b.threadId],
      "archive"
    )
    expect(spy).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      a.accountId,
      [a.threadId],
      "archive"
    )
    // …the rows that DID apply are durably gone: the refresh ran and A's
    // row left the unified view, while the failed B row stayed.
    await waitFor(() =>
      expect(
        container.querySelector(`[data-thread-row="${a.threadId}"]`)
      ).toBeNull()
    )
    expect(
      container.querySelector(`[data-thread-row="${b.threadId}"]`)
    ).not.toBeNull()
    // And the consumed bulk selection was cleared anyway.
    expect(useThreadListStore.getState().selectedIds.size).toBe(0)

    warn.mockRestore()
  })
})

describe("split scope presentation (title, empty state, badges)", () => {
  async function setupSplitMailbox(): Promise<{
    accountA: string
    accountB: string
    threadA: string
    threadB: string
  }> {
    const seed = async (
      email: string,
      subject: string,
      seconds: number
    ): Promise<{ accountId: string; threadId: string }> => {
      const accountId = await createAccount(executor, "gmail")
      const threadId = await createThread(executor, accountId, { subject })
      await createMessage(executor, {
        threadId,
        accountId,
        date: secondsAgo(seconds),
        subject,
        fromName: subject,
        fromAddress: email,
      })
      await recomputeThreadCaches(executor, threadId)
      return { accountId, threadId }
    }
    const a = await seed("alpha@example.com", "Quarterly roadmap", 240)
    const b = await seed("beta@example.com", "B roadmap", 60)
    useAccountStore.setState({
      accounts: [
        {
          id: a.accountId,
          type: "gmail",
          email: "alpha@example.com",
          displayName: null,
          status: "active",
          unreadCount: 0,
        },
        {
          id: b.accountId,
          type: "gmail",
          email: "beta@example.com",
          displayName: "Beta Corp",
          status: "active",
          unreadCount: 0,
        },
      ],
      activeAccountId: a.accountId,
      loaded: true,
    })
    return {
      accountA: a.accountId,
      accountB: b.accountId,
      threadA: a.threadId,
      threadB: b.threadId,
    }
  }

  it("renders account badges on an un-pinned split's cross-account rows", async () => {
    const { accountA, accountB } = await setupSplitMailbox()
    useUiStore.setState({
      listScope: { kind: "split", name: "Roadmaps", query: "roadmap" },
    })
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]")).toHaveLength(2)
    )
    expect(
      container.querySelector(`[data-account-badge="${accountA}"]`)
    ).not.toBeNull()
    expect(
      container.querySelector(`[data-account-badge="${accountB}"]`)
    ).not.toBeNull()
  })

  it("renders no badges on an account-pinned split", async () => {
    const { accountA } = await setupSplitMailbox()
    useUiStore.setState({
      listScope: {
        kind: "split",
        name: "Alpha roadmaps",
        query: "roadmap",
        accountId: accountA,
      },
    })
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]")).toHaveLength(1)
    )
    expect(container.querySelector("[data-account-badge]")).toBeNull()
  })

  it("shows the split's own empty state, not the underlying folder's", async () => {
    await setupSplitMailbox()
    useUiStore.setState({
      listScope: { kind: "split", name: "Receipts", query: "zzz-nothing" },
    })
    render(<ThreadList />)
    expect(await screen.findByText('No threads in "Receipts"')).not.toBeNull()
  })
})

describe("thread list catch-me-up affordance (task 7.1)", () => {
  /**
   * Enable AI through the REAL settings service against the test executor
   * (the thread-view-summaries pattern): the affordance's gate then reads
   * true from the exact code path production uses. Optional per-surface
   * overrides for the disabled-surface case.
   */
  async function enableAi(
    surfaces: { folderDigest?: boolean } = {}
  ): Promise<void> {
    await setAiEnabled(executor, true)
    const created = await addProvider(executor, {
      kind: "anthropic",
      label: "Test",
      model: "claude-sonnet-4-5",
    })
    await setActiveProvider(executor, created.id)
    if (surfaces.folderDigest === false) {
      await setSurfaceEnabled(executor, "folderDigest", false)
    }
  }

  it("is hidden while AI is unconfigured, even with unread threads", async () => {
    await setupAccount()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    // Let the best-effort gate read settle (it failed toward hidden).
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByTestId("catch-me-up-button")).toBeNull()
  })

  it("is hidden when the folderDigest surface is disabled", async () => {
    await setupAccount()
    await enableAi({ folderDigest: false })
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByTestId("catch-me-up-button")).toBeNull()
  })

  it("is hidden on an unsupported scope (unified) with unread rows shown", async () => {
    // Spec scope boundary: the digest is defined over ONE folder or
    // category — the aggregated unified inbox keeps the affordance hidden
    // even though rows (with unread) render and the header is up.
    const accountId = await setupAccount()
    useAccountStore.setState({
      accounts: [
        {
          id: accountId,
          type: "gmail",
          email: `${accountId}@example.com`,
          displayName: null,
          status: "active",
          unreadCount: 1,
        },
      ],
      activeAccountId: accountId,
      loaded: true,
    })
    await enableAi()
    useUiStore.getState().setListScope({ kind: "unified" })
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(
        container.querySelector('[data-thread-row][data-unread="true"]')
      ).not.toBeNull()
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByTestId("catch-me-up-button")).toBeNull()
  })

  it("is hidden when the view has no unread threads (not offered)", async () => {
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    await seedThread(accountId, [inbox], {
      subject: "All caught up",
      seconds: 60,
    })
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    await enableAi()
    const { container } = render(<ThreadList />)
    // The header IS rendered (rows exist) — the affordance alone hides.
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByTestId("catch-me-up-button")).toBeNull()
  })

  it("appears for an inbox view with unread threads and opens the dialog on the view's scope", async () => {
    const accountId = await setupAccount()
    await enableAi()
    buildFolderDigestMock.mockResolvedValue({
      digest:
        "- Newest unread — Alice asks about the contract.\nOverview: One thread needs you.",
      threadCount: 1,
      omittedCount: 0,
    })
    render(<ThreadList />)
    fireEvent.click(await screen.findByTestId("catch-me-up-button"))

    // The dialog builds the digest with the CURRENT scope, snapshotted at
    // open: the account-inbox view maps to accountFolder + specialUse.
    await screen.findByTestId("folder-digest-dialog")
    expect(buildFolderDigestMock).toHaveBeenCalledTimes(1)
    expect(buildFolderDigestMock).toHaveBeenCalledWith(
      executorHolder.current,
      {
        scope: {
          kind: "accountFolder",
          accountId,
          folder: { kind: "specialUse", specialUse: "inbox" },
        },
      }
    )
    expect(screen.getByTestId("folder-digest-meta").textContent).toBe(
      "1 unread thread covered"
    )
  })
})
