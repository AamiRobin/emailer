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
  createMessage,
  createThread,
  at,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  setAccountStoreExecutor,
  useAccountStore,
  type AccountInfo,
} from "@/stores/account-store"
import { DEFAULT_VIEW, useUiStore, type ViewSelection } from "@/stores/ui-store"
import { AttachmentsBrowser } from "../attachments-browser"
import {
  fetchAttachmentPreviewBytes,
  saveAttachmentToDisk,
  setAttachmentBrowserExecutor,
} from "../use-attachment-browser"

/**
 * Attachments browser (task 3.7, design D14). The list runs its real
 * query against a seeded node:sqlite database via the executor override
 * hook (the contacts-browser.test.tsx harness) while the byte-moving
 * flows (preview fetch, save-to-disk) are stubbed at the module seam —
 * the component's contract is WHICH entry it acts on, not the fetch
 * itself. The action-level contracts (toast confirmation, cancel
 * silence, account resolution) are covered in use-attachment-browser
 * tests against the REAL flows.
 */

vi.mock("../use-attachment-browser", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../use-attachment-browser")>()
  return {
    ...actual,
    saveAttachmentToDisk: vi.fn(),
    fetchAttachmentPreviewBytes: vi.fn(),
  }
})

const saveMock = vi.mocked(saveAttachmentToDisk)
const previewMock = vi.mocked(fetchAttachmentPreviewBytes)

let executor: TestExecutor

function accountInfo(id: string): AccountInfo {
  return {
    id,
    type: "gmail",
    email: `${id}@example.com`,
    displayName: null,
    status: "active",
    unreadCount: 0,
  }
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
    previousView: DEFAULT_VIEW,
    listScope: null,
  })
}

/** A 1x1 PNG header — enough bytes for the preview seam, no decoder. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

beforeEach(() => {
  resetStores()
  vi.clearAllMocks()
  executor = createTestExecutor()
  setAttachmentBrowserExecutor(executor)
  setAccountStoreExecutor(executor)
  // The image preview's object-URL lifecycle is browser-only.
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(() => "blob:preview"),
  })
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  setAttachmentBrowserExecutor(null)
  setAccountStoreExecutor(null)
  executor.close()
  resetStores()
})

let accountA: string
let accountB: string
const threadIds: Record<string, string> = {}

/** One account with five attachments across three threads (newest first:
 * report.pdf, chart.png — then offsite-photo.jpg, then backup.zip,
 * notes.docx), plus a second account whose attachment must not leak in. */
async function seedAttachments(): Promise<void> {
  accountA = await createAccount(executor, "gmail")
  accountB = await createAccount(executor, "imap")

  threadIds.report = await createThread(executor, accountA, {
    subject: "Quarterly report",
  })
  await createMessage(executor, {
    threadId: threadIds.report,
    accountId: accountA,
    date: at(100),
    subject: "Quarterly report",
    fromName: "Boss",
    fromAddress: "boss@x.com",
    gmailMessageId: "g-1",
    hasAttachments: true,
    attachments: [
      {
        id: "att-report",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 2048,
        providerPartId: "0",
      },
      {
        id: "att-chart",
        filename: "chart.png",
        mimeType: "image/png",
        size: 4096,
        providerPartId: "1",
      },
    ],
  })

  threadIds.photo = await createThread(executor, accountA, {
    subject: "Offsite",
  })
  await createMessage(executor, {
    threadId: threadIds.photo,
    accountId: accountA,
    date: at(50),
    subject: "Offsite",
    fromName: "Cole",
    fromAddress: "cole@x.com",
    hasAttachments: true,
    attachments: [
      {
        id: "att-photo",
        filename: "offsite-photo.jpg",
        mimeType: "image/jpeg",
        size: 8192,
        providerPartId: "0",
      },
    ],
  })

  threadIds.backup = await createThread(executor, accountA, {
    subject: "Backup",
  })
  await createMessage(executor, {
    threadId: threadIds.backup,
    accountId: accountA,
    date: at(10),
    subject: "Backup",
    fromName: "Dev",
    fromAddress: "dev@x.com",
    hasAttachments: true,
    attachments: [
      {
        id: "att-zip",
        filename: "backup.zip",
        mimeType: "application/zip",
        size: 102400,
        providerPartId: "0",
      },
      {
        id: "att-doc",
        filename: "notes.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 512,
        providerPartId: "1",
      },
    ],
  })

  const threadOther = await createThread(executor, accountB, {
    subject: "Other",
  })
  await createMessage(executor, {
    threadId: threadOther,
    accountId: accountB,
    date: at(500),
    fromAddress: "other@x.com",
    hasAttachments: true,
    attachments: [
      {
        id: "att-secret",
        filename: "secret.pdf",
        mimeType: "application/pdf",
        size: 1,
        providerPartId: "0",
      },
    ],
  })

  useAccountStore.setState({
    accounts: [accountInfo(accountA), accountInfo(accountB)],
    activeAccountId: accountA,
    loaded: true,
  })
}

