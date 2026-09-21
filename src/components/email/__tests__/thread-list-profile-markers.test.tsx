import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  cleanup,
  render,
  waitFor,
} from "@testing-library/react"

import {
  assignAccountToProfile,
  createProfile,
  setAccountColorOverride,
} from "@/services/db/account-profiles"
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
import { getProfileColorMarkersEnabled, setProfileColorMarkersPreference } from "@/services/settings/preferences"
import { recomputeThreadCaches, setThreadLabels } from "@/services/db/threads"
import {
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { setFolderCountsStoreExecutor } from "@/stores/folder-counts-store"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import { EMPTY_FOLDER_COUNTS } from "@/services/db/folder-counts"
import { useComposerStore } from "@/stores/composer-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import {
  installResizeObserverMock,
  setMockViewportHeight,
  uninstallResizeObserverMock,
} from "./resize-observer-mock"
import { ThreadList } from "../thread-list"

/**
 * Profile color marker tests (parity-round-2 task 4.5, mailbox-ui spec
 * "Profile color markers"): in the unified inbox each thread row shows a
 * leading-edge marker with its own account's EFFECTIVE color (profile
 * color, per-account override, generated hue); single-account views show
 * none; the appearance toggle (mail.profileColorMarkers, default shown)
 * removes markers everywhere and persists; and the marker is purely
 * decorative — no selection/keyboard/screen-reader surface and no row
 * reflow (absolutely positioned, no text, aria-hidden).
 */

let executor: TestExecutor

function secondsAgo(seconds: number): number {
  return Math.floor(Date.now() / 1000) - seconds
}

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
    effectiveColors: {},
    loaded: false,
  })
  useThreadListStore.setState({
    accountId: null,
    view: null,
    scope: null,
    threads: [],
    drafts: [],
    labelsByThreadId: {},
    userLabels: [],
    loading: false,
    loaded: false,
    selectedIds: new Set<string>(),
    selectionAnchor: null,
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
  useFolderCountsStore.setState({
    accountId: null,
    counts: EMPTY_FOLDER_COUNTS,
  })
})

afterEach(() => {
  cleanup()
  uninstallResizeObserverMock()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  executor.close()
  resetStores()
})

interface SeededAccount {
  accountId: string
  threadId: string
}

async function seedAccountWithInboxThread(options: {
  email: string
  subject: string
  seconds: number
  gmailMessageId: string
}): Promise<SeededAccount> {
  const accountId = await createAccount(executor, "gmail")
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  const threadId = await createThread(executor, accountId, {
    subject: options.subject,
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: secondsAgo(options.seconds),
    subject: options.subject,
    fromName: options.subject,
    fromAddress: options.email,
    isRead: false,
    gmailMessageId: options.gmailMessageId,
  })
  await recomputeThreadCaches(executor, threadId)
  await setThreadLabels(executor, threadId, [inbox])
  return { accountId, threadId }
}

/**
 * Two accounts: Alpha carries the "Work" profile (purple #8b5cf6, no
 * override); Beta joins the same profile but OVERRIDES its marker with
 * orange #f97316. B's thread is the newer.
 */
async function setupTwoAccountMailbox(): Promise<{
  accountA: string
  threadA: string
  accountB: string
  threadB: string
}> {
  const alpha = await seedAccountWithInboxThread({
    email: "alpha@example.com",
    subject: "Alpha thread",
    seconds: 120,
    gmailMessageId: "g-marker-a",
  })
  const beta = await seedAccountWithInboxThread({
    email: "beta@example.com",
    subject: "Beta thread",
    seconds: 60,
    gmailMessageId: "g-marker-b",
  })
  const work = await createProfile(executor, {
    name: "Work",
    color: "#8b5cf6",
  })
  await assignAccountToProfile(executor, alpha.accountId, work.id)
  await assignAccountToProfile(executor, beta.accountId, work.id)
  await setAccountColorOverride(executor, beta.accountId, "#f97316")

  // The store loads accounts AND the effectiveColor map from the same DB;
  // the active account is pinned to Alpha like the unified suite does
  // (fixture ids sort lexicographically, so the restore fallback's
  // "first row" is not necessarily the first-seeded account).
  await useAccountStore.getState().init()
  useAccountStore.setState({ activeAccountId: alpha.accountId })
  return {
    accountA: alpha.accountId,
    threadA: alpha.threadId,
    accountB: beta.accountId,
    threadB: beta.threadId,
  }
}

/** jsdom normalizes inline colors to rgb(); accept the hex form too. */
function colorOf(element: Element): string {
  return (element as HTMLElement).style.backgroundColor
}

function expectColor(element: Element, hex: string, rgb: string): void {
  expect([hex, rgb]).toContain(colorOf(element))
}

async function enterUnifiedScope(): Promise<void> {
  useUiStore.getState().setListScope({ kind: "unified" })
}

