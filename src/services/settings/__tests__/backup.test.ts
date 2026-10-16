import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Backup export/restore orchestration tests (tasks 5.1–5.4). Every
 * Tauri/plugin boundary of services/settings/backup.ts is dep-injected,
 * so the suites run the real orchestration code against fakes: the
 * picker/snapshot/writer pipeline, the manifest version gate, the
 * replace-mode swap ordering with its rollback-on-failure contract, and
 * the merge delegation (real mergeSnapshotInto over two real-schema
 * in-memory databases). Only the two imports the module does not inject
 * — flagAllAccountsForReauth and the account store — are mocked at the
 * module boundary.
 */

const coreHolder = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: coreHolder.invoke,
}))

const accountsHolder = vi.hoisted(() => ({
  flagAllAccountsForReauth: vi.fn(),
}))

vi.mock("../../db/accounts", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../db/accounts")
  >()
  return {
    ...actual,
    flagAllAccountsForReauth: accountsHolder.flagAllAccountsForReauth,
  }
})

const storeHolder = vi.hoisted(() => ({
  reload: vi.fn(),
}))

vi.mock("../../../stores/account-store", () => ({
  useAccountStore: {
    getState: () => ({ reload: storeHolder.reload }),
  },
}))

import {
  exportBackup,
  inspectBackupArchive,
  restoreBackup,
  UnsupportedManifestVersionError,
  type RestoreBackupDeps,
} from "../backup"
import { RestoreCancelledError } from "../backup-merge"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"

const SUMMARY = { accounts: 2, calendarSources: 1, carddavBooks: 0 }

const VERIFY_OK = {
  manifest: {
    version: 1,
    createdAt: "2026-10-04T00:00:00.000Z",
    appVersion: "0.1.0",
    summary: SUMMARY,
  },
  bytes: 42,
}

/** A throwaway executor fake for the queue-clear write. */
function fakeExecutor() {
  return {
    execute: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
    select: vi.fn().mockResolvedValue([]),
  }
}

