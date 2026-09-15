import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createAccount,
  createGmailLabel,
  createImapFolderLabel,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  getLabelsForThreads,
  getThread,
  recomputeThreadCaches,
  setThreadLabels,
  setThreadStarred,
} from "@/services/db/threads"
import { setAccountStoreExecutor, useAccountStore } from "../account-store"
import {
  dateGroupLabel,
  formatRowTimestamp,
  formatThreadParticipants,
  parseThreadParticipants,
  refreshThreadList,
  setThreadListStoreExecutor,
  useThreadListStore,
} from "../thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "../ui-store"

/**
 * Store tests run the real SQL against a seeded node:sqlite database
 * (injected via setThreadListStoreExecutor). Every view→query mapping of
 * the ui-store table is exercised, plus account switching and the batched
 * label-chip lookup.
 */

let executor: TestExecutor

/** now-relative epoch seconds (fixture `at()` is pinned to 2023). */
function nowAt(offsetSeconds: number): number {
  return Math.floor(Date.now() / 1000) + offsetSeconds
}

function resetStores(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
  })
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
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

beforeEach(() => {
  resetStores()
  executor = createTestExecutor()
  setAccountStoreExecutor(executor)
  setThreadListStoreExecutor(executor)
})

afterEach(() => {
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  executor.close()
})

interface SeedOptions {
  subject: string
  date: number
  unread?: boolean
  starred?: boolean
  fromName?: string
  fromAddress?: string
  to?: { name?: string; email: string }[]
  snippet?: string
}

async function seedThread(
  accountId: string,
  labelIds: string[],
  options: SeedOptions
): Promise<string> {
  const threadId = await createThread(executor, accountId, {
    subject: options.subject,
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: options.date,
    subject: options.subject,
    snippet: options.snippet ?? `${options.subject} snippet`,
    fromName: options.fromName,
    fromAddress: options.fromAddress,
    to: options.to,
    isRead: !options.unread,
  })
  await recomputeThreadCaches(executor, threadId)
  if (labelIds.length) {
    await setThreadLabels(executor, threadId, labelIds)
  }
  if (options.starred) {
    await setThreadStarred(executor, threadId)
  }
  return threadId
}

