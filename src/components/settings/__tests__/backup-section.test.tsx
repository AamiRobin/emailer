import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

/**
 * Backup & restore settings section tests (parity-round-3 task 5.5). The
 * backup service module is mocked at its four entry points (each has its
 * own orchestration suites); the real typed error classes stay — the
 * section's error mapping branches on `instanceof`/`kind`, so it must be
 * exercised against the real shapes.
 */

const backupHolder = vi.hoisted(() => ({
  exportBackup: vi.fn(),
  inspectBackupArchive: vi.fn(),
  pickBackupArchive: vi.fn(),
  restoreBackup: vi.fn(),
}))

vi.mock("@/services/settings/backup", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/services/settings/backup")
  >()
  return {
    ...actual,
    exportBackup: backupHolder.exportBackup,
    inspectBackupArchive: backupHolder.inspectBackupArchive,
    pickBackupArchive: backupHolder.pickBackupArchive,
    restoreBackup: backupHolder.restoreBackup,
  }
})

import {
  BackupError,
  UnsupportedManifestVersionError,
} from "@/services/settings/backup"
import { RestoreCancelledError } from "@/services/settings/backup-merge"
import { BackupSection } from "../backup-section"

const MANIFEST = {
  version: 1,
  createdAt: "2026-10-01T08:09:10.000Z",
  appVersion: "0.1.0",
}

const MERGE_SUMMARY = {
  accountsAdded: 1,
  accountsKept: 2,
  profilesAdded: 1,
  settingsAdded: 3,
  rulesAdded: 4,
  snippetsAdded: 0,
  savedSearchesAdded: 1,
  senderCategoriesAdded: 0,
}

beforeEach(() => {
  for (const mock of Object.values(backupHolder)) {
    mock.mockReset()
  }
  backupHolder.pickBackupArchive.mockResolvedValue(null)
})

afterEach(() => {
  cleanup()
})

function modeSelect(): HTMLElement {
  return screen.getByRole("combobox", { name: "What should happen?" })
}

/** Open the base-ui select and scope option queries to the listbox (the
 * data-portability suite's pattern). */
async function openModeOptions() {
  fireEvent.click(modeSelect())
  const listbox = (await screen.findAllByRole("listbox")).at(-1)
  if (!listbox) throw new Error("select listbox did not open")
  return within(listbox)
}

function chooseOption(option: HTMLElement): void {
  fireEvent.pointerDown(option)
  fireEvent.click(option)
}

async function openRestoreDialog(): Promise<void> {
  backupHolder.pickBackupArchive.mockResolvedValue("/tmp/x.backup-test")
  backupHolder.inspectBackupArchive.mockResolvedValue(MANIFEST)
  fireEvent.click(screen.getByTestId("backup-restore"))
  await screen.findByTestId("backup-restore-dialog")
}

