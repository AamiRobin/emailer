import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

import {
  at,
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { updateLabel } from "@/services/db/labels"
import { recomputeThreadCaches, setThreadLabels } from "@/services/db/threads"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  initAccountStore,
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import {
  setFolderCountsStoreExecutor,
  useFolderCountsStore,
} from "@/stores/folder-counts-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { setSidebarDataExecutor } from "../use-sidebar-data"
import { Sidebar } from "../sidebar"

/**
 * Render tests drive the real stores against a seeded node:sqlite database
 * (injected via the set*Executor hooks). Counts and labels load from the DB
 * through the same effect chain the shell uses in production.
 *
 * The label CRUD flows (task 10.4) run for real in these tests: the shared
 * getExecutor() is pointed at the same node:sqlite executor, so the
 * dialogs' label-admin calls (row writes + queued ops) hit the seeded
 * database and notifyUserLabelsChanged() reloads the sidebar through the
 * production hook.
 */

// The dialogs resolve the shared executor through getExecutor(); bind it
// to the current test database (read at call time, after beforeEach).
vi.mock("@/services/db/executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/db/executor")>()
  return {
    ...actual,
    getExecutor: () => executor,
  }
})

let executor: TestExecutor

async function seedUnreadThread(options: {
  accountId: string
  labelIds?: string[]
  unread: number
}): Promise<string> {
  const threadId = await createThread(executor, options.accountId)
  for (let index = 0; index < options.unread; index += 1) {
    await createMessage(executor, {
      threadId,
      accountId: options.accountId,
      date: at(index),
    })
  }
  await recomputeThreadCaches(executor, threadId)
  if (options.labelIds) {
    await setThreadLabels(executor, threadId, options.labelIds)
  }
  return threadId
}

function resetStores(): void {
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
  })
  useFolderCountsStore.setState({
    accountId: null,
    counts: {
      inbox: 0,
      starred: 0,
      sent: 0,
      drafts: 0,
      archive: 0,
      spam: 0,
      trash: 0,
    },
  })
}

beforeEach(() => {
  executor = createTestExecutor()
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
  setSidebarDataExecutor(executor)
  resetStores()
})

afterEach(() => {
  cleanup()
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  setSidebarDataExecutor(null)
  executor.close()
  resetStores()
})

function renderSidebar(isCollapsed = false) {
  return render(
    <TooltipProvider delay={0}>
      <Sidebar isCollapsed={isCollapsed} />
    </TooltipProvider>
  )
}

/** The seeded active account: 2 unread in inbox, 1 sent, 3 trashed. */
async function seedActiveAccount(): Promise<string> {
  const accountId = await createAccount(executor, "gmail")
  await executor.execute("UPDATE accounts SET is_active = 1 WHERE id = $1", [
    accountId,
  ])
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  const sent = await createGmailLabel(
    executor,
    accountId,
    "SENT",
    "SENT",
    "sent"
  )
  const trash = await createGmailLabel(
    executor,
    accountId,
    "TRASH",
    "TRASH",
    "trash"
  )
  await seedUnreadThread({ accountId, labelIds: [inbox], unread: 2 })
  await seedUnreadThread({ accountId, labelIds: [sent], unread: 1 })
  await seedUnreadThread({ accountId, labelIds: [trash], unread: 3 })
  return accountId
}