beforeEach(() => {
  coreHolder.invoke.mockReset()
  accountsHolder.flagAllAccountsForReauth.mockReset()
  storeHolder.reload.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("exportBackup (task 5.1)", () => {
  it("snapshots, hands the manifest to the Rust writer, and cleans the temp file", async () => {
    const order: string[] = []
    const manifests: string[] = []

    const result = await exportBackup({
      pickDestination: async (suggested) => {
        expect(suggested).toMatch(/\.emailer-backup$/)
        order.push("pick")
        return "/tmp/dest.emailer-backup"
      },
      makeTempPath: async (filename) => `/tmp/${filename}`,
      createSnapshot: async (tempPath) => {
        order.push("snapshot")
        expect(tempPath).toMatch(/^\/tmp\/emailer-export-.+\.db$/)
        return SUMMARY
      },
      exportArchive: async (input) => {
        order.push("archive")
        manifests.push(input.manifestJson)
        expect(input.destPath).toBe("/tmp/dest.emailer-backup")
        return { path: input.destPath, bytes: 1234 }
      },
      removeFile: async (path) => {
        order.push("cleanup")
        expect(path).toMatch(/^\/tmp\/emailer-export-/)
      },
      nowIso: () => "2026-10-04T10:11:12.000Z",
    })

    expect(order).toEqual(["pick", "snapshot", "archive", "cleanup"])
    expect(result).toEqual({
      path: "/tmp/dest.emailer-backup",
      bytes: 1234,
      summary: SUMMARY,
    })
    // The manifest the Rust writer checksums carries the format version,
    // the timestamp, the app version and the strip summary (spec
    // "Export contents").
    const manifest = JSON.parse(manifests[0])
    expect(manifest).toEqual({
      version: 1,
      createdAt: "2026-10-04T10:11:12.000Z",
      appVersion: expect.any(String),
      summary: SUMMARY,
    })
  })

  it("returns null and touches nothing when the destination dialog is cancelled", async () => {
    const result = await exportBackup({
      pickDestination: async () => null,
      createSnapshot: async () => {
        throw new Error("must not run")
      },
      exportArchive: async () => {
        throw new Error("must not run")
      },
    })

    expect(result).toBeNull()
  })

  it("surfaces a typed failure and still removes the temp snapshot", async () => {
    const removeFile = vi.fn().mockResolvedValue(undefined)
    const makeTempPath = async (filename: string) => `/tmp/${filename}`

    // A dep throwing a raw object passes through verbatim.
    await expect(
      exportBackup({
        pickDestination: async () => "/tmp/dest.emailer-backup",
        makeTempPath,
        createSnapshot: async () => SUMMARY,
        exportArchive: async () => {
          throw { kind: "io", message: "destination unwritable" }
        },
        removeFile,
      })
    ).rejects.toEqual({ kind: "io", message: "destination unwritable" })

    // A dep throwing an Error passes through verbatim too — the
    // typed-error mapping is the default Rust path's job (next test).
    await expect(
      exportBackup({
        pickDestination: async () => "/tmp/dest.emailer-backup",
        makeTempPath,
        createSnapshot: async () => SUMMARY,
        exportArchive: async (): Promise<never> => {
          throw Object.assign(new Error("boom"), { kind: "corrupt_archive" })
        },
        removeFile,
      })
    ).rejects.toThrow("boom")

    // Both attempts cleaned their temp snapshot.
    expect(removeFile).toHaveBeenCalledTimes(2)
  })

  it("maps a rejected Rust command onto the typed error", async () => {
    coreHolder.invoke.mockRejectedValue({
      kind: "checksum_mismatch",
      message: "entry db.snapshot does not match its manifest checksum",
    })

    // No exportArchive dep: the default invoke-backed writer runs.
    await expect(
      exportBackup({
        pickDestination: async () => "/tmp/dest.emailer-backup",
        makeTempPath: async (filename) => `/tmp/${filename}`,
        createSnapshot: async () => SUMMARY,
        removeFile: async () => {},
      })
    ).rejects.toMatchObject({
      kind: "checksum_mismatch",
      name: "BackupError",
      message: "entry db.snapshot does not match its manifest checksum",
    })
    expect(coreHolder.invoke).toHaveBeenCalledWith("export_backup", {
      snapshotPath: expect.any(String),
      manifestJson: expect.any(String),
      destPath: "/tmp/dest.emailer-backup",
    })
  })

  it("cleans up when the snapshot step itself fails", async () => {
    const removeFile = vi.fn().mockResolvedValue(undefined)

    await expect(
      exportBackup({
        pickDestination: async () => "/tmp/dest.emailer-backup",
        makeTempPath: async (filename) => `/tmp/${filename}`,
        createSnapshot: async () => {
          throw new Error("vacuum failed")
        },
        exportArchive: async () => {
          throw new Error("must not run")
        },
        removeFile,
      })
    ).rejects.toThrow("vacuum failed")

    expect(removeFile).toHaveBeenCalledTimes(1)
  })
})

describe("inspectBackupArchive (tasks 5.2/5.5)", () => {
  it("returns the manifest facts of a supported archive", async () => {
    const verifyArchive = vi.fn().mockResolvedValue(VERIFY_OK)

    const info = await inspectBackupArchive("/tmp/a.emailer-backup", {
      verifyArchive,
    })

    expect(verifyArchive).toHaveBeenCalledWith("/tmp/a.emailer-backup")
    expect(info).toEqual({
      version: 1,
      createdAt: "2026-10-04T00:00:00.000Z",
      appVersion: "0.1.0",
      summary: SUMMARY,
    })
  })

  it("refuses a newer manifest version with the typed error", async () => {
    const promise = inspectBackupArchive("/tmp/a.emailer-backup", {
      verifyArchive: vi.fn().mockResolvedValue({
        ...VERIFY_OK,
        manifest: { ...VERIFY_OK.manifest, version: 99 },
      }),
    })

    await expect(promise).rejects.toBeInstanceOf(UnsupportedManifestVersionError)
    await promise.catch((error) => {
      expect(error.manifestVersion).toBe(99)
      expect(error.message).toContain("newer version")
    })
  })

  it("refuses a malformed version with the same typed error", async () => {
    await expect(
      inspectBackupArchive("/tmp/a.emailer-backup", {
        verifyArchive: vi.fn().mockResolvedValue({
          ...VERIFY_OK,
          manifest: { ...VERIFY_OK.manifest, version: "1" },
        }),
      })
    ).rejects.toBeInstanceOf(UnsupportedManifestVersionError)
  })

  it("propagates the verifier's typed errors untouched", async () => {
    await expect(
      inspectBackupArchive("/tmp/a.emailer-backup", {
        verifyArchive: vi.fn().mockRejectedValue({
          kind: "checksum_mismatch",
          message: "entry db.snapshot does not match its manifest checksum",
        }),
      })
    ).rejects.toMatchObject({ kind: "checksum_mismatch" })
  })
})

describe("restoreBackup replace mode (tasks 5.3/5.4)", () => {
  function replaceHarness(failAfterSwap?: () => void) {
    const order: string[] = []
    const executor = fakeExecutor()
    executor.execute.mockImplementation(async (sql: string) => {
      order.push(`sql:${sql}`)
      return { rowsAffected: 0 }
    })
    accountsHolder.flagAllAccountsForReauth.mockImplementation(
      async (passed: unknown) => {
        order.push("flag")
        expect(passed).toBe(executor)
        if (failAfterSwap) failAfterSwap()
        return 3
      }
    )
    storeHolder.reload.mockImplementation(async () => {
      order.push("reload")
    })

    const deps: RestoreBackupDeps = {
      verifyArchive: vi.fn(async () => {
        order.push("verify")
        return VERIFY_OK
      }),
      extractArchive: vi.fn(async () => {
        order.push("extract")
        return { snapshotPath: "/scratch/db.snapshot" }
      }),
      makeScratchDir: async () => "/scratch",
      removeDir: vi.fn(async (path: string) => {
        order.push(`cleanup:${path}`)
      }),
      closeDb: vi.fn(async () => {
        order.push("close")
      }),
      openDb: vi.fn(async () => {
        order.push("open")
      }),
      executor,
      replaceDatabase: vi.fn(async () => {
        order.push("swap")
      }),
      finalizeReplace: vi.fn(async (rollback: boolean) => {
        order.push(rollback ? "rollback" : "commit")
      }),
    }
    return { deps, order }
  }

  it("swaps, re-opens, flags re-auth, clears the queue, and commits in order", async () => {
    const { deps, order } = replaceHarness()

    const result = await restoreBackup("/a.emailer-backup", "replace", deps)

    expect(result).toEqual({ mode: "replace", accountsRequiringReauth: 3 })
    // Verification happens before ANY live mutation; the swap closes the
    // pool first and the commit lands only after the restored database
    // proved readable, migratable and writable. The scratch dir goes in
    // the outer finally.
    expect(order).toEqual([
      "verify",
      "extract",
      "close",
      "swap",
      "open",
      "flag",
      "sql:DELETE FROM pending_operations",
      "reload",
      "commit",
      "cleanup:/scratch",
    ])
    expect(storeHolder.reload).toHaveBeenCalledTimes(1)
  })

  it("rolls the pre-restore database back when a post-swap step fails", async () => {
    const { deps, order } = replaceHarness(() => {
      throw new Error("flag failed")
    })

    await expect(
      restoreBackup("/a.emailer-backup", "replace", deps)
    ).rejects.toThrow("flag failed")

    // The swap was undone and the rolled-back database re-opened; the
    // scratch cleanup is the outer finally, after the rollback.
    expect(order).toEqual([
      "verify",
      "extract",
      "close",
      "swap",
      "open",
      "flag",
      "rollback",
      "open",
      "cleanup:/scratch",
    ])
    // The success commit never ran.
    expect(order).not.toContain("commit")
  })

  it("aborts before any live mutation when verification rejects the archive", async () => {
    const { deps, order } = replaceHarness()
    ;(deps.verifyArchive as ReturnType<typeof vi.fn>).mockRejectedValue({
      kind: "checksum_mismatch",
      message: "tampered",
    })

    await expect(
      restoreBackup("/a.emailer-backup", "replace", deps)
    ).rejects.toMatchObject({ kind: "checksum_mismatch" })

    // The gate fires before the scratch dir even exists — the database
    // was never closed, swapped or flagged.
    expect(order).toEqual([])
    expect(deps.removeDir).not.toHaveBeenCalled()
  })
})

describe("restoreBackup merge mode (task 5.3)", () => {
  let live: TestExecutor
  let snapshot: TestExecutor

  beforeEach(() => {
    live = createTestExecutor()
    snapshot = createTestExecutor()
  })

  afterEach(() => {
    live.close()
    snapshot.close()
  })

  function mergeHarness(signal?: { aborted: boolean }) {
    const close = vi.fn(async () => {})
    const deps: RestoreBackupDeps = {
      verifyArchive: vi.fn().mockResolvedValue(VERIFY_OK),
      extractArchive: vi.fn(async () => ({
        snapshotPath: "/scratch/db.snapshot",
      })),
      makeScratchDir: async () => "/scratch",
      removeDir: vi.fn(async () => {}),
      executor: live,
      loadSnapshot: vi.fn(async () => ({
        executor: snapshot,
        close,
      })),
      signal,
    }
    return { deps, close }
  }

  it("imports the snapshot through a second connection and reports the summary", async () => {
    await snapshot.execute(
      "INSERT INTO snippets (id, name, body, created_at) VALUES ('s1', 'Restored snippet', 'Hello', 1700000000)"
    )
    await snapshot.execute(
      "INSERT INTO accounts (id, type, email, created_at) VALUES ('a1', 'gmail', 'restored@example.com', 1700000000)"
    )

    const { deps, close } = mergeHarness()

    const result = await restoreBackup("/a.emailer-backup", "merge", deps)

    expect(result).toEqual({
      mode: "merge",
      summary: {
        accountsAdded: 1,
        accountsKept: 0,
        profilesAdded: 0,
        settingsAdded: 0,
        rulesAdded: 0,
        snippetsAdded: 1,
        savedSearchesAdded: 0,
        senderCategoriesAdded: 0,
      },
    })
    // The merged account landed in the needs-reauth state (task 5.4).
    const account = await live.select<{ status: string }>(
      "SELECT status FROM accounts"
    )
    expect(account[0].status).toBe("auth-error")
    // The snapshot connection is closed and the scratch dir cleaned.
    expect(close).toHaveBeenCalledTimes(1)
    expect(deps.removeDir).toHaveBeenCalledWith("/scratch")
    expect(storeHolder.reload).toHaveBeenCalledTimes(1)
  })

  it("cancels mid-merge with the live data untouched and the snapshot closed", async () => {
    const signal = { aborted: true }
    const { deps, close } = mergeHarness(signal)

    await expect(
      restoreBackup("/a.emailer-backup", "merge", deps)
    ).rejects.toBeInstanceOf(RestoreCancelledError)

    // Nothing was merged, the connection closed, the scratch cleaned.
    expect(await live.select("SELECT * FROM snippets")).toEqual([])
    expect(close).toHaveBeenCalledTimes(1)
    expect(deps.removeDir).toHaveBeenCalledWith("/scratch")
    expect(storeHolder.reload).not.toHaveBeenCalled()
  })

  it("aborts before loading anything when verification rejects the archive", async () => {
    const { deps } = mergeHarness()
    ;(deps.verifyArchive as ReturnType<typeof vi.fn>).mockRejectedValue({
      kind: "corrupt_archive",
      message: "not a readable tar+gz archive",
    })

    await expect(
      restoreBackup("/a.emailer-backup", "merge", deps)
    ).rejects.toMatchObject({ kind: "corrupt_archive" })

    expect(deps.loadSnapshot).not.toHaveBeenCalled()
    expect(storeHolder.reload).not.toHaveBeenCalled()
  })
})