describe("thread list store view mapping", () => {
  let accountId: string
  let inboxLabelId: string
  let workLabelId: string
  let inboxThread: string
  let starredThread: string
  let workThread: string
  let searchThread: string

  beforeEach(async () => {
    accountId = await createAccount(executor, "gmail")
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    inboxLabelId = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const trashLabelId = await createGmailLabel(
      executor,
      accountId,
      "TRASH",
      "TRASH",
      "trash"
    )
    workLabelId = await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )

    inboxThread = await seedThread(accountId, [inboxLabelId], {
      subject: "Inbox mail",
      date: nowAt(-3600),
      unread: true,
      fromName: "Alice",
      fromAddress: "alice@example.com",
    })
    starredThread = await seedThread(accountId, [inboxLabelId], {
      subject: "Starred mail",
      date: nowAt(-7200),
      starred: true,
    })
    workThread = await seedThread(accountId, [workLabelId], {
      subject: "Work mail",
      date: nowAt(-3 * 86400),
    })
    await seedThread(accountId, [trashLabelId], {
      subject: "Trashed mail",
      date: nowAt(-4 * 86400),
    })
    searchThread = await seedThread(accountId, [], {
      subject: "Quarterly report",
      date: nowAt(-5 * 86400),
    })
  })

  it("specialUse inbox resolves the account's inbox-role label", async () => {
    useUiStore.getState().setView({
      kind: "folder",
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
    await refreshThreadList()
    const {
      threads,
      accountId: loadedAccount,
      loaded,
    } = useThreadListStore.getState()
    expect(loadedAccount).toBe(accountId)
    expect(loaded).toBe(true)
    expect(threads.map((thread) => thread.id)).toEqual([
      inboxThread,
      starredThread,
    ])
  })

  it("starred folders route through the preset query", async () => {
    useUiStore.getState().setView({
      kind: "folder",
      folder: { kind: "starred" },
    })
    await refreshThreadList()
    expect(
      useThreadListStore.getState().threads.map((thread) => thread.id)
    ).toEqual([starredThread])
  })

  it("folder.labelId and label views run the same label query", async () => {
    useUiStore.setState({
      view: {
        kind: "folder",
        folder: { kind: "labelId", labelId: workLabelId },
      },
    })
    await refreshThreadList()
    expect(
      useThreadListStore.getState().threads.map((thread) => thread.id)
    ).toEqual([workThread])

    useUiStore.setState({
      view: { kind: "label", labelId: workLabelId, name: "Work" },
    })
    await refreshThreadList()
    expect(
      useThreadListStore.getState().threads.map((thread) => thread.id)
    ).toEqual([workThread])
  })

  it("search views run the operator-aware thread search", async () => {
    useUiStore.setState({ view: { kind: "search", query: "Quarterly" } })
    await refreshThreadList()
    expect(
      useThreadListStore.getState().threads.map((thread) => thread.id)
    ).toEqual([searchThread])
  })

  it("loads label chips in the same refresh", async () => {
    useUiStore.getState().setView({
      kind: "folder",
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
    await refreshThreadList()
    const { labelsByThreadId } = useThreadListStore.getState()
    expect(labelsByThreadId[inboxThread]).toBeUndefined()
    useUiStore.getState().setView({
      kind: "folder",
      folder: { kind: "labelId", labelId: workLabelId },
    })
    await refreshThreadList()
    expect(useThreadListStore.getState().labelsByThreadId[workThread]).toEqual([
      { id: workLabelId, name: "Work", color: null },
    ])
  })

  it("settings and account-less states resolve to an empty list", async () => {
    useUiStore.getState().setView({ kind: "settings" })
    await refreshThreadList()
    expect(useThreadListStore.getState().threads).toEqual([])

    resetStores()
    await refreshThreadList()
    const state = useThreadListStore.getState()
    expect(state.threads).toEqual([])
    expect(state.loaded).toBe(true)
  })
})

describe("thread list store account switching", () => {
  it("reloads the active account's threads and drops the old view data", async () => {
    const accountA = await createAccount(executor, "gmail")
    const inboxA = await createGmailLabel(
      executor,
      accountA,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const threadA = await seedThread(accountA, [inboxA], {
      subject: "A mail",
      date: nowAt(-60),
    })

    const accountB = await createAccount(executor, "imap")
    const inboxB = await createImapFolderLabel(
      executor,
      accountB,
      "INBOX",
      "inbox"
    )
    const threadB = await seedThread(accountB, [inboxB], {
      subject: "B mail",
      date: nowAt(-120),
    })

    useAccountStore.setState({ activeAccountId: accountA, loaded: true })
    await refreshThreadList()
    expect(
      useThreadListStore.getState().threads.map((thread) => thread.id)
    ).toEqual([threadA])

    useAccountStore.setState({ activeAccountId: accountB })
    await refreshThreadList()
    const state = useThreadListStore.getState()
    expect(state.accountId).toBe(accountB)
    expect(state.threads.map((thread) => thread.id)).toEqual([threadB])
  })
})

describe("thread list presentation helpers", () => {
  const NOW = new Date("2026-03-10T12:00:00")

  function secondsFromNow(offsetSeconds: number): number {
    return Math.floor(NOW.getTime() / 1000) + offsetSeconds
  }

  function iso(text: string): number {
    return Math.floor(new Date(text).getTime() / 1000)
  }

  it("buckets calendar days into the four date groups", () => {
    expect(dateGroupLabel(secondsFromNow(60), NOW)).toBe("Today")
    // Future timestamps (clock skew) count as today.
    expect(dateGroupLabel(secondsFromNow(86400), NOW)).toBe("Today")
    expect(dateGroupLabel(secondsFromNow(-3600), NOW)).toBe("Today")
    expect(dateGroupLabel(secondsFromNow(-86400 - 60), NOW)).toBe("Yesterday")
    expect(dateGroupLabel(secondsFromNow(-3 * 86400), NOW)).toBe("This week")
    expect(dateGroupLabel(secondsFromNow(-6 * 86400), NOW)).toBe("This week")
    expect(dateGroupLabel(secondsFromNow(-7 * 86400 - 60), NOW)).toBe("Earlier")
    expect(dateGroupLabel(null, NOW)).toBe("Earlier")
  })

  it("formats row timestamps by recency", () => {
    expect(formatRowTimestamp(iso("2026-03-10T09:05:00"), NOW)).toBe("9:05 AM")
    expect(formatRowTimestamp(iso("2026-02-02T10:00:00"), NOW)).toBe("Feb 2")
    expect(formatRowTimestamp(iso("2024-05-05T10:00:00"), NOW)).toBe(
      "May 5, 2024"
    )
    expect(formatRowTimestamp(null, NOW)).toBe("")
  })

  it("parses and formats the participants cache defensively", () => {
    const json = JSON.stringify([
      { name: "Alice", email: "alice@example.com" },
      { email: "bob@example.com" },
    ])
    expect(parseThreadParticipants(json)).toEqual([
      { name: "Alice", email: "alice@example.com" },
      { email: "bob@example.com" },
    ])
    expect(parseThreadParticipants("not json")).toEqual([])
    expect(parseThreadParticipants(null)).toEqual([])
    expect(parseThreadParticipants("[42]")).toEqual([])
    expect(formatThreadParticipants(parseThreadParticipants(json))).toBe(
      "Alice (+1)"
    )
    expect(formatThreadParticipants([{ email: "solo@x.com" }])).toBe(
      "solo@x.com"
    )
    expect(formatThreadParticipants([])).toBe("")
  })

  it("recompute caches the newest message's participants (v2 column)", async () => {
    const accountId = await createAccount(executor, "gmail")
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId,
      accountId,
      date: nowAt(-7200),
      fromName: "Old Sender",
      fromAddress: "old@example.com",
    })
    const latest = await createMessage(executor, {
      threadId,
      accountId,
      date: nowAt(-60),
      fromName: "Alice",
      fromAddress: "alice@example.com",
      to: [
        { name: "Bob", email: "bob@example.com" },
        { email: "alice@example.com" },
        { email: "carol@example.com" },
        { email: "dave@example.com" },
      ],
    })
    await recomputeThreadCaches(executor, threadId)
    const thread = await getThread(executor, threadId)
    // from first, then unique to's capped at 2, dropping the sender repeat.
    expect(parseThreadParticipants(thread?.participants ?? null)).toEqual([
      { name: "Alice", email: "alice@example.com" },
      { name: "Bob", email: "bob@example.com" },
      { email: "carol@example.com" },
    ])
    expect(thread?.last_message_at).toBe(nowAt(-60))

    // Deleting the newest message re-derives participants from the prior one.
    await executor.execute("DELETE FROM messages WHERE id = $1", [latest])
    await recomputeThreadCaches(executor, threadId)
    expect(
      parseThreadParticipants(
        (await getThread(executor, threadId))?.participants ?? null
      )
    ).toEqual([{ name: "Old Sender", email: "old@example.com" }])
  })

  it("getLabelsForThreads batch-returns chips per thread id", async () => {
    const accountId = await createAccount(executor, "gmail")
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
    const threadA = await createThread(executor, accountId)
    const threadB = await createThread(executor, accountId)
    await setThreadLabels(executor, threadA, [work, personal])
    await setThreadLabels(executor, threadB, [personal])

    const labels = await getLabelsForThreads(executor, accountId, [
      threadA,
      threadB,
    ])
    // Chips sort by label name ASC.
    expect(labels.get(threadA)).toEqual([
      { id: personal, name: "Personal", color: null },
      { id: work, name: "Work", color: null },
    ])
    expect(labels.get(threadB)).toEqual([
      { id: personal, name: "Personal", color: null },
    ])
    expect(labels.size).toBe(2)

    const empty = await getLabelsForThreads(executor, accountId, [])
    expect(empty.size).toBe(0)
  })
})
