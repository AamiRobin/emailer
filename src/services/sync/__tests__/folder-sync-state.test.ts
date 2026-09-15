import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import {
  deleteFolderSyncState,
  getFolderSyncState,
  listFolderSyncStates,
  upsertFolderSyncState,
} from "../folder-sync-state"

describe("folder_sync_state query layer", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "imap")
  })

  afterEach(() => {
    executor.close()
  })

  it("starts empty and upserts one cursor per (account, folder)", async () => {
    expect(await getFolderSyncState(executor, accountId, "INBOX")).toBeNull()
    expect(await listFolderSyncStates(executor, accountId)).toEqual([])

    await upsertFolderSyncState(executor, {
      accountId,
      folderName: "INBOX",
      uidvalidity: 42,
      lastSeenUid: 7,
    })

    const stored = await getFolderSyncState(executor, accountId, "INBOX")
    expect(stored).toMatchObject({
      account_id: accountId,
      folder_name: "INBOX",
      uidvalidity: 42,
      last_seen_uid: 7,
      highest_modseq: null,
    })
    expect(typeof stored?.last_sync_at).toBe("number")
    expect(typeof stored?.id).toBe("string")

    // same key updates in place instead of duplicating the row
    await upsertFolderSyncState(executor, {
      accountId,
      folderName: "INBOX",
      uidvalidity: 43,
      lastSeenUid: 9,
      highestModseq: 1234,
    })
    const updated = await getFolderSyncState(executor, accountId, "INBOX")
    expect(updated).toMatchObject({
      id: stored?.id,
      uidvalidity: 43,
      last_seen_uid: 9,
      highest_modseq: 1234,
    })
    expect(await listFolderSyncStates(executor, accountId)).toHaveLength(1)
  })

  it("keys cursors per account and lists them ordered by folder", async () => {
    const otherAccount = await createAccount(executor, "imap")
    await upsertFolderSyncState(executor, {
      accountId,
      folderName: "Sent",
      lastSeenUid: 1,
    })
    await upsertFolderSyncState(executor, {
      accountId,
      folderName: "Archive",
      lastSeenUid: 2,
    })
    await upsertFolderSyncState(executor, {
      accountId: otherAccount,
      folderName: "Sent",
      lastSeenUid: 3,
    })

    const mine = await listFolderSyncStates(executor, accountId)
    expect(mine.map((row) => row.folder_name)).toEqual(["Archive", "Sent"])
    expect(
      (await getFolderSyncState(executor, accountId, "Sent"))?.last_seen_uid
    ).toBe(1)
    expect(
      (await getFolderSyncState(executor, otherAccount, "Sent"))?.last_seen_uid
    ).toBe(3)

    await deleteFolderSyncState(executor, accountId, "Sent")
    expect(await getFolderSyncState(executor, accountId, "Sent")).toBeNull()
    expect(await listFolderSyncStates(executor, otherAccount)).toHaveLength(1)
  })
})
