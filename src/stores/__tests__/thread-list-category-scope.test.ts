import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { moveThreadToCategory } from "@/services/categorization/overrides"
import {
  countThreadsByCategoryAcrossAccounts,
  countCategoryBackfillRemaining,
} from "@/services/db/threads"
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
import { recomputeThreadCaches } from "@/services/db/threads"
import { setAccountStoreExecutor, useAccountStore } from "../account-store"
import {
  refreshThreadList,
  resolveScope,
  scopeSortKey,
  scopeSpansAccounts,
  setThreadListStoreExecutor,
  useThreadListStore,
} from "../thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "../ui-store"

/**
 * The category tab scope (task 3.5, design D4, mailbox-ui spec "Category
 * tab presentation"): the ui-store category override resolves like the
 * split scopes, the unified-inbox query narrows to one category — with
 * NULL ("not yet categorized", the migration v9 contract) counting as
 * Primary — and the tab badges' grouped counts read the same scope.
 * Real SQL against a seeded node:sqlite database via the executor hooks.
 */

let executor: TestExecutor

/** now-relative epoch seconds (fixtures are pinned to 2023). */
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
  resetStores()
})

interface SeedOptions {
  subject: string
  date: number
  unread?: boolean
}

/** One inbox thread (gmail membership) with one message + caches. */
async function seedInboxThread(
  accountId: string,
  inboxLabelId: string,
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
    snippet: `${options.subject} snippet`,
    fromName: "Sender",
    fromAddress: `${options.subject.replace(/\W+/g, "").toLowerCase()}@x.com`,
    isRead: !options.unread,
  })
  await recomputeThreadCaches(executor, threadId)
  await executor.execute(
    "UPDATE threads SET folder_label_id = $1 WHERE id = $2",
    [inboxLabelId, threadId]
  )
  return threadId
}

