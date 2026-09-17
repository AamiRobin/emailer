import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Data-portability section tests (task 19.4): the settings entry points
 * for the task 19.1–19.3 export/import services. The service module is
 * mocked (its behavior has its own suites in services/data-portability/
 * __tests__); the section is exercised against the real node:sqlite
 * schema (executor-module seam, the settings-page pattern) so the folder
 * pickers list the account's real labels rows.
 */

const executorHolder = vi.hoisted(() => ({
  current: null as SqlExecutor | null,
}))

const portabilityHolder = vi.hoisted(() => ({
  exportFolderAsMbox: vi.fn(),
  importFiles: vi.fn(),
  pickImportFiles: vi.fn(),
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

vi.mock("@/services/data-portability", () => ({
  exportFolderAsMbox: portabilityHolder.exportFolderAsMbox,
  importFiles: portabilityHolder.importFiles,
  pickImportFiles: portabilityHolder.pickImportFiles,
}))

import { createTestExecutor } from "@/services/db/__tests__/test-executor"
import type { ImportSummary } from "@/services/data-portability"
import { useAccountStore } from "@/stores/account-store"
import { DataPortabilitySection } from "../data-portability-section"

const ACCOUNT = "acc-1"

let executor: ReturnType<typeof createTestExecutor>

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [ACCOUNT, "imap", `${ACCOUNT}@example.com`]
  )
  await executor.execute(
    `INSERT INTO labels (id, account_id, name, imap_folder_name, type)
     VALUES ('l-receipts', $1, 'Receipts', 'Receipts', 'user')`,
    [ACCOUNT]
  )
  await executor.execute(
    `INSERT INTO labels (id, account_id, name, imap_folder_name, type, special_use)
     VALUES ('l-inbox', $1, 'INBOX', 'INBOX', 'system', 'inbox')`,
    [ACCOUNT]
  )
  useAccountStore.setState({
    accounts: [
      {
        id: ACCOUNT,
        type: "imap" as const,
        email: `${ACCOUNT}@example.com`,
        displayName: null,
        status: "active" as const,
        unreadCount: 0,
      },
    ],
    activeAccountId: ACCOUNT,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useAccountStore.setState({ accounts: [], activeAccountId: null })
  executorHolder.current = null
  executor.close()
})

function folderSelect(): HTMLElement {
  return screen.getByRole("combobox", { name: "Folder to export" })
}

function destinationSelect(): HTMLElement {
  return screen.getByRole("combobox", { name: "Destination folder" })
}

/** Open a base-ui select and scope option queries to the opened listbox
 * (both pickers stay mounted, so global option queries are ambiguous). */
async function openOptions(trigger: HTMLElement) {
  fireEvent.click(trigger)
  const listbox = (await screen.findAllByRole("listbox")).at(-1)
  if (!listbox) throw new Error("select listbox did not open")
  return within(listbox)
}

/** The base-ui select pattern the rules/delivery-schedules suites use. */
function chooseOption(option: HTMLElement): void {
  fireEvent.pointerDown(option)
  fireEvent.click(option)
}

function uploadSwitch(): HTMLElement {
  return screen.getByRole("switch", { name: "Also upload to the server" })
}

function summary(): HTMLElement {
  return screen.getByTestId("import-summary")
}

describe("DataPortabilitySection rendering", () => {
  it("lists the account's folders in the export and destination pickers", async () => {
    render(<DataPortabilitySection />)

    const exportOptions = await openOptions(folderSelect())
    expect(exportOptions.getByRole("option", { name: "Receipts" })).toBeTruthy()
    expect(exportOptions.getByRole("option", { name: "INBOX" })).toBeTruthy()

    const destinationOptions = await openOptions(destinationSelect())
    // The destination picker also offers folder creation.
    expect(
      destinationOptions.getByRole("option", { name: "New folder…" })
    ).toBeTruthy()
    expect(
      destinationOptions.getByRole("option", { name: "Receipts" })
    ).toBeTruthy()
  })

  it("reveals the new-folder name field and gates Import on it", async () => {
    portabilityHolder.pickImportFiles.mockResolvedValue(["/picked/b.mbox"])
    render(<DataPortabilitySection />)

    fireEvent.click(screen.getByRole("button", { name: "Choose files…" }))
    await screen.findByText(/1 file: b\.mbox/)

    const importButton = screen.getByRole("button", { name: "Import" })
    expect(importButton).toHaveProperty("disabled", true)

    const options = await openOptions(destinationSelect())
    chooseOption(options.getByRole("option", { name: "New folder…" }))
    fireEvent.change(screen.getByLabelText("New folder name"), {
      target: { value: "Archive/2024" },
    })
    expect(importButton).toHaveProperty("disabled", false)
  })
})

describe("DataPortabilitySection export", () => {
  it("exports the selected folder and reports the result", async () => {
    portabilityHolder.exportFolderAsMbox.mockResolvedValue({
      status: "complete",
      path: "/picked/Receipts.mbox",
      messages: 3,
    })
    render(<DataPortabilitySection />)

    const options = await openOptions(folderSelect())
    chooseOption(options.getByRole("option", { name: "Receipts" }))
    fireEvent.click(screen.getByRole("button", { name: /Export…/ }))

    await screen.findByText(/Exported 3 messages to \/picked\/Receipts\.mbox\./)
    expect(portabilityHolder.exportFolderAsMbox).toHaveBeenCalledWith(
      executor,
      ACCOUNT,
      { kind: "labelId", labelId: "l-receipts" },
      expect.objectContaining({
        signal: expect.objectContaining({ aborted: false }),
      })
    )
  })

  it("shows progress while exporting and offers Cancel via the abort signal", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    portabilityHolder.exportFolderAsMbox.mockImplementation(
      async (_executor, _accountId, _folder, options) => {
        options.onProgress?.(1, 3)
        await gate
        return { status: "cancelled", path: "/p", messages: 1 }
      }
    )
    render(<DataPortabilitySection />)
    const options = await openOptions(folderSelect())
    chooseOption(options.getByRole("option", { name: "Receipts" }))
    fireEvent.click(screen.getByRole("button", { name: /Export…/ }))

    await screen.findByText(/Exporting… 1 \/ 3/)
    const cancelButton = screen.getByRole("button", { name: "Cancel" })
    expect(cancelButton).toHaveProperty("disabled", false)
    // The Cancel button aborts the run's signal; the job then finishes.
    fireEvent.click(cancelButton)
    await waitFor(() =>
      expect(
        portabilityHolder.exportFolderAsMbox.mock.calls[0][3].signal.aborted
      ).toBe(true)
    )
    release?.()
    await screen.findByText(/Export cancelled/)
  })

  it("surfaces a failed export without crashing the section", async () => {
    portabilityHolder.exportFolderAsMbox.mockRejectedValue(
      new Error("folder vanished")
    )
    render(<DataPortabilitySection />)

    const options = await openOptions(folderSelect())
    chooseOption(options.getByRole("option", { name: "Receipts" }))
    fireEvent.click(screen.getByRole("button", { name: /Export…/ }))
    await screen.findByText(/Export failed: folder vanished/)
  })
})

describe("DataPortabilitySection import", () => {
  function summaryFixture(): ImportSummary {
    return {
      status: "complete",
      folderLabelId: "l-new",
      folderName: "Archive/2024",
      imported: 3,
      skippedDuplicates: 2,
      failed: 1,
      uploaded: 0,
      uploadFailures: 1,
      files: [
        {
          file: "/picked/backup.mbox",
          kind: "mbox",
          imported: 3,
          skippedDuplicates: 2,
          uploaded: 0,
          failed: [
            {
              index: 4,
              error:
                "no subject or participant header found — not an RFC 822 message",
            },
          ],
          uploadFailures: [
            { index: 5, subject: "Invoice", error: "network unreachable" },
          ],
        },
      ],
    }
  }

  it("runs the import with the picked files, folder name and upload option", async () => {
    portabilityHolder.pickImportFiles.mockResolvedValue(["/picked/backup.mbox"])
    portabilityHolder.importFiles.mockResolvedValue(summaryFixture())
    render(<DataPortabilitySection />)

    fireEvent.click(screen.getByRole("button", { name: "Choose files…" }))
    await screen.findByText(/1 file: backup\.mbox/)
    fireEvent.change(screen.getByLabelText("New folder name"), {
      target: { value: "Archive/2024" },
    })
    fireEvent.click(uploadSwitch())

    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    await screen.findByTestId("import-summary")
    expect(portabilityHolder.importFiles).toHaveBeenCalledWith(executor, {
      accountId: ACCOUNT,
      destination: { kind: "folderName", name: "Archive/2024" },
      filePaths: ["/picked/backup.mbox"],
      uploadToServer: true,
      signal: expect.objectContaining({ aborted: false }),
      onProgress: expect.any(Function),
    })
  })

  it("reports imported, skipped and per-file failures from the summary", async () => {
    portabilityHolder.pickImportFiles.mockResolvedValue(["/picked/backup.mbox"])
    portabilityHolder.importFiles.mockResolvedValue(summaryFixture())
    render(<DataPortabilitySection />)

    fireEvent.click(screen.getByRole("button", { name: "Choose files…" }))
    await screen.findByText(/1 file: backup\.mbox/)
    fireEvent.change(screen.getByLabelText("New folder name"), {
      target: { value: "Archive/2024" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Import" }))

    await screen.findByTestId("import-summary")
    expect(summary().textContent).toContain("Imported 3")
    expect(summary().textContent).toContain("skipped 2 duplicates")
    expect(summary().textContent).toContain("failed 1")
    expect(summary().textContent).toContain("1 upload failed (kept locally)")
    expect(summary().textContent).toContain("not an RFC 822 message")
    expect(summary().textContent).toContain(
      "upload failed — network unreachable"
    )
  })

  it("reuses an existing folder as the destination when selected", async () => {
    portabilityHolder.pickImportFiles.mockResolvedValue(["/picked/backup.mbox"])
    portabilityHolder.importFiles.mockResolvedValue(summaryFixture())
    render(<DataPortabilitySection />)

    fireEvent.click(screen.getByRole("button", { name: "Choose files…" }))
    await screen.findByText(/1 file: backup\.mbox/)
    const options = await openOptions(destinationSelect())
    chooseOption(options.getByRole("option", { name: "Receipts" }))

    fireEvent.click(screen.getByRole("button", { name: "Import" }))
    await screen.findByTestId("import-summary")
    expect(portabilityHolder.importFiles).toHaveBeenCalledWith(
      executor,
      expect.objectContaining({
        destination: { kind: "folderId", folderId: "l-receipts" },
        uploadToServer: false,
      })
    )
  })

  it("surfaces an import rejection without crashing the section", async () => {
    portabilityHolder.pickImportFiles.mockResolvedValue(["/picked/broken.eml"])
    portabilityHolder.importFiles.mockRejectedValue(
      new Error("destination folder not found in this account")
    )
    render(<DataPortabilitySection />)

    fireEvent.click(screen.getByRole("button", { name: "Choose files…" }))
    await screen.findByText(/1 file: broken\.eml/)
    fireEvent.change(screen.getByLabelText("New folder name"), {
      target: { value: "Recovered" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Import" }))
    await screen.findByText(/Import failed: destination folder not found/)
  })
})
