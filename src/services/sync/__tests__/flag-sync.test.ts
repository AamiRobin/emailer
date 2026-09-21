import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createAccount,
  createMessage,
  createThread,
} from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { SqlExecutor } from "../../db/executor"
import type {
  ConnectionTestResult,
  DeltaSyncResult,
  EmailFolder,
  EmailProvider,
  FetchMessagesResult,
  FetchQuery,
  MessageFlags,
  SendEmailResult,
} from "../../email/types"
import { upsertFolderSyncState } from "../folder-sync-state"
import type { ImapFlagsChangedResult } from "../flag-sync"
import { reconcileAllFolderFlags, reconcileFolderFlags } from "../flag-sync"

// ---------------------------------------------------------------------------
// In-memory flag server: flags + mod-sequences without any body payloads
// ---------------------------------------------------------------------------

const NO_MESSAGES_ERROR =
  "no messages to fetch: provide a non-empty uidSet, or a non-zero `last` on a non-empty folder"

const CONDSTORE_UNAVAILABLE_ERROR =
  "server does not advertise CONDSTORE — changed-since flag sync unavailable"

interface FakeFlagMessage {
  uid: number
  flags: string[]
  /** Server mod-sequence of the last change to this message. */
  modseq: number
}

class FakeFlagFolder {
  uidValidity: number
  /** Server CONDSTORE mailbox mod-sequence (RFC 7162 HIGHESTMODSEQ). */
  highestModseq: number
  messages = new Map<number, FakeFlagMessage>()
  private nextUid = 1

  constructor(uidValidity: number, highestModseq = 1) {
    this.uidValidity = uidValidity
    this.highestModseq = highestModseq
  }

  insert(flags: string[]): number {
    const uid = this.nextUid
    this.nextUid += 1
    this.highestModseq += 1
    this.messages.set(uid, {
      uid,
      flags: [...flags],
      modseq: this.highestModseq,
    })
    return uid
  }

  /** Simulate another client changing a message's flags server-side. */
  changeFlags(uid: number, flags: string[]): void {
    const message = this.messages.get(uid)
    if (!message) throw new Error(`no such message uid ${uid}`)
    message.flags = [...flags]
    this.highestModseq += 1
    message.modseq = this.highestModseq
  }

  get uidNext(): number {
    let max = 0
    for (const uid of this.messages.keys()) max = Math.max(max, uid)
    return max + 1
  }
}

/**
 * EmailProvider fake exposing only the flags surface. `fetchMessages`
 * records and throws — the flag pass must never download bodies.
 */
class FakeFlagsProvider implements EmailProvider {
  readonly type = "imap" as const
  readonly accountId: string
  fetchMessageCalls: { folder: string; query: FetchQuery }[] = []
  fetchFlagCalls: { folder: string; query: FetchQuery }[] = []

  private readonly folders: Map<string, FakeFlagFolder>

  constructor(accountId: string, folders: Map<string, FakeFlagFolder>) {
    this.accountId = accountId
    this.folders = folders
  }

  async fetchMessages(): Promise<FetchMessagesResult> {
    throw new Error("fetchMessages must not be called by the flag pass")
  }

  async fetchFlags(folder: string, query: FetchQuery): Promise<MessageFlags[]> {
    this.fetchFlagCalls.push({ folder, query })
    const box = this.requireFolder(folder)
    if (
      query.uidSet === undefined &&
      (query.last === undefined || query.last <= 0 || box.uidNext <= 1)
    ) {
      throw new Error(NO_MESSAGES_ERROR)
    }
    const start =
      query.uidSet !== undefined
        ? 1
        : Math.max(1, box.uidNext - (query.last ?? 0))
    return [...box.messages.values()]
      .filter((message) => message.uid >= start)
      .map((message) => ({ uid: message.uid, flags: message.flags }))
  }

  async listFolders(): Promise<EmailFolder[]> {
    return []
  }

