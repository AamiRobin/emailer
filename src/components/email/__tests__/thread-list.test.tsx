import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

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

beforeEach(() => {
  resetStores()
  installResizeObserverMock()
  setMockViewportHeight(10_000)
  executor = createTestExecutor()
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
  it("renders sticky group headers in Today → Earlier order", async () => {
    await setupAccount()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )

    const headers = Array.from(
      container.querySelectorAll("[data-group-header]")
    ).map((header) => header.getAttribute("data-group-header"))
    expect(headers).toEqual(["Today", "Yesterday", "This week", "Earlier"])

    // Rows stay newest-first across group boundaries.
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
    expect(
      container.querySelectorAll("[data-group-header]").length
    ).toBeLessThan(20)
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