describe("category list scope (task 3.5)", () => {
  it("resolves the ui-store override and its scope identity", () => {
    expect(
      resolveScope(
        DEFAULT_VIEW,
        { kind: "category", category: "promotions" },
        "acc-1"
      )
    ).toEqual({
      kind: "category",
      category: "promotions",
    })
    expect(scopeSortKey({ kind: "category", category: "promotions" })).toBe(
      "category:promotions"
    )
    // Across the active accounts, like unified.
    expect(scopeSpansAccounts({ kind: "category", category: "primary" })).toBe(
      true
    )
  })

  it("lists only the scoped category; Primary includes the NULL rows", async () => {
    const accountA = await createAccount(executor, "gmail")
    const inboxA = await createGmailLabel(
      executor,
      accountA,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const accountB = await createAccount(executor, "imap")
    const inboxB = await createImapFolderLabel(
      executor,
      accountB,
      "INBOX",
      "inbox"
    )

    const promo = await seedInboxThread(accountA, inboxA, {
      subject: "Promo",
      date: nowAt(-60),
    })
    const neverCategorized = await seedInboxThread(accountA, inboxA, {
      subject: "Never",
      date: nowAt(-120),
      unread: true,
    })
    const primaryThread = await seedInboxThread(accountB, inboxB, {
      subject: "Primary",
      date: nowAt(-90),
      unread: true,
    })
    const updates = await seedInboxThread(accountB, inboxB, {
      subject: "Updates",
      date: nowAt(-30),
    })
    // The user override writes the exact rows the tabs filter on.
    await moveThreadToCategory(executor, promo, "promotions")
    await moveThreadToCategory(executor, updates, "updates")
    await moveThreadToCategory(executor, primaryThread, "primary")
    void neverCategorized

    useAccountStore.setState({ activeAccountId: accountA, loaded: true })
    useUiStore.getState().setListScope({
      kind: "category",
      category: "promotions",
    })
    await refreshThreadList()
    const state = useThreadListStore.getState()
    expect(state.scope).toEqual({ kind: "category", category: "promotions" })
    expect(state.threads.map((thread) => thread.id)).toEqual([promo])
    // Cross-account scope: rows keep their owning account.
    expect(state.threads[0]!.account_id).toBe(accountA)

    // Primary: the explicit primary row AND the not-yet-categorized NULL.
    useUiStore
      .getState()
      .setListScope({ kind: "category", category: "primary" })
    await refreshThreadList()
    expect(
      useThreadListStore
        .getState()
        .threads.map((t) => t.id)
        .sort()
    ).toEqual([neverCategorized, primaryThread].sort())

    // Back control: a folder selection clears the override (ui-store's
    // setView contract) — the list falls back to the account scope.
    useUiStore.getState().setView(DEFAULT_VIEW)
    await refreshThreadList()
    expect(useUiStore.getState().listScope ?? null).toBeNull()
    expect(useThreadListStore.getState().scope).toEqual({
      kind: "account",
      accountId: accountA,
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
  })
})

describe("category counts (task 3.5)", () => {
  it("groups one COUNT query over the inbox scope; NULL counts as Primary", async () => {
    const accountA = await createAccount(executor, "gmail")
    const inboxA = await createGmailLabel(
      executor,
      accountA,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const accountB = await createAccount(executor, "imap")
    const inboxB = await createImapFolderLabel(
      executor,
      accountB,
      "INBOX",
      "inbox"
    )

    const promoUnread = await seedInboxThread(accountA, inboxA, {
      subject: "Promo unread",
      date: nowAt(-60),
      unread: true,
    })
    await moveThreadToCategory(executor, promoUnread, "promotions")
    const promoRead = await seedInboxThread(accountA, inboxA, {
      subject: "Promo read",
      date: nowAt(-70),
    })
    await moveThreadToCategory(executor, promoRead, "promotions")
    await seedInboxThread(accountB, inboxB, {
      subject: "Null unread",
      date: nowAt(-80),
      unread: true,
    })
    const primaryUnread = await seedInboxThread(accountB, inboxB, {
      subject: "Primary unread",
      date: nowAt(-90),
      unread: true,
    })
    await moveThreadToCategory(executor, primaryUnread, "primary")
    // A trashed thread leaves every tab's count (the inbox exclusion).
    const trashed = await seedInboxThread(accountA, inboxA, {
      subject: "Trashed promo",
      date: nowAt(-100),
      unread: true,
    })
    await moveThreadToCategory(executor, trashed, "promotions")
    await executor.execute("UPDATE threads SET is_trashed = 1 WHERE id = $1", [
      trashed,
    ])

    const counts = await countThreadsByCategoryAcrossAccounts(executor, [
      accountA,
      accountB,
    ])
    expect(counts.promotions).toEqual({ total: 2, unread: 1 })
    expect(counts.primary).toEqual({ total: 2, unread: 2 })
    expect(counts.updates).toEqual({ total: 0, unread: 0 })
    expect(counts.social).toEqual({ total: 0, unread: 0 })
    expect(counts.newsletters).toEqual({ total: 0, unread: 0 })

    // An empty active-account set counts nothing (the list's empty-guard).
    expect(await countThreadsByCategoryAcrossAccounts(executor, [])).toEqual({
      primary: { total: 0, unread: 0 },
      updates: { total: 0, unread: 0 },
      promotions: { total: 0, unread: 0 },
      social: { total: 0, unread: 0 },
      newsletters: { total: 0, unread: 0 },
    })
  })

  it("counts the backfill's remaining candidates (the status line's M)", async () => {
    const accountA = await createAccount(executor, "gmail")
    const inboxA = await createGmailLabel(
      executor,
      accountA,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const withMessage = await seedInboxThread(accountA, inboxA, {
      subject: "Has message",
      date: nowAt(-60),
    })
    await seedInboxThread(accountA, inboxA, {
      subject: "Also has one",
      date: nowAt(-70),
    })
    // A thread without messages is never a backfill candidate (the
    // backfill's EXISTS guard).
    await createThread(executor, accountA, { subject: "Messageless" })
    expect(await countCategoryBackfillRemaining(executor)).toBe(2)

    // One categorized → the remaining estimate drops.
    await moveThreadToCategory(executor, withMessage, "updates")
    expect(await countCategoryBackfillRemaining(executor)).toBe(1)
  })
})