const entryTexts = (): string[] =>
  screen.queryAllByTestId("attachment-entry").map(
    (entry) => entry.textContent ?? ""
  )

const chip = (category: string): HTMLElement =>
  screen
    .getAllByTestId("attachments-filter-chip")
    .find((element) => element.dataset.category === category)!

describe("attachments browser (task 3.7)", () => {
  it("lists the current account's attachments, newest message first, with name, sender, date and size", async () => {
    await seedAttachments()
    render(<AttachmentsBrowser />)

    await waitFor(() => expect(entryTexts()).toHaveLength(5))
    expect(entryTexts()[0]).toContain("report.pdf")
    expect(entryTexts()[1]).toContain("chart.png")
    expect(entryTexts()[2]).toContain("offsite-photo.jpg")
    expect(entryTexts()[3]).toContain("backup.zip")
    expect(entryTexts()[4]).toContain("notes.docx")
    // Entry metadata: sender and a human size travel with the card…
    expect(entryTexts()[0]).toContain("Boss")
    expect(entryTexts()[0]).toContain("2.0 KB")
    // …and the other account's attachment never appears.
    expect(entryTexts().join("\n")).not.toContain("secret.pdf")
    // Every entry carries its attachment id and per-entry actions.
    const entries = screen.getAllByTestId("attachment-entry")
    expect(
      entries[0].querySelector('[data-testid="attachment-save"]')
    ).not.toBeNull()
    expect(
      entries[0].querySelector('[data-testid="attachment-show-message"]')
    ).not.toBeNull()
  })

  it("narrows by the type filter chips (PDFs scenario)", async () => {
    await seedAttachments()
    render(<AttachmentsBrowser />)
    await waitFor(() => expect(entryTexts()).toHaveLength(5))

    fireEvent.click(chip("pdfs"))
    expect(entryTexts()).toHaveLength(1)
    expect(entryTexts()[0]).toContain("report.pdf")
    expect(chip("pdfs").getAttribute("aria-pressed")).toBe("true")

    fireEvent.click(chip("images"))
    expect(entryTexts()).toHaveLength(2)
    expect(entryTexts().join("\n")).toContain("chart.png")
    expect(entryTexts().join("\n")).toContain("offsite-photo.jpg")

    // Back to everything.
    fireEvent.click(chip("all"))
    await waitFor(() => expect(entryTexts()).toHaveLength(5))
  })

  it("narrows by free-text search and shows a no-match state", async () => {
    await seedAttachments()
    render(<AttachmentsBrowser />)
    await waitFor(() => expect(entryTexts()).toHaveLength(5))

    const search = screen.getByRole("textbox", { name: "Search attachments" })
    fireEvent.change(search, { target: { value: "photo" } })
    await waitFor(() => expect(entryTexts()).toHaveLength(1))
    expect(entryTexts()[0]).toContain("offsite-photo.jpg")

    fireEvent.change(search, { target: { value: "zzz" } })
    expect(screen.getByText("No attachments match “zzz”")).not.toBeNull()

    // Clearing restores the full (sorted) list.
    fireEvent.change(search, { target: { value: "" } })
    await waitFor(() => expect(entryTexts()).toHaveLength(5))
  })

  it("toggles between grid and list presentation", async () => {
    await seedAttachments()
    render(<AttachmentsBrowser />)
    await waitFor(() => expect(entryTexts()).toHaveLength(5))
    expect(
      screen.getByTestId("attachments-layout-grid").getAttribute("aria-pressed")
    ).toBe("true")

    fireEvent.click(screen.getByTestId("attachments-layout-list"))

    expect(
      screen.getByTestId("attachments-layout-list").getAttribute("aria-pressed")
    ).toBe("true")
    // Same entries, different presentation.
    expect(entryTexts()).toHaveLength(5)
    expect(screen.getAllByTestId("attachment-entry")).toHaveLength(5)
  })

  it("jump to source restores the mailbox view and opens the thread", async () => {
    await seedAttachments()
    const inbox: ViewSelection = {
      kind: "folder",
      folder: { kind: "specialUse", specialUse: "inbox" },
    }
    useUiStore.setState({ view: { kind: "attachments" }, previousView: inbox })
    render(<AttachmentsBrowser />)
    await waitFor(() => expect(entryTexts()).toHaveLength(5))

    const entries = screen.getAllByTestId("attachment-entry")
    fireEvent.click(
      entries[2].querySelector('[data-testid="attachment-show-message"]')!
    )

    const ui = useUiStore.getState()
    expect(ui.view).toEqual(inbox)
    expect(ui.activeThread).toBe(threadIds.photo)
  })

  it("save-to-disk hands the entry to the existing save path and shows the busy state", async () => {
    await seedAttachments()
    // Resolving "saved" mirrors a completed dialog write (the toast
    // confirmation is asserted against the REAL flow in the
    // use-attachment-browser tests). The ref object defeats TS's
    // closure-blind narrowing (a plain `let` assigned only inside a
    // callback reads as still-null at the call site).
    const resolveSaveRef: {
      current: ((outcome: "saved" | "cancelled" | "failed") => void) | null
    } = { current: null }
    saveMock.mockImplementation(
      () =>
        new Promise<"saved" | "cancelled" | "failed">((resolve) => {
          resolveSaveRef.current = resolve
        })
    )
    render(<AttachmentsBrowser />)
    await waitFor(() => expect(entryTexts()).toHaveLength(5))

    const entries = screen.getAllByTestId("attachment-entry")
    fireEvent.click(entries[0].querySelector('[data-testid="attachment-save"]')!)

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1))
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "att-report", filename: "report.pdf" })
    )
    // The row shows the in-flight state while the fetch/dialog runs…
    expect(
      screen.getAllByTestId("attachment-entry")[0].textContent
    ).toContain("Saving…")
    resolveSaveRef.current?.("saved")
    // …and recovers afterwards.
    await waitFor(() =>
      expect(
        screen.getAllByTestId("attachment-entry")[0].textContent
      ).not.toContain("Saving…")
    )
  })

  it("expands an entry inline: the preview bytes are fetched lazily and images render", async () => {
    await seedAttachments()
    previewMock.mockResolvedValue(PNG_BYTES)
    render(<AttachmentsBrowser />)
    await waitFor(() => expect(entryTexts()).toHaveLength(5))

    // Click the image entry's tile to expand its preview.
    const chartEntry = screen
      .getAllByTestId("attachment-entry")
      .find((entry) => entry.dataset.attachmentId === "att-chart")!
    fireEvent.click(chartEntry.querySelector("button")!)

    expect(await screen.findByTestId("attachment-preview-image")).not.toBeNull()
    expect(previewMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "att-chart" })
    )
    expect(URL.createObjectURL).toHaveBeenCalled()

    // Clicking again collapses it (and only the expanded entry fetches).
    fireEvent.click(chartEntry.querySelector("button")!)
    expect(screen.queryByTestId("attachment-preview-image")).toBeNull()
    expect(previewMock).toHaveBeenCalledTimes(1)
  })

  it("the back control restores the mailbox view the user came from", async () => {
    await seedAttachments()
    const inbox: ViewSelection = {
      kind: "folder",
      folder: { kind: "specialUse", specialUse: "inbox" },
    }
    useUiStore.setState({ view: { kind: "attachments" }, previousView: inbox })
    render(<AttachmentsBrowser />)
    await waitFor(() => expect(entryTexts()).toHaveLength(5))

    fireEvent.click(screen.getByRole("button", { name: "Back to mailbox" }))

    expect(useUiStore.getState().view).toEqual(inbox)
  })
})
