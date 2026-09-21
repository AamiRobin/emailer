import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

/**
 * Storage settings section tests (tasks 1.6/1.7). The service module is
 * mocked at its two command boundaries (getStorageUsage /
 * deleteAllLocalData) while the pure formatting/label helpers stay real,
 * so the suite exercises exactly the component's own behavior: the
 * breakdown render, refresh, the approximate note, and the TWO-STEP
 * delete-all confirmation (only the second explicit confirm wipes).
 */

const storageHolder = vi.hoisted(() => ({
  getStorageUsage: vi.fn(),
  deleteAllLocalData: vi.fn(),
}))

vi.mock("@/services/settings/storage", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/services/settings/storage")
  >()
  return {
    ...actual,
    getStorageUsage: storageHolder.getStorageUsage,
    deleteAllLocalData: storageHolder.deleteAllLocalData,
  }
})

import { StorageSection } from "../storage-section"

const USAGE = {
  kinds: [
    { kind: "attachments", bytes: 2048 },
    { kind: "databases", bytes: 3 * 1024 * 1024 },
    { kind: "keys", bytes: 32 },
    { kind: "other", bytes: 512 },
  ],
  total: 2048 + 3 * 1024 * 1024 + 32 + 512,
  unreadableEntries: 0,
}

beforeEach(() => {
  storageHolder.getStorageUsage.mockReset()
  storageHolder.deleteAllLocalData.mockReset()
})

afterEach(() => {
  cleanup()
})

function openDeleteDialog(): void {
  fireEvent.click(screen.getByTestId("storage-delete-all"))
}

describe("StorageSection usage breakdown (task 1.6)", () => {
  it("renders the per-kind breakdown with human sizes and the total", async () => {
    storageHolder.getStorageUsage.mockResolvedValue(USAGE)

    render(<StorageSection />)

    const rows = await screen.findByTestId("storage-usage")
    expect(rows).toBeTruthy()
    expect(screen.getByTestId("storage-kind-attachments").textContent).toContain(
      "Attachments"
    )
    expect(screen.getByTestId("storage-kind-attachments").textContent).toContain(
      "2.0 KB"
    )
    expect(screen.getByTestId("storage-kind-databases").textContent).toContain(
      "3.0 MB"
    )
    expect(screen.getByTestId("storage-kind-keys").textContent).toContain(
      "32 B"
    )
    expect(screen.getByTestId("storage-kind-other").textContent).toContain(
      "512 B"
    )
    expect(screen.getByTestId("storage-total").textContent).toBe("3.0 MB")
    // Databases row must say what lives inside the single DB file.
    expect(
      screen.getByTestId("storage-kind-databases").textContent
    ).toContain("message bodies")
  })

  it("refreshes on demand, showing the in-flight state", async () => {
    storageHolder.getStorageUsage.mockResolvedValueOnce(USAGE)
    let resolveSecond: ((value: typeof USAGE) => void) | undefined
    storageHolder.getStorageUsage.mockReturnValueOnce(
      new Promise<typeof USAGE>((resolve) => {
        resolveSecond = resolve
      })
    )

    render(<StorageSection />)
    await screen.findByTestId("storage-total")

    fireEvent.click(screen.getByTestId("storage-refresh"))
    expect(screen.getByTestId("storage-refresh")).toHaveProperty(
      "disabled",
      true
    )
    await waitFor(() => {
      expect(storageHolder.getStorageUsage).toHaveBeenCalledTimes(2)
    })
    resolveSecond!({
      ...USAGE,
      total: USAGE.total + 1024,
      kinds: USAGE.kinds.map((entry) =>
        entry.kind === "databases"
          ? { ...entry, bytes: entry.bytes + 1024 }
          : entry
      ),
    })
    await waitFor(() => {
      expect(screen.getByTestId("storage-total").textContent).toBe("3.0 MB")
    })
    expect(screen.getByTestId("storage-refresh")).toHaveProperty(
      "disabled",
      false
    )
  })

  it("surfaces an error state when the command fails", async () => {
    storageHolder.getStorageUsage.mockRejectedValue(new Error("no backend"))

    render(<StorageSection />)

    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.queryByTestId("storage-total")).toBeNull()
  })

  it("marks sizes approximate when the walk could not read some files", async () => {
    storageHolder.getStorageUsage.mockResolvedValue({
      ...USAGE,
      unreadableEntries: 3,
    })

    render(<StorageSection />)

    await screen.findByTestId("storage-total")
    expect(screen.getByText(/lower bound/)).toBeTruthy()
  })
})

describe("StorageSection delete-all two-step confirm (task 1.7)", () => {
  beforeEach(() => {
    storageHolder.getStorageUsage.mockResolvedValue(USAGE)
  })

  it("states the scope first and wipes only on the SECOND explicit confirm", async () => {
    storageHolder.deleteAllLocalData.mockResolvedValue(undefined)

    render(<StorageSection />)
    await screen.findByTestId("storage-total")
    openDeleteDialog()

    // Step 1: the exact removal scope, servers-untouched promise.
    const dialog = await screen.findByTestId("delete-all-data-dialog")
    const scope = await screen.findByTestId("delete-all-data-scope")
    expect(scope.textContent).toContain("every account's local mail")
    expect(scope.textContent).toContain("downloaded attachments")
    expect(scope.textContent).toContain("AI cache")
    expect(scope.textContent).toContain("calendar and task data")
    expect(scope.textContent).toContain("contacts")
    expect(scope.textContent).toContain("preferences")
    expect(scope.textContent).toContain("sealed credential slots")
    expect(dialog.textContent).toContain("Your mail servers are not touched")

    // No wipe may have been triggered by opening or by step 1's Continue.
    fireEvent.click(screen.getByTestId("delete-all-data-continue"))
    expect(storageHolder.deleteAllLocalData).not.toHaveBeenCalled()

    // Step 2: the explicit final confirm.
    expect(screen.getByText("Are you absolutely sure?")).toBeTruthy()
    fireEvent.click(screen.getByTestId("delete-all-data-confirm"))
    await waitFor(() => {
      expect(storageHolder.deleteAllLocalData).toHaveBeenCalledTimes(1)
    })
  })

  it("steps back to the scope without wiping", async () => {
    storageHolder.deleteAllLocalData.mockResolvedValue(undefined)

    render(<StorageSection />)
    await screen.findByTestId("storage-total")
    openDeleteDialog()
    fireEvent.click(screen.getByTestId("delete-all-data-continue"))
    fireEvent.click(screen.getByRole("button", { name: "Back" }))

    expect(
      await screen.findByTestId("delete-all-data-scope")
    ).toBeTruthy()
    expect(storageHolder.deleteAllLocalData).not.toHaveBeenCalled()
  })

  it("closes the dialog and keeps the app usable when the wipe fails", async () => {
    storageHolder.deleteAllLocalData.mockRejectedValue(
      new Error("wipe failed")
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    render(<StorageSection />)
    await screen.findByTestId("storage-total")
    openDeleteDialog()
    fireEvent.click(screen.getByTestId("delete-all-data-continue"))
    fireEvent.click(screen.getByTestId("delete-all-data-confirm"))

    await waitFor(() => {
      expect(screen.queryByTestId("delete-all-data-dialog")).toBeNull()
    })
    // The destructive action stays available for a retry.
    expect(screen.getByTestId("storage-delete-all")).toHaveProperty(
      "disabled",
      false
    )
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
