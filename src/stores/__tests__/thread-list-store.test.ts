import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
  resolveScope,
  scopeSortKey,
  setThreadListStoreExecutor,
  threadSortScopeKey,
  useThreadListStore,
} from "../thread-list-store"
import {
  setUserSenderClass,
  upsertSenderStat,
} from "@/services/db/sender-stats"
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
    previousView: DEFAULT_VIEW,
    listScope: null,
  })
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

describe("thread list reading-pane cursor across refreshes", () => {
  it("clears an open thread the refreshed view no longer contains", async () => {
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
    const inboxThread = await seedThread(accountId, [inbox], {
      subject: "Inbox mail",
      date: nowAt(-60),
    })
    await seedThread(accountId, [work], {
      subject: "Work mail",
      date: nowAt(-120),
    })
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    await refreshThreadList()

    // Open the inbox thread, then switch to a folder that does not
    // contain it: once the new page's rows land, the pane must not keep
    // the foreign thread.
    useUiStore.getState().setActiveThread(inboxThread)
    useUiStore.getState().setView({
      kind: "folder",
      folder: { kind: "labelId", labelId: work },
    })
    await refreshThreadList()

    expect(
      useThreadListStore.getState().threads.map((thread) => thread.id)
    ).not.toContain(inboxThread)
    expect(useUiStore.getState().activeThread).toBeNull()
  })

  it("clears it too when the new view loads no rows at all", async () => {
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const inboxThread = await seedThread(accountId, [inbox], {
      subject: "Inbox mail",
      date: nowAt(-60),
    })
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    await refreshThreadList()

    useUiStore.getState().setActiveThread(inboxThread)
    useUiStore.getState().setView({
      kind: "folder",
      folder: { kind: "specialUse", specialUse: "trash" },
    })
    await refreshThreadList()
    expect(useThreadListStore.getState().threads).toEqual([])
    expect(useUiStore.getState().activeThread).toBeNull()
  })

  it("keeps the cursor when a same-view refresh still lists the thread", async () => {
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const inboxThread = await seedThread(accountId, [inbox], {
      subject: "Inbox mail",
      date: nowAt(-60),
    })
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    await refreshThreadList()

    useUiStore.getState().setActiveThread(inboxThread)
    // A background-pass refresh (same view, thread still in the list)…
    await refreshThreadList()
    expect(useUiStore.getState().activeThread).toBe(inboxThread)

    // …and a re-sort refresh likewise (the row is still on the page).
    useThreadListStore.getState().setSort("date_asc")
    await refreshThreadList()
    expect(useUiStore.getState().activeThread).toBe(inboxThread)
  })

  it("keeps a cursor the loaded page never contained (opened outside the list)", async () => {
    // Threads can be opened from outside the list (Todos section, Contacts
    // browser) and the standalone reading pane loads on its own — a
    // refresh whose rows never showed the cursor must not clear it.
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const elsewhere = await seedThread(accountId, [], {
      subject: "Opened from Todos",
      date: nowAt(-60),
    })
    const inboxThread = await seedThread(accountId, [inbox], {
      subject: "Inbox mail",
      date: nowAt(-120),
    })
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    await refreshThreadList()

    useUiStore.getState().setActiveThread(elsewhere)
    await refreshThreadList()
    expect(useUiStore.getState().activeThread).toBe(elsewhere)
    expect(
      useThreadListStore
        .getState()
        .threads.some((thread) => thread.id === elsewhere)
    ).toBe(false)

    // Sanity: the in-list cursor is untouched by the same refresh too.
    useUiStore.getState().setActiveThread(inboxThread)
    await refreshThreadList()
    expect(useUiStore.getState().activeThread).toBe(inboxThread)
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

describe("thread list sort per scope (task 4.1)", () => {
  function threadIds(): (string | null)[] {
    return useThreadListStore.getState().threads.map((thread) => thread.id)
  }

  it("defaults to date_desc, persists setSort per scope, and survives a reload", async () => {
    const accountId = await createAccount(executor, "gmail")
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
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
    const older = await seedThread(accountId, [inbox], {
      subject: "Older",
      date: nowAt(-7200),
      fromName: "Zed",
    })
    const newer = await seedThread(accountId, [inbox], {
      subject: "Newer",
      date: nowAt(-60),
      fromName: "Alice",
    })
    const workThread = await seedThread(accountId, [work], {
      subject: "Work mail",
      date: nowAt(-3600),
    })

    // No scope entry yet → the default sort, newest first.
    await refreshThreadList()
    expect(useThreadListStore.getState().sort).toBe("date_desc")
    expect(threadIds()).toEqual([newer, older])

    // setSort: the effective sort flips, the reload re-queries with it…
    useThreadListStore.getState().setSort("date_asc")
    expect(useThreadListStore.getState().sort).toBe("date_asc")
    await refreshThreadList()
    expect(threadIds()).toEqual([older, newer])

    // …and the per-scope map landed in the settings table under the
    // inbox's scope key.
    await vi.waitFor(async () => {
      const rows = await executor.select<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'mail.threadSorts'"
      )
      expect(JSON.parse(rows[0]?.value ?? "{}")).toMatchObject({
        "special:inbox": "date_asc",
      })
    })

    // A different scope starts at the default again.
    useUiStore.setState({
      view: {
        kind: "folder",
        folder: { kind: "labelId", labelId: work },
      },
    })
    await refreshThreadList()
    expect(useThreadListStore.getState().sort).toBe("date_desc")
    expect(threadIds()).toEqual([workThread])

    // Back to the inbox: its own choice is re-resolved from the map.
    useUiStore.getState().setView(DEFAULT_VIEW)
    await refreshThreadList()
    expect(useThreadListStore.getState().sort).toBe("date_asc")
    expect(threadIds()).toEqual([older, newer])

    // Reload survival: dropping the cached map (fresh store boot) re-reads
    // the persisted row and restores the inbox's sort.
    setThreadListStoreExecutor(null)
    setThreadListStoreExecutor(executor)
    await refreshThreadList()
    expect(useThreadListStore.getState().sort).toBe("date_asc")
    expect(threadIds()).toEqual([older, newer])
  })
})

describe("thread list scope resolution and keys (task 9.1)", () => {
  it("maps every view to its scope descriptor", () => {
    expect(
      resolveScope(
        {
          kind: "folder",
          folder: { kind: "specialUse", specialUse: "inbox" },
        },
        null,
        "acc-1"
      )
    ).toEqual({
      kind: "account",
      accountId: "acc-1",
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
    // The UI's starred pseudo-folder resolves to the db layer's preset.
    expect(
      resolveScope(
        { kind: "folder", folder: { kind: "starred" } },
        null,
        "acc-1"
      )
    ).toEqual({
      kind: "account",
      accountId: "acc-1",
      folder: { kind: "preset", preset: "starred" },
    })
    expect(
      resolveScope(
        { kind: "folder", folder: { kind: "labelId", labelId: "l-1" } },
        null,
        "acc-1"
      )
    ).toEqual({
      kind: "account",
      accountId: "acc-1",
      folder: { kind: "labelId", labelId: "l-1" },
    })
    expect(
      resolveScope(
        { kind: "label", labelId: "l-1", name: "Work" },
        null,
        "acc-1"
      )
    ).toEqual({ kind: "label", accountId: "acc-1", labelId: "l-1" })
    expect(
      resolveScope({ kind: "search", query: "invoices" }, null, "acc-1")
    ).toEqual({ kind: "search", accountId: "acc-1", query: "invoices" })
    expect(resolveScope({ kind: "settings" }, null, "acc-1")).toEqual({
      kind: "settings",
    })
  })

  it("resolves the ui-store list-scope overrides (unified, priority, nudges, split, saved-search)", () => {
    expect(resolveScope(DEFAULT_VIEW, { kind: "unified" }, "acc-1")).toEqual({
      kind: "unified",
    })
    expect(resolveScope(DEFAULT_VIEW, { kind: "priority" }, "acc-1")).toEqual({
      kind: "priority",
    })
    expect(resolveScope(DEFAULT_VIEW, { kind: "nudges" }, "acc-1")).toEqual({
      kind: "nudges",
    })
    expect(
      resolveScope(
        DEFAULT_VIEW,
        { kind: "split", name: "Unread", query: "is:unread" },
        "acc-1"
      )
    ).toEqual({ kind: "split", name: "Unread", query: "is:unread" })
    // A split pinned to an account carries the pin through.
    expect(
      resolveScope(
        DEFAULT_VIEW,
        { kind: "split", name: "A", query: "is:unread", accountId: "acc-2" },
        "acc-1"
      )
    ).toEqual({
      kind: "split",
      name: "A",
      query: "is:unread",
      accountId: "acc-2",
    })
    expect(
      resolveScope(
        DEFAULT_VIEW,
        { kind: "saved-search", name: "Receipts", query: "receipt" },
        "acc-1"
      )
    ).toEqual({ kind: "saved-search", name: "Receipts", query: "receipt" })
  })

  it("derives one sort scope key per list identity", () => {
    expect(
      scopeSortKey({
        kind: "account",
        accountId: "a",
        folder: { kind: "specialUse", specialUse: "inbox" },
      })
    ).toBe("special:inbox")
    expect(
      scopeSortKey({
        kind: "account",
        accountId: "a",
        folder: { kind: "specialUse", specialUse: "sent" },
      })
    ).toBe("special:sent")
    expect(
      scopeSortKey({
        kind: "account",
        accountId: "a",
        folder: { kind: "preset", preset: "starred" },
      })
    ).toBe("special:starred")
    expect(
      scopeSortKey({
        kind: "account",
        accountId: "a",
        folder: { kind: "labelId", labelId: "l-1" },
      })
    ).toBe("label:l-1")
    expect(
      scopeSortKey({ kind: "label", accountId: "a", labelId: "l-1" })
    ).toBe("label:l-1")
    expect(scopeSortKey({ kind: "search", accountId: "a", query: "x" })).toBe(
      "search"
    )
    expect(scopeSortKey({ kind: "unified" })).toBe("unified")
    expect(scopeSortKey({ kind: "priority" })).toBe("priority")
    expect(scopeSortKey({ kind: "nudges" })).toBe("nudges")
    expect(scopeSortKey({ kind: "split", name: "Unread", query: "q" })).toBe(
      "split:Unread"
    )
    expect(
      scopeSortKey({ kind: "saved-search", name: "Receipts", query: "q" })
    ).toBe("saved-search:Receipts")
    expect(scopeSortKey({ kind: "settings" })).toBe("settings")
    // The view-level form keeps its pre-9.1 keys exactly.
    expect(threadSortScopeKey(DEFAULT_VIEW)).toBe("special:inbox")
    expect(threadSortScopeKey({ kind: "search", query: "x" })).toBe("search")
  })
})

describe("thread list unified inbox scope (task 9.1)", () => {
  let accountA: string
  let accountB: string
  let accountC: string
  let mailA: string
  let mailB: string

  beforeEach(async () => {
    accountA = await createAccount(executor, "gmail")
    accountB = await createAccount(executor, "imap")
    accountC = await createAccount(executor, "gmail")
    const inboxA = await createGmailLabel(
      executor,
      accountA,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const inboxB = await createImapFolderLabel(
      executor,
      accountB,
      "INBOX",
      "inbox"
    )
    const inboxC = await createGmailLabel(
      executor,
      accountC,
      "INBOX",
      "INBOX",
      "inbox"
    )
    mailA = await seedThread(accountA, [inboxA], {
      subject: "A mail",
      date: nowAt(-60),
      unread: true,
    })
    mailB = await seedThread(accountB, [inboxB], {
      subject: "B mail",
      date: nowAt(-120),
    })
    await seedThread(accountC, [inboxC], {
      subject: "C mail",
      date: nowAt(-30),
    })
    // A snoozed inbox thread hides from the unified list like from the
    // per-account one (same inbox exclusions).
    const snoozedA = await seedThread(accountA, [inboxA], {
      subject: "A snoozed",
      date: nowAt(-10),
    })
    await executor.execute(
      "UPDATE threads SET snoozed_until = $1 WHERE id = $2",
      [nowAt(3600), snoozedA]
    )
    // accountC is signed out (auth-error): not an active account.
    await executor.execute(
      "UPDATE accounts SET status = 'auth-error' WHERE id = $1",
      [accountC]
    )
    useAccountStore.setState({ activeAccountId: accountA, loaded: true })
  })

  it("lists the active accounts' inbox threads with per-row account identity", async () => {
    useUiStore.getState().setListScope({ kind: "unified" })
    await refreshThreadList()
    const state = useThreadListStore.getState()
    expect(state.scope).toEqual({ kind: "unified" })
    expect(state.threads.map((thread) => thread.id)).toEqual([mailA, mailB])
    expect(state.threads.map((thread) => thread.account_id)).toEqual([
      accountA,
      accountB,
    ])
  })

  it("keeps a non-last-selected active account in the unified scope", async () => {
    // A switch to account A (persistActiveAccount) clears the is_active
    // flag on every row and sets it on A — the selection marker must not
    // shrink the scope: B's rows still aggregate (only auth-error exits).
    await executor.execute("UPDATE accounts SET is_active = 0")
    await executor.execute("UPDATE accounts SET is_active = 1 WHERE id = $1", [
      accountA,
    ])

    useUiStore.getState().setListScope({ kind: "unified" })
    await refreshThreadList()
    expect(
      useThreadListStore.getState().threads.map((thread) => thread.id)
    ).toEqual([mailA, mailB])
  })

  it("drops the in-flight page when the active-account set changes mid-refresh", async () => {
    // First load: the unified page holds both accounts' rows.
    useUiStore.getState().setListScope({ kind: "unified" })
    await refreshThreadList()
    expect(
      useThreadListStore.getState().threads.map((thread) => thread.id)
    ).toEqual([mailA, mailB])

    // Gate the threads query of the NEXT refresh so it sits in flight…
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const gateState = { armed: false, entered: false }
    setThreadListStoreExecutor({
      select: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        if (sql.includes("SELECT threads.* FROM threads") && gateState.armed) {
          gateState.armed = false
          gateState.entered = true
          await gate
        }
        return executor.select<T>(sql, params)
      },
      execute: (sql, params) => executor.execute(sql, params),
    })
    gateState.armed = true
    const inFlight = refreshThreadList()
    await vi.waitFor(() => expect(gateState.entered).toBe(true))

    // …account B is deactivated (removed from the active set) while it
    // runs; the in-flight response must be dropped, not land as ghost
    // rows that nothing re-refreshes.
    await executor.execute(
      "UPDATE accounts SET status = 'auth-error' WHERE id = $1",
      [accountB]
    )
    release()
    await inFlight

    expect(
      useThreadListStore.getState().threads.map((thread) => thread.id)
    ).toEqual([mailA, mailB])

    // Restore the real executor: the flow that changed the set re-runs
    // the refresh, which now loads the fresh (A-only) page.
    setThreadListStoreExecutor(executor)
    await refreshThreadList()
    expect(
      useThreadListStore.getState().threads.map((thread) => thread.id)
    ).toEqual([mailA])
  })

  it("persists the unified sort under its own scope key and reloads with it", async () => {
    useUiStore.getState().setListScope({ kind: "unified" })
    await refreshThreadList()
    expect(useThreadListStore.getState().sort).toBe("date_desc")

    useThreadListStore.getState().setSort("date_asc")
    expect(useThreadListStore.getState().sort).toBe("date_asc")
    await refreshThreadList()
    expect(
      useThreadListStore.getState().threads.map((thread) => thread.id)
    ).toEqual([mailB, mailA])
    // The choice landed in the settings table under the unified scope key.
    await vi.waitFor(async () => {
      const rows = await executor.select<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'mail.threadSorts'"
      )
      expect(JSON.parse(rows[0]?.value ?? "{}")).toMatchObject({
        unified: "date_asc",
      })
    })
  })

  it("leaves the unified scope when a view is selected", async () => {
    useUiStore.getState().setListScope({ kind: "unified" })
    await refreshThreadList()
    expect(useThreadListStore.getState().threads).toHaveLength(2)

    useUiStore.getState().setView(DEFAULT_VIEW)
    await refreshThreadList()
    const state = useThreadListStore.getState()
    expect(state.scope).toEqual({
      kind: "account",
      accountId: accountA,
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
    expect(state.threads.map((thread) => thread.id)).toEqual([mailA])
  })
})

describe("thread list priority inbox scope (task 13.2)", () => {
  let accountA: string
  let accountB: string
  let importantA: string
  let otherA: string

  beforeEach(async () => {
    accountA = await createAccount(executor, "gmail")
    accountB = await createAccount(executor, "imap")
    const inboxA = await createGmailLabel(
      executor,
      accountA,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const inboxB = await createImapFolderLabel(
      executor,
      accountB,
      "INBOX",
      "inbox"
    )
    // alice@example.com: replied-to and direct → classifies important.
    importantA = await seedThread(accountA, [inboxA], {
      subject: "From Alice",
      date: nowAt(-60),
      fromAddress: "alice@example.com",
    })
    // bulk@example.com: a list-marked newsletter → classifies other.
    otherA = await seedThread(accountA, [inboxA], {
      subject: "Digest",
      date: nowAt(-120),
      fromAddress: "bulk@example.com",
    })
    await upsertSenderStat(executor, accountA, "alice@example.com", {
      isReply: true,
      isDirectToMe: true,
      date: nowAt(-60),
    })
    await upsertSenderStat(executor, accountA, "bulk@example.com", {
      isMailingList: true,
      date: nowAt(-120),
    })
    // A second account's inbox thread from an unclassified sender —
    // no stats row → other → stays out of the priority list.
    await seedThread(accountB, [inboxB], {
      subject: "B mail",
      date: nowAt(-30),
      fromAddress: "stranger@example.com",
    })
    // accountB is signed out (auth-error): not an active account.
    await executor.execute(
      "UPDATE accounts SET status = 'auth-error' WHERE id = $1",
      [accountB]
    )
    useAccountStore.setState({ activeAccountId: accountA, loaded: true })
  })

  it("lists the active accounts' IMPORTANT inbox threads only", async () => {
    useUiStore.getState().setListScope({ kind: "priority" })
    await refreshThreadList()
    const state = useThreadListStore.getState()
    expect(state.scope).toEqual({ kind: "priority" })
    expect(state.threads.map((thread) => thread.id)).toEqual([importantA])
  })

  it("an override flips a thread's placement through the store", async () => {
    await setUserSenderClass(
      executor,
      accountA,
      "bulk@example.com",
      "important"
    )
    useUiStore.getState().setListScope({ kind: "priority" })
    await refreshThreadList()
    expect(
      useThreadListStore.getState().threads.map((thread) => thread.id)
    ).toEqual([importantA, otherA]) // both in, still newest-first

    // Flip the other way and clear — back to the heuristic placement.
    await setUserSenderClass(executor, accountA, "bulk@example.com", null)
    await refreshThreadList()
    expect(
      useThreadListStore.getState().threads.map((thread) => thread.id)
    ).toEqual([importantA])
  })
})

describe("thread list split and saved-search scopes (task 9.1)", () => {
  let accountA: string
  let accountB: string
  let unreadA: string
  let unreadB: string
  let roadmapA: string
  let roadmapB: string

  beforeEach(async () => {
    accountA = await createAccount(executor, "gmail")
    accountB = await createAccount(executor, "imap")
    const inboxA = await createGmailLabel(
      executor,
      accountA,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const inboxB = await createImapFolderLabel(
      executor,
      accountB,
      "INBOX",
      "inbox"
    )
    unreadA = await seedThread(accountA, [inboxA], {
      subject: "Unread A",
      date: nowAt(-60),
      unread: true,
    })
    unreadB = await seedThread(accountB, [inboxB], {
      subject: "Unread B",
      date: nowAt(-120),
      unread: true,
    })
    roadmapA = await seedThread(accountA, [], {
      subject: "Quarterly roadmap",
      date: nowAt(-200),
    })
    roadmapB = await seedThread(accountB, [], {
      subject: "B roadmap",
      date: nowAt(-300),
    })
    useAccountStore.setState({ activeAccountId: accountA, loaded: true })
  })

  it("an un-pinned split runs its query across the active accounts", async () => {
    useUiStore
      .getState()
      .setListScope({ kind: "split", name: "Unread", query: "is:unread" })
    await refreshThreadList()
    const state = useThreadListStore.getState()
    expect(state.scope).toEqual({
      kind: "split",
      name: "Unread",
      query: "is:unread",
    })
    expect(state.threads.map((thread) => thread.id)).toEqual([unreadA, unreadB])
    expect(new Set(state.threads.map((thread) => thread.account_id))).toEqual(
      new Set([accountA, accountB])
    )
  })

  it("a split pinned to an account stays within it", async () => {
    useUiStore.getState().setListScope({
      kind: "split",
      name: "A unread",
      query: "is:unread",
      accountId: accountA,
    })
    await refreshThreadList()
    const state = useThreadListStore.getState()
    expect(state.threads.map((thread) => thread.id)).toEqual([unreadA])
    expect(
      state.threads.every((thread) => thread.account_id === accountA)
    ).toBe(true)
  })

  it("a saved search runs globally across the active accounts", async () => {
    useUiStore.getState().setListScope({
      kind: "saved-search",
      name: "Roadmaps",
      query: "roadmap",
    })
    await refreshThreadList()
    const state = useThreadListStore.getState()
    expect(state.scope).toEqual({
      kind: "saved-search",
      name: "Roadmaps",
      query: "roadmap",
    })
    // One merged list from both accounts, date-desc across the merge.
    expect(state.threads.map((thread) => thread.id)).toEqual([
      roadmapA,
      roadmapB,
    ])
  })
})

describe("thread list nudges scope (task 14.1, design D8)", () => {
  let accountA: string
  let accountB: string
  let inboxA: string
  let inboxB: string

  beforeEach(async () => {
    accountA = await createAccount(executor, "gmail")
    accountB = await createAccount(executor, "gmail")
    inboxA = await createGmailLabel(
      executor,
      accountA,
      "INBOX",
      "INBOX",
      "inbox"
    )
    inboxB = await createGmailLabel(
      executor,
      accountB,
      "INBOX",
      "INBOX",
      "inbox"
    )
    useAccountStore.setState({ activeAccountId: accountA, loaded: true })
  })

  /** An awaiting-reply thread: the account is addressed, the latest
   * message is someone else's, `ageDays` old. */
  async function seedNudge(
    accountId: string,
    labelId: string,
    subject: string,
    ageDays: number
  ): Promise<string> {
    const email = `${accountId}@example.com`
    return seedThread(accountId, [labelId], {
      subject,
      date: nowAt(-ageDays * 24 * 60 * 60),
      fromAddress: "alice@example.com",
      to: [{ email }],
      snippet: `${subject} — any news?`,
    })
  }

  it("lists the active accounts' detected nudges under its own scope key", async () => {
    const nudgeA = await seedNudge(accountA, inboxA, "Old question", 10)
    const nudgeB = await seedNudge(accountB, inboxB, "Other account", 8)
    // Not a nudge: too recent.
    await seedNudge(accountA, inboxA, "Fresh", 1)

    useUiStore.getState().setListScope({ kind: "nudges" })
    await refreshThreadList()
    const state = useThreadListStore.getState()
    expect(state.scope).toEqual({ kind: "nudges" })
    // Both are questions (the has-question lead applies); then date desc —
    // the fresher nudge first.
    expect(state.threads.map((thread) => thread.id)).toEqual([nudgeB, nudgeA])
    expect(new Set(state.threads.map((thread) => thread.account_id))).toEqual(
      new Set([accountA, accountB])
    )
  })

  it("excludes an account signed out of the active set, like unified", async () => {
    const nudgeA = await seedNudge(accountA, inboxA, "Old question", 10)
    await seedNudge(accountB, inboxB, "Signed out", 8)
    await executor.execute(
      "UPDATE accounts SET status = 'auth-error' WHERE id = $1",
      [accountB]
    )

    useUiStore.getState().setListScope({ kind: "nudges" })
    await refreshThreadList()
    expect(
      useThreadListStore.getState().threads.map((thread) => thread.id)
    ).toEqual([nudgeA])
  })
})