  async deltaSync(): Promise<DeltaSyncResult> {
    throw new Error("not implemented in fake")
  }
  async storeFlags(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async markRead(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async markStarred(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async addLabels(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async removeLabels(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async archive(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async trash(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async moveToFolder(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async deleteForever(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async getMessageSource(): Promise<string> {
    throw new Error("not implemented in fake")
  }
  async sendMessage(): Promise<SendEmailResult> {
    throw new Error("not implemented in fake")
  }
  async appendMessage(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async testConnection(): Promise<ConnectionTestResult> {
    return { success: true, message: "fake" }
  }

  private requireFolder(folder: string): FakeFlagFolder {
    const box = this.folders.get(folder)
    if (!box) throw new Error(`no such folder: ${folder}`)
    return box
  }
}

/**
 * CONDSTORE changed-since hook over the fake folders, mirroring the Rust
 * `imap_fetch_flags_changed` contract: errors when the folder is flagged
 * non-CONDSTORE, otherwise returns the flags of every message whose
 * mod-sequence is above `sinceModseq` plus the fresh HIGHESTMODSEQ.
 */
function createCondstoreHook(
  folders: Map<string, FakeFlagFolder>,
  condstoreEnabled: (folder: string) => boolean = () => true
): {
  calls: { folder: string; sinceModseq: number }[]
  fetchChanged: (
    folder: string,
    sinceModseq: number
  ) => Promise<ImapFlagsChangedResult>
} {
  const calls: { folder: string; sinceModseq: number }[] = []
  return {
    calls,
    fetchChanged: async (folder, sinceModseq) => {
      calls.push({ folder, sinceModseq })
      const box = folders.get(folder)
      if (!box) throw new Error(`no such folder: ${folder}`)
      if (!condstoreEnabled(folder)) {
        throw new Error(CONDSTORE_UNAVAILABLE_ERROR)
      }
      return {
        flags: [...box.messages.values()]
          .filter((message) => message.modseq > sinceModseq)
          .map((message) => ({ uid: message.uid, flags: message.flags })),
        folderStatus: {
          uidValidity: box.uidValidity,
          uidNext: box.uidNext,
          exists: box.messages.size,
          unseen: 0,
          highestModseq: box.highestModseq,
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  executor: TestExecutor
  accountId: string
  folders: Map<string, FakeFlagFolder>
  provider: FakeFlagsProvider
  addFolder(path: string, uidValidity: number): FakeFlagFolder
}

async function createHarness(): Promise<Harness> {
  const executor = createTestExecutor()
  const accountId = await createAccount(executor, "imap")
  const folders = new Map<string, FakeFlagFolder>()
  const provider = new FakeFlagsProvider(accountId, folders)
  function addFolder(path: string, uidValidity: number): FakeFlagFolder {
    const box = new FakeFlagFolder(uidValidity)
    folders.set(path, box)
    return box
  }
  return { executor, accountId, folders, provider, addFolder }
}

/** Persist a local message row (id auto-assigned like the fixtures). */
let localRowSequence = 0

async function seedLocalMessage(
  executor: SqlExecutor,
  accountId: string,
  folder: string,
  uid: number,
  flags: { isRead?: boolean; isFlagged?: boolean } = {}
): Promise<string> {
  const threadId = await createThread(executor, accountId, {})
  localRowSequence += 1
  await executor.execute(
    `INSERT INTO messages (id, thread_id, account_id, imap_folder, imap_uid, date, is_read, is_flagged)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      `msg-local-${localRowSequence}`,
      threadId,
      accountId,
      folder,
      uid,
      1000 + uid,
      flags.isRead ? 1 : 0,
      flags.isFlagged ? 1 : 0,
    ]
  )
  return threadId
}

interface LocalFlagRow {
  imap_uid: number
  is_read: number
  is_flagged: number
}

async function localFlags(
  harness: Harness,
  folder: string
): Promise<Map<number, LocalFlagRow>> {
  const rows = await harness.executor.select<LocalFlagRow>(
    `SELECT imap_uid, is_read, is_flagged FROM messages
     WHERE account_id = $1 AND imap_folder = $2 ORDER BY imap_uid ASC`,
    [harness.accountId, folder]
  )
  return new Map(rows.map((row) => [row.imap_uid, row]))
}

async function storedModseq(
  harness: Harness,
  folder: string
): Promise<number | null> {
  const rows = await harness.executor.select<{ highest_modseq: number | null }>(
    "SELECT highest_modseq FROM folder_sync_state WHERE account_id = $1 AND folder_name = $2",
    [harness.accountId, folder]
  )
  return rows[0]?.highest_modseq ?? null
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("flag reconciliation (task 4.7, D14)", () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await createHarness()
    localRowSequence = 0
  })

  afterEach(() => {
    harness.executor.close()
  })

  // ----- CONDSTORE path -----

  it("condstore: applies changed-since flags, advances the cursor, downloads no bodies", async () => {
    const inbox = harness.addFolder("INBOX", 100)
    inbox.insert([]) // uid 1
    inbox.insert([]) // uid 2
    await seedLocalMessage(harness.executor, harness.accountId, "INBOX", 1)
    await seedLocalMessage(harness.executor, harness.accountId, "INBOX", 2)
    await upsertFolderSyncState(harness.executor, {
      accountId: harness.accountId,
      folderName: "INBOX",
      uidvalidity: 100,
      lastSeenUid: 2,
      highestModseq: inbox.highestModseq,
    })

    // another client marks uid 1 as read and starred
    inbox.changeFlags(1, ["\\Seen", "\\Flagged"])

    const hook = createCondstoreHook(harness.folders)
    const outcome = await reconcileFolderFlags({
      executor: harness.executor,
      provider: harness.provider,
      accountId: harness.accountId,
      folder: "INBOX",
      lastSeenUid: 2,
      fetchFlagsChanged: hook.fetchChanged,
    })

    expect(outcome).toEqual({ folder: "INBOX", changes: 1, mode: "condstore" })
    expect(hook.calls).toEqual([{ folder: "INBOX", sinceModseq: 3 }])
    expect(harness.provider.fetchMessageCalls).toEqual([])
    expect(harness.provider.fetchFlagCalls).toEqual([])

    const flags = await localFlags(harness, "INBOX")
    expect(flags.get(1)).toMatchObject({ is_read: 1, is_flagged: 1 })
    expect(flags.get(2)).toMatchObject({ is_read: 0, is_flagged: 0 })

    // cursor advanced to the server's fresh HIGHESTMODSEQ
    expect(await storedModseq(harness, "INBOX")).toBe(inbox.highestModseq)
  })

  it("condstore: recomputes the unread cache of affected threads", async () => {
    const inbox = harness.addFolder("INBOX", 100)
    inbox.insert([])
    const accountId = harness.accountId
    const threadId = await createThread(harness.executor, accountId, {
      subject: "Hello",
    })
    await createMessage(harness.executor, {
      threadId,
      accountId,
      date: 1000,
      imapFolder: "INBOX",
      imapUid: 1,
    })
    await upsertFolderSyncState(harness.executor, {
      accountId,
      folderName: "INBOX",
      uidvalidity: 100,
      lastSeenUid: 1,
      highestModseq: inbox.highestModseq,
    })

    inbox.changeFlags(1, ["\\Seen"])
    const hook = createCondstoreHook(harness.folders)
    await reconcileFolderFlags({
      executor: harness.executor,
      provider: harness.provider,
      accountId,
      folder: "INBOX",
      lastSeenUid: 1,
      fetchFlagsChanged: hook.fetchChanged,
    })

    const threads = await harness.executor.select<{ unread_count: number }>(
      "SELECT unread_count FROM threads WHERE id = $1",
      [threadId]
    )
    expect(threads[0]?.unread_count).toBe(0)
  })

  it("condstore: bootstraps with CHANGEDSINCE 1 when no cursor is stored", async () => {
    const inbox = harness.addFolder("INBOX", 100)
    inbox.insert(["\\Seen"]) // uid 1, arrives already read
    await seedLocalMessage(harness.executor, harness.accountId, "INBOX", 1)
    await upsertFolderSyncState(harness.executor, {
      accountId: harness.accountId,
      folderName: "INBOX",
      uidvalidity: 100,
      lastSeenUid: 1,
      highestModseq: null,
    })

    const hook = createCondstoreHook(harness.folders)
    const outcome = await reconcileFolderFlags({
      executor: harness.executor,
      provider: harness.provider,
      accountId: harness.accountId,
      folder: "INBOX",
      lastSeenUid: 1,
      fetchFlagsChanged: hook.fetchChanged,
    })

    expect(outcome.mode).toBe("condstore")
    expect(hook.calls).toEqual([{ folder: "INBOX", sinceModseq: 1 }])
    expect((await localFlags(harness, "INBOX")).get(1)?.is_read).toBe(1)
    expect(await storedModseq(harness, "INBOX")).toBe(inbox.highestModseq)
  })

  it("condstore: messages above lastSeenUid are left to delta sync but still advance the cursor", async () => {
    const inbox = harness.addFolder("INBOX", 100)
    inbox.insert([]) // uid 1 — synced
    inbox.insert([]) // uid 2 — synced
    inbox.insert([]) // uid 3 — arrives after the delta pass
    await seedLocalMessage(harness.executor, harness.accountId, "INBOX", 1)
    await seedLocalMessage(harness.executor, harness.accountId, "INBOX", 2)
    await upsertFolderSyncState(harness.executor, {
      accountId: harness.accountId,
      folderName: "INBOX",
      uidvalidity: 100,
      lastSeenUid: 2,
      highestModseq: inbox.highestModseq,
    })
    inbox.changeFlags(3, ["\\Flagged"]) // new-message territory (uid > lastSeenUid)

    const hook = createCondstoreHook(harness.folders)
    const outcome = await reconcileFolderFlags({
      executor: harness.executor,
      provider: harness.provider,
      accountId: harness.accountId,
      folder: "INBOX",
      lastSeenUid: 2,
      fetchFlagsChanged: hook.fetchChanged,
    })

    expect(outcome).toEqual({ folder: "INBOX", changes: 0, mode: "condstore" })
    expect((await localFlags(harness, "INBOX")).size).toBe(2)
    expect(await storedModseq(harness, "INBOX")).toBe(inbox.highestModseq)
  })

  it("condstore: uidvalidity mismatch skips the folder without storing the cursor", async () => {
    const inbox = harness.addFolder("INBOX", 100)
    inbox.insert([])
    await seedLocalMessage(harness.executor, harness.accountId, "INBOX", 1)
    await upsertFolderSyncState(harness.executor, {
      accountId: harness.accountId,
      folderName: "INBOX",
      uidvalidity: 100,
      lastSeenUid: 1,
      highestModseq: inbox.highestModseq,
    })
    const storedCursor = inbox.highestModseq
    inbox.changeFlags(1, ["\\Seen"])

    // server rebuilt the mailbox under a new uidvalidity (uid space changed)
    const stale = harness.folders.get("INBOX")
    if (stale) stale.uidValidity = 999
    const hook = createCondstoreHook(harness.folders)
    const outcome = await reconcileFolderFlags({
      executor: harness.executor,
      provider: harness.provider,
      accountId: harness.accountId,
      folder: "INBOX",
      lastSeenUid: 1,
      fetchFlagsChanged: hook.fetchChanged,
    })

    expect(outcome).toEqual({ folder: "INBOX", changes: 0, mode: "skipped" })
    expect((await localFlags(harness, "INBOX")).get(1)?.is_read).toBe(0)
    expect(await storedModseq(harness, "INBOX")).toBe(storedCursor)
  })

  it("condstore: a server without CONDSTORE falls back to the window scan", async () => {
    const inbox = harness.addFolder("INBOX", 100)
    inbox.insert([]) // uid 1
    inbox.insert([]) // uid 2
    await seedLocalMessage(harness.executor, harness.accountId, "INBOX", 1)
    await seedLocalMessage(harness.executor, harness.accountId, "INBOX", 2)
    await upsertFolderSyncState(harness.executor, {
      accountId: harness.accountId,
      folderName: "INBOX",
      uidvalidity: 100,
      lastSeenUid: 2,
      highestModseq: inbox.highestModseq,
    })
    const storedCursor = inbox.highestModseq
    inbox.changeFlags(1, ["\\Flagged"])

    const hook = createCondstoreHook(harness.folders, () => false)
    const outcome = await reconcileFolderFlags({
      executor: harness.executor,
      provider: harness.provider,
      accountId: harness.accountId,
      folder: "INBOX",
      lastSeenUid: 2,
      fetchFlagsChanged: hook.fetchChanged,
    })

    expect(outcome).toEqual({ folder: "INBOX", changes: 1, mode: "window" })
    expect(hook.calls).toEqual([{ folder: "INBOX", sinceModseq: storedCursor }])
    expect(harness.provider.fetchFlagCalls).toEqual([
      { folder: "INBOX", query: { last: 500 } },
    ])
    expect(harness.provider.fetchMessageCalls).toEqual([])
    expect((await localFlags(harness, "INBOX")).get(1)?.is_flagged).toBe(1)
    // fallback never learns a mod-sequence; the old cursor is untouched
    expect(await storedModseq(harness, "INBOX")).toBe(storedCursor)
  })

  // ----- Fallback path (no hook wired) -----

  it("fallback: window scan updates read state of an old message without re-downloading", async () => {
    const inbox = harness.addFolder("INBOX", 100)
    inbox.insert([]) // uid 1
    inbox.insert([]) // uid 2
    inbox.insert([]) // uid 3
    await seedLocalMessage(harness.executor, harness.accountId, "INBOX", 1)
    await seedLocalMessage(harness.executor, harness.accountId, "INBOX", 2)
    await seedLocalMessage(harness.executor, harness.accountId, "INBOX", 3)
    await upsertFolderSyncState(harness.executor, {
      accountId: harness.accountId,
      folderName: "INBOX",
      uidvalidity: 100,
      lastSeenUid: 3,
      highestModseq: null,
    })
    inbox.changeFlags(1, ["\\Seen"])

    const outcome = await reconcileFolderFlags({
      executor: harness.executor,
      provider: harness.provider,
      accountId: harness.accountId,
      folder: "INBOX",
      lastSeenUid: 3,
    })

    expect(outcome).toEqual({ folder: "INBOX", changes: 1, mode: "window" })
    expect(harness.provider.fetchFlagCalls).toEqual([
      { folder: "INBOX", query: { last: 500 } },
    ])
    // the core guarantee: no bodies were fetched for the flag pass
    expect(harness.provider.fetchMessageCalls).toEqual([])
    expect((await localFlags(harness, "INBOX")).get(1)?.is_read).toBe(1)
  })

  it("fallback: never touches messages above lastSeenUid", async () => {
    const inbox = harness.addFolder("INBOX", 100)
    inbox.insert([]) // uid 1
    inbox.insert([]) // uid 2 — not yet delta-synced
    await seedLocalMessage(harness.executor, harness.accountId, "INBOX", 1)
    await upsertFolderSyncState(harness.executor, {
      accountId: harness.accountId,
      folderName: "INBOX",
      uidvalidity: 100,
      lastSeenUid: 1,
    })
    inbox.changeFlags(2, ["\\Seen"])

    const outcome = await reconcileFolderFlags({
      executor: harness.executor,
      provider: harness.provider,
      accountId: harness.accountId,
      folder: "INBOX",
      lastSeenUid: 1,
    })

    expect(outcome.changes).toBe(0)
    expect(await localFlags(harness, "INBOX").then((m) => m.size)).toBe(1)
  })

  it("fallback: an empty folder is a clean skip, not an error", async () => {
    harness.addFolder("SENT", 300)
    await upsertFolderSyncState(harness.executor, {
      accountId: harness.accountId,
      folderName: "SENT",
      uidvalidity: 300,
      lastSeenUid: 0,
    })

    const outcome = await reconcileFolderFlags({
      executor: harness.executor,
      provider: harness.provider,
      accountId: harness.accountId,
      folder: "SENT",
      lastSeenUid: 0,
    })

    expect(outcome).toEqual({ folder: "SENT", changes: 0, mode: "skipped" })
    expect(harness.provider.fetchFlagCalls).toEqual([])
  })

  // ----- Guards -----

  it("skips folders that never completed a sync", async () => {
    const outcome = await reconcileFolderFlags({
      executor: harness.executor,
      provider: harness.provider,
      accountId: harness.accountId,
      folder: "INBOX",
      lastSeenUid: 10,
    })
    expect(outcome.mode).toBe("skipped")
    expect(harness.provider.fetchFlagCalls).toEqual([])
  })

  // ----- Orchestrator -----

  it("reconcileAllFolderFlags: aggregates outcomes, collects errors, keeps other folders", async () => {
    const inbox = harness.addFolder("INBOX", 100)
    inbox.insert([])
    await seedLocalMessage(harness.executor, harness.accountId, "INBOX", 1)
    await upsertFolderSyncState(harness.executor, {
      accountId: harness.accountId,
      folderName: "INBOX",
      uidvalidity: 100,
      lastSeenUid: 1,
    })
    inbox.changeFlags(1, ["\\Flagged"])

    const archive = harness.addFolder("Archive", 200)
    archive.insert([])
    await upsertFolderSyncState(harness.executor, {
      accountId: harness.accountId,
      folderName: "Archive",
      uidvalidity: 200,
      lastSeenUid: 1,
    })
    // fail only this folder's flag fetch
    const original = harness.provider.fetchFlags.bind(harness.provider)
    harness.provider.fetchFlags = async (folder, query) => {
      if (folder === "Archive") throw new Error("connection reset by peer")
      return original(folder, query)
    }

    const summary = await reconcileAllFolderFlags({
      executor: harness.executor,
      provider: harness.provider,
      accountId: harness.accountId,
      folders: [
        {
          id: "x1",
          name: "INBOX",
          path: "INBOX",
          type: "system",
          specialUse: "inbox",
          delimiter: "/",
        },
        {
          id: "x2",
          name: "Archive",
          path: "Archive",
          type: "user",
          specialUse: null,
          delimiter: "/",
        },
      ],
    })

    expect(summary.foldersChecked).toBe(2)
    expect(summary.changes).toBe(1)
    expect(summary.errors).toEqual([
      "Archive: flag sync: connection reset by peer",
    ])
    expect(summary.outcomes).toEqual([
      { folder: "INBOX", changes: 1, mode: "window" },
    ])
    expect((await localFlags(harness, "INBOX")).get(1)?.is_flagged).toBe(1)
  })
})