describe("profile color markers (task 4.5)", () => {
  it("shows each thread's marker in its own account's effective color in the unified scope", async () => {
    const { threadA, threadB } = await setupTwoAccountMailbox()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]")).toHaveLength(1)
    )

    await enterUnifiedScope()
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]")).toHaveLength(2)
    )

    // One marker per row, on the row's card.
    const markerA = container.querySelector(
      `[data-thread-row="${threadA}"] [data-profile-marker]`
    )
    const markerB = container.querySelector(
      `[data-thread-row="${threadB}"] [data-profile-marker]`
    )
    expect(markerA).not.toBeNull()
    expect(markerB).not.toBeNull()
    // The mailbox-ui spec's marker-reflects-the-account scenario: the
    // profile color for A, the per-account override for B — one purple,
    // one orange.
    expectColor(markerA as Element, "#8b5cf6", "rgb(139, 92, 246)")
    expectColor(markerB as Element, "#f97316", "rgb(249, 115, 22)")
  })

  it("shows no markers in single-account views (toggle-on or off)", async () => {
    const { threadA } = await setupTwoAccountMailbox()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector(`[data-thread-row="${threadA}"]`)).not.toBeNull()
    )

    // The plain per-account folder view: no marker even with the toggle
    // on — markers are a cross-account feature only.
    expect(container.querySelector("[data-profile-marker]")).toBeNull()
  })

  it("toggle-off removes markers everywhere and the choice persists", async () => {
    const { threadA, threadB } = await setupTwoAccountMailbox()

    // Default: shown (the spec's default — the settings row is absent).
    expect(await getProfileColorMarkersEnabled(executor)).toBe(true)

    // The appearance toggle writes the row; the list picks it up on its
    // next mount (settings replaces the mailbox panes, so every leave-
    // settings is a fresh mount — the same seam the row's own readers use).
    await setProfileColorMarkersPreference(executor, false)
    expect(await getProfileColorMarkersEnabled(executor)).toBe(false)

    const first = render(<ThreadList />)
    await enterUnifiedScope()
    await waitFor(() =>
      expect(
        first.container.querySelectorAll("[data-thread-row]")
      ).toHaveLength(2)
    )
    // Toggled off: no markers anywhere (unified included).
    expect(
      first.container.querySelector("[data-profile-marker]")
    ).toBeNull()

    // Persistence across "restart": unmount, render a brand-new list —
    // still no markers, the row in the settings table is the record.
    cleanup()
    const second = render(<ThreadList />)
    await waitFor(() =>
      expect(
        second.container.querySelectorAll("[data-thread-row]")
      ).toHaveLength(2)
    )
    expect(
      second.container.querySelector("[data-profile-marker]")
    ).toBeNull()

    // Toggling back on restores the markers for both accounts.
    await setProfileColorMarkersPreference(executor, true)
    cleanup()
    const third = render(<ThreadList />)
    await waitFor(() =>
      expect(
        third.container.querySelectorAll("[data-thread-row]")
      ).toHaveLength(2)
    )
    expectColor(
      third.container.querySelector(
        `[data-thread-row="${threadA}"] [data-profile-marker]`
      ) as Element,
      "#8b5cf6",
      "rgb(139, 92, 246)"
    )
    expectColor(
      third.container.querySelector(
        `[data-thread-row="${threadB}"] [data-profile-marker]`
      ) as Element,
      "#f97316",
      "rgb(249, 115, 22)"
    )
  })

  it("the marker is purely decorative and does not reflow the row", async () => {
    const { threadA, accountA: threadAAccountId } = await setupTwoAccountMailbox()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector(`[data-thread-row="${threadA}"]`)).not.toBeNull()
    )

    // The per-account row (no marker) is the control; the unified row
    // (marker) must present the exact same accessibility surface.
    const plainRow = container.querySelector(`[data-thread-row]`)
    await enterUnifiedScope()
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]")).toHaveLength(2)
    )
    const markedRow = container.querySelector(`[data-thread-row="${threadA}"]`)
    expect(markedRow).not.toBeNull()
    const marker = markedRow?.querySelector("[data-profile-marker]")
    expect(marker).not.toBeNull()

    // Screen-reader surface unchanged: hidden from the tree, no label,
    // no role, no focus target, no text content.
    expect(marker?.getAttribute("aria-hidden")).toBe("true")
    expect(marker?.getAttribute("aria-label")).toBeNull()
    expect(marker?.getAttribute("role")).toBeNull()
    expect(marker?.getAttribute("tabindex")).toBeNull()
    expect(marker?.textContent).toBe("")
    // The row's own semantics are untouched (selection stays
    // aria-current on the row, the badge still carries the account name —
    // the fixture email is the account id).
    expect(markedRow?.getAttribute("aria-current")).toBeNull()
    expect(
      markedRow?.querySelector(`[data-account-badge]`)?.getAttribute("aria-label")
    ).toBe(`Account ${threadAAccountId}@example.com`)
    const rowAttributes = (node: Element | null | undefined) =>
      node
        ? Array.from(node.attributes)
            .map((attribute) => attribute.name)
            .sort()
        : []
    // No new (test-only) attributes on the row wrapper itself.
    expect(rowAttributes(markedRow)).toEqual(rowAttributes(plainRow))

    // No reflow: the marker is absolutely positioned and the card's
    // classes are identical to a marker-less row's card.
    expect(marker?.className).toContain("absolute")
    const cardOf = (row: Element | null | undefined) =>
      row?.firstElementChild?.getAttribute("class") ?? null
    expect(cardOf(markedRow)).toBe(cardOf(plainRow))
  })
})