describe("BackupSection export (task 5.1 UI)", () => {
  it("renders the export and restore rows", () => {
    render(<BackupSection />)

    expect(screen.getByRole("heading", { name: "Backup & restore" }))
    expect(screen.getByTestId("backup-export")).toBeTruthy()
    expect(screen.getByTestId("backup-restore")).toBeTruthy()
    // Export promises no credentials inside the archive.
    expect(screen.getByText(/No passwords or tokens/)).toBeTruthy()
  })

  it("reports the finished archive with its size", async () => {
    backupHolder.exportBackup.mockResolvedValue({
      path: "/tmp/emailer-backup-2026-10-04.emailer-backup",
      bytes: 2048,
      summary: { accounts: 1, calendarSources: 0, carddavBooks: 0 },
    })

    render(<BackupSection />)
    fireEvent.click(screen.getByTestId("backup-export"))

    const status = await screen.findByTestId("backup-export-status")
    expect(status.textContent).toContain(
      "/tmp/emailer-backup-2026-10-04.emailer-backup"
    )
    expect(status.textContent).toContain("2.0 KB")
    expect(
      (screen.getByTestId("backup-export") as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it("shows nothing when the destination dialog is cancelled", async () => {
    backupHolder.exportBackup.mockResolvedValue(null)

    render(<BackupSection />)
    fireEvent.click(screen.getByTestId("backup-export"))

    await waitFor(() => {
      expect(
        (screen.getByTestId("backup-export") as HTMLButtonElement).disabled
      ).toBe(false)
    })
    expect(screen.queryByTestId("backup-export-status")).toBeNull()
  })

  it("toasts a typed failure and keeps the section usable", async () => {
    backupHolder.exportBackup.mockRejectedValue(
      new BackupError("io", "destination unwritable")
    )

    render(<BackupSection />)
    fireEvent.click(screen.getByTestId("backup-export"))

    await waitFor(() => {
      expect(
        (screen.getByTestId("backup-export") as HTMLButtonElement).disabled
      ).toBe(false)
    })
    expect(screen.queryByTestId("backup-export-status")).toBeNull()
  })
})

describe("BackupSection restore (tasks 5.2/5.3/5.5 UI)", () => {
  it("shows the verified manifest facts before asking for a mode", async () => {
    render(<BackupSection />)
    await openRestoreDialog()

    const facts = screen.getByTestId("backup-manifest-facts")
    expect(facts.textContent).toContain("v1")
    expect(facts.textContent).toContain("0.1.0")

    // Replace is the default choice, with the explicit warning copy.
    const warning = screen.getByTestId("backup-mode-warning")
    expect(warning.textContent).toContain("deletes everything")
    expect(warning.textContent).toContain("sign in")
    expect(screen.getByTestId("backup-start").textContent).toContain(
      "Restore"
    )
  })

  it("states the merge limits when merge is selected", async () => {
    render(<BackupSection />)
    await openRestoreDialog()

    const options = await openModeOptions()
    chooseOption(options.getByRole("option", { name: "Merge into my current data" }))

    const warning = screen.getByTestId("backup-mode-warning")
    expect(warning.textContent).toContain("matched by email")
    expect(warning.textContent).toContain("NOT restored")
  })

  it("runs a replace restore and reports the re-auth outcome", async () => {
    backupHolder.restoreBackup.mockResolvedValue({
      mode: "replace",
      accountsRequiringReauth: 2,
    })

    render(<BackupSection />)
    await openRestoreDialog()
    fireEvent.click(screen.getByTestId("backup-start"))

    await screen.findByTestId("backup-result")
    expect(backupHolder.restoreBackup).toHaveBeenCalledWith(
      "/tmp/x.backup-test",
      "replace",
      expect.anything()
    )
    expect(screen.getByTestId("backup-result").textContent).toContain(
      "2 accounts were restored"
    )
    expect(screen.getByTestId("backup-result").textContent).toContain(
      "readable right now"
    )
    expect(screen.queryByTestId("backup-restore-dialog")).toBeNull()
  })

  it("runs a merge restore and reports the per-table summary", async () => {
    backupHolder.restoreBackup.mockResolvedValue({
      mode: "merge",
      summary: MERGE_SUMMARY,
    })

    render(<BackupSection />)
    await openRestoreDialog()
    const options = await openModeOptions()
    chooseOption(options.getByRole("option", { name: "Merge into my current data" }))
    fireEvent.click(screen.getByTestId("backup-start"))

    await screen.findByTestId("backup-result")
    expect(backupHolder.restoreBackup).toHaveBeenCalledWith(
      "/tmp/x.backup-test",
      "merge",
      expect.anything()
    )
    const result = screen.getByTestId("backup-result").textContent ?? ""
    expect(result).toContain("1 account added")
    expect(result).toContain("2 existing accounts left as-is")
    expect(result).toContain("4 rule(s)")
    expect(result).toContain("not part of a merge")
  })

  it("refuses an unknown manifest version with the typed copy", async () => {
    backupHolder.pickBackupArchive.mockResolvedValue("/tmp/x.backup-test")
    backupHolder.inspectBackupArchive.mockRejectedValue(
      new UnsupportedManifestVersionError(99)
    )

    render(<BackupSection />)
    fireEvent.click(screen.getByTestId("backup-restore"))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("newer version of Emailer")
    expect(screen.queryByTestId("backup-restore-dialog")).toBeNull()
  })

  it("refuses a corrupt archive before any dialog or mutation", async () => {
    backupHolder.pickBackupArchive.mockResolvedValue("/tmp/x.backup-test")
    backupHolder.inspectBackupArchive.mockRejectedValue(
      new BackupError(
        "checksum_mismatch",
        "entry db.snapshot does not match its manifest checksum"
      )
    )

    render(<BackupSection />)
    fireEvent.click(screen.getByTestId("backup-restore"))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("not a readable Emailer backup")
    expect(alert.textContent).toContain("not touched")
    expect(backupHolder.restoreBackup).not.toHaveBeenCalled()
    expect(screen.queryByTestId("backup-restore-dialog")).toBeNull()
  })

  it("closes the confirm dialog without restoring on cancel", async () => {
    render(<BackupSection />)
    await openRestoreDialog()
    fireEvent.click(screen.getByTestId("backup-cancel"))

    await waitFor(() => {
      expect(screen.queryByTestId("backup-restore-dialog")).toBeNull()
    })
    expect(backupHolder.restoreBackup).not.toHaveBeenCalled()
  })

  it("offers a working cancel while a merge restore runs", async () => {
    let signal: { aborted: boolean } | undefined
    let settle:
      | ((value: {
          mode: "merge"
          summary: typeof MERGE_SUMMARY
        }) => void)
      | undefined
    backupHolder.restoreBackup.mockImplementation(
      (_path: string, _mode: string, deps: { signal?: { aborted: boolean } }) => {
        signal = deps.signal
        return new Promise((resolve) => {
          settle = resolve
        })
      }
    )

    render(<BackupSection />)
    await openRestoreDialog()
    const options = await openModeOptions()
    chooseOption(options.getByRole("option", { name: "Merge into my current data" }))
    fireEvent.click(screen.getByTestId("backup-start"))

    await screen.findByText("Restoring…")
    expect(signal).toEqual({ aborted: false })

    // Cancel mid-restore flips the flag the merge transaction checks;
    // the service then throws RestoreCancelledError.
    fireEvent.click(screen.getByTestId("backup-cancel-restore"))
    expect(signal?.aborted).toBe(true)

    settle!({ mode: "merge", summary: MERGE_SUMMARY })
    await screen.findByTestId("backup-result")
  })

  it("maps a cancelled merge restore to the data-unchanged copy", async () => {
    backupHolder.restoreBackup.mockRejectedValue(new RestoreCancelledError())

    render(<BackupSection />)
    await openRestoreDialog()
    fireEvent.click(screen.getByTestId("backup-start"))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Restore cancelled")
    expect(alert.textContent).toContain("unchanged")
  })
})