describe("sidebar", () => {
  it("renders the folder list with unread counts from the active account", async () => {
    await seedActiveAccount()
    await initAccountStore()

    renderSidebar()

    const folders = within(screen.getByRole("navigation", { name: "Folders" }))
    expect(await folders.findByText("2")).toBeTruthy()
    // Badge text sits inside its folder button; the seeded sent-only gmail
    // thread also matches the archive preset (absent-INBOX semantics shared
    // with listThreadsByFolder), so Archive shows "1" as well.
    expect(
      within(folders.getByRole("button", { name: /Sent/ })).getByText("1")
    ).toBeTruthy()
    expect(
      within(folders.getByRole("button", { name: /Archive/ })).getByText("1")
    ).toBeTruthy()
    expect(
      within(folders.getByRole("button", { name: /Trash/ })).getByText("3")
    ).toBeTruthy()
    // The full seven-folder set renders from the shared FOLDER_ITEMS
    // constant (./folders) — Spam and Drafts complete the list.
    expect(folders.getByRole("button", { name: /Drafts/ })).toBeTruthy()
    expect(folders.getByRole("button", { name: /Spam/ })).toBeTruthy()
    // zero-count folders show no badge
    const starredButton = folders.getByRole("button", { name: /Starred/ })
    expect(within(starredButton).queryByText(/^\d+$/)).toBeNull()
    // the default view (inbox) is highlighted
    expect(
      folders
        .getByRole("button", { name: /Inbox/ })
        .getAttribute("aria-current")
    ).toBe("true")
  })

  it("selecting a folder updates the uiStore view and the highlight", async () => {
    await seedActiveAccount()
    await initAccountStore()

    renderSidebar()

    const trashButton = await screen.findByRole("button", { name: "Trash" })
    fireEvent.click(trashButton)

    expect(useUiStore.getState().view).toEqual({
      kind: "folder",
      folder: { kind: "specialUse", specialUse: "trash" },
    })
    await waitFor(() => {
      expect(trashButton.getAttribute("aria-current")).toBe("true")
    })
    expect(
      screen.getByRole("button", { name: /Inbox/ }).getAttribute("aria-current")
    ).toBeNull()
  })

  it("lists user labels as a /-hierarchy (parent before indented child) and selects the full-name label", async () => {
    const accountId = await seedActiveAccount()
    const work = await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    const invoices = await createGmailLabel(
      executor,
      accountId,
      "Work/Invoices",
      "Label_inv",
      undefined,
      "user"
    )
    await createGmailLabel(
      executor,
      accountId,
      "Zeta",
      "Label_zeta",
      undefined,
      "user"
    )
    // gmail colors are data (hex strings); one label carries one
    await updateLabel(executor, work, { color: "#aabbcc" })
    await initAccountStore()

    renderSidebar()

    const labelsNav = await screen.findByRole("navigation", { name: "Labels" })
    // The section header carries a "New label" button and every row an
    // "Options for …" menu trigger — filter to the label row buttons.
    const rowButtons = within(labelsNav)
      .getAllByRole("button")
      .filter((button) => {
        const accessibleName =
          button.getAttribute("aria-label") ?? button.textContent ?? ""
        return (
          accessibleName !== "New label" &&
          !accessibleName.startsWith("Options for ")
        )
      })
    // system labels (INBOX/SENT/TRASH) are filtered out by type.
    expect(rowButtons.map((button) => button.textContent)).toEqual([
      "Work",
      "Invoices",
      "Zeta",
    ])

    // children are indented via a spacer span, parents are not
    const workButton = within(labelsNav).getByRole("button", { name: "Work" })
    const invoicesButton = within(labelsNav).getByRole("button", {
      name: "Invoices",
    })
    expect(workButton.querySelector("span.w-3")).toBeNull()
    expect(invoicesButton.querySelector("span.w-3")).toBeTruthy()

    // data-driven color dot: the label's own color string, inline
    // (jsdom serializes the hex to rgb)
    const dot = workButton.querySelector("span[style]")
    expect(dot?.getAttribute("style")).toContain("rgb(170, 187, 204)")

    fireEvent.click(invoicesButton)
    expect(useUiStore.getState().view).toEqual({
      kind: "label",
      labelId: invoices,
      name: "Work/Invoices",
    })
  })

  it("compose entry drives the uiStore", async () => {
    await seedActiveAccount()
    await initAccountStore()

    renderSidebar()

    // The Settings entry lives in the shell's pane header now
    // (mail-shell.test.tsx covers the navigation it triggers).
    fireEvent.click(await screen.findByRole("button", { name: "Compose" }))
    expect(useUiStore.getState().composerOpen).toBe(true)
  })

  it("collapse renders an icon rail: aria-labelled icons, no badges, no labels section", async () => {
    await seedActiveAccount()
    await initAccountStore()

    renderSidebar(true)

    const folders = within(screen.getByRole("navigation", { name: "Folders" }))
    expect(folders.getByRole("button", { name: "Inbox" })).toBeTruthy()
    expect(folders.getByRole("button", { name: "Starred" })).toBeTruthy()
    // counts live in tooltips only, never as visible text
    expect(folders.queryByText("2")).toBeNull()
    // no labels section and no wide compose button
    expect(screen.queryByRole("navigation", { name: "Labels" })).toBeNull()
    expect(screen.queryByText("Compose")).toBeNull()
    expect(screen.getByRole("button", { name: "Compose" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }))
    expect(useUiStore.getState().sidebarCollapsed).toBe(true)
  })

  it("refreshes folder counts when the active account changes", async () => {
    await seedActiveAccount()
    const secondId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      secondId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    await seedUnreadThread({
      accountId: secondId,
      labelIds: [inbox],
      unread: 7,
    })
    await initAccountStore()

    renderSidebar()

    expect(await screen.findByText("2")).toBeTruthy()
    void useAccountStore.getState().setActive(secondId)
    await waitFor(() => {
      expect(useFolderCountsStore.getState().accountId).toBe(secondId)
    })
    expect(await screen.findByText("7")).toBeTruthy()
    expect(screen.queryByText("2")).toBeNull()
  })

  // ---- Label CRUD (task 10.4) — the dialogs run the real label-admin
  // flows against the seeded database; the sidebar reloads through the
  // notifyUserLabelsChanged() hook. ----

  it("the + button opens the create dialog; creating adds the row and queues create_label", async () => {
    await seedActiveAccount()
    await initAccountStore()

    renderSidebar()

    fireEvent.click(await screen.findByRole("button", { name: "New label" }))
    const dialog = await screen.findByRole("dialog", { name: "New label" })
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Work" },
    })
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create label" })
    )

    // The row appears through the sidebar refresh hook.
    expect(await screen.findByRole("button", { name: "Work" })).toBeTruthy()
    // Local-first: the row is stored and the server create is queued.
    const rows = await executor.select<{ name: string; type: string }>(
      "SELECT name, type FROM labels WHERE type = 'user'"
    )
    expect(rows.map((row) => row.name)).toEqual(["Work"])
    const ops = await executor.select<{
      op_type: string
      payload_json: string
    }>("SELECT op_type, payload_json FROM pending_operations")
    expect(ops).toHaveLength(1)
    expect(ops[0].op_type).toBe("create_label")
    expect(JSON.parse(ops[0].payload_json)).toMatchObject({ name: "Work" })
  })

  it("creating with a slash name nests the label without a parent pick", async () => {
    await seedActiveAccount()
    await initAccountStore()

    renderSidebar()

    fireEvent.click(await screen.findByRole("button", { name: "New label" }))
    const dialog = await screen.findByRole("dialog", { name: "New label" })
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Work/Invoices" },
    })
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create label" })
    )

    const invoices = await screen.findByRole("button", {
      name: "Invoices",
    })
    // "/"-hierarchy display: child label indented, full name stored once.
    expect(invoices.querySelector("span.w-3")).toBeTruthy()
    const rows = await executor.select<{ name: string }>(
      "SELECT name FROM labels WHERE type = 'user'"
    )
    expect(rows.map((row) => row.name)).toEqual(["Work/Invoices"])
  })

  it("the per-label menu renames a label, keeping the hierarchy display", async () => {
    const accountId = await seedActiveAccount()
    await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    await initAccountStore()

    renderSidebar()

    fireEvent.click(
      await screen.findByRole("button", { name: "Options for Work" })
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }))

    const dialog = await screen.findByRole("dialog", { name: "Rename label" })
    const nameInput = within(dialog).getByLabelText("Name") as HTMLInputElement
    expect(nameInput.value).toBe("Work")
    fireEvent.change(nameInput, { target: { value: "Personal" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }))

    expect(await screen.findByRole("button", { name: "Personal" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull()
    const ops = await executor.select<{
      op_type: string
      payload_json: string
    }>("SELECT op_type, payload_json FROM pending_operations")
    expect(ops).toHaveLength(1)
    expect(ops[0].op_type).toBe("rename_label")
    expect(JSON.parse(ops[0].payload_json)).toMatchObject({
      previousName: "Work",
      name: "Personal",
    })
  })

  it("delete asks for confirmation, then removes the row and queues delete_label", async () => {
    const accountId = await seedActiveAccount()
    await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    await initAccountStore()

    renderSidebar()

    fireEvent.click(
      await screen.findByRole("button", { name: "Options for Work" })
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete…" }))

    const dialog = await screen.findByRole("dialog", { name: "Delete label" })
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete label" })
    )

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Work" })).toBeNull()
    })
    const ops = await executor.select<{ op_type: string }>(
      "SELECT op_type FROM pending_operations"
    )
    expect(ops.map((op) => op.op_type)).toEqual(["delete_label"])
    const rows = await executor.select<{ id: string }>(
      "SELECT id FROM labels WHERE type = 'user'"
    )
    expect(rows).toHaveLength(0)
  })

  it("system labels never render an options menu (protection)", async () => {
    await seedActiveAccount() // only system labels seeded
    await initAccountStore()

    renderSidebar()

    const labelsNav = await screen.findByRole("navigation", { name: "Labels" })
    expect(within(labelsNav).queryByText("New label")).toBeNull()
    expect(screen.getByRole("button", { name: "New label" })).toBeTruthy()
    const optionsMenus = within(labelsNav)
      .getAllByRole("button")
      .filter((button) =>
        (button.getAttribute("aria-label") ?? "").startsWith("Options for ")
      )
    expect(optionsMenus).toHaveLength(0)
  })
})
