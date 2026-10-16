import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type {
  ConnectionTestResult,
  DeltaSyncResult,
  EmailFolder,
  EmailProvider,
  FetchMessagesResult,
  FetchQuery,
  MessageFlags,
  NormalizedMessage,
  SendEmailResult,
} from "../../email/types"
import { useOnlineStore } from "../../../stores/online-store"
import { shutdownQueueSystem } from "../index"
import { processQueue, resumeAccountOperations } from "../processor"
import type { ProcessQueueOptions } from "../processor"
import { enqueueHistoryBackfill, getQueuedOperation } from "../operation"
import { executeHistoryBackfill } from "../history-backfill"
import type { HistoryBackfillOperation } from "../operation"

/**
 * The `history_backfill` op's queue lifecycle (parity-round-3 task 3.3,
 * design D6): the payload freezes the widened range at enqueue time, the
 * processor replays it through the account type's sync driver, and a
 * pending row survives an app restart ("offline") to replay later. The
 * real dispatch runs against an imap fake — the one driver whose range
 * walk is fully engine-side — and proves fetch-only-the-range plus
 * idempotent convergence on a crash replay.
 */

/** Fixed boundary so range fixtures are exact (midnight-anchored not needed here). */
const SINCE = 1_760_000_000
const UNTIL = 1_768_000_000

interface FakeStored {
  uid: number
  date: number
  subject: string
}

/**
 * Minimal imap provider: one INBOX whose {last} / uidSet fetches mirror
 * the Rust contract (newest-first {last} windows, explicit UID pages) and
 * record every query. uids: 1 far below the range, 2–3 inside it, 4 above
 * the `until` side (already synced).
 */
class FakeRangeProvider implements EmailProvider {
  readonly type = "imap" as const
  readonly accountId: string
  calls: { folder: string; query: FetchQuery }[] = []
  private readonly stored: FakeStored[]

  constructor(accountId: string, since: number, until: number) {
    this.accountId = accountId
    this.stored = [
      { uid: 1, date: since - 3_000, subject: "Below range" },
      { uid: 2, date: since + 1_000, subject: "In range old" },
      { uid: 3, date: until - 1_000, subject: "In range new" },
      { uid: 4, date: until + 1_000, subject: "Already synced" },
    ]
  }

  async listFolders(): Promise<EmailFolder[]> {
    return [
      {
        id: "INBOX",
        name: "Inbox",
        path: "INBOX",
        type: "system",
        specialUse: "inbox",
        delimiter: "/",
      },
    ]
  }

  async deltaSync(): Promise<DeltaSyncResult> {
    throw new Error("unused in backfill tests")
  }

  async fetchMessages(
    folder: string,
    query: FetchQuery
  ): Promise<FetchMessagesResult> {
    this.calls.push({ folder, query })
    const all = [...this.stored].sort((a, b) => a.uid - b.uid)
    let selected: FakeStored[]
    if (query.uidSet !== undefined) {
      const [rawStart, rawEnd] = query.uidSet.split(":")
      const start = Number(rawStart)
      const end = rawEnd === undefined ? start : Number(rawEnd)
      selected = all.filter((m) => m.uid >= start && m.uid <= end)
    } else if (query.last !== undefined) {
      selected = all.slice(-query.last)
    } else {
      throw new Error("fetchMessages requires uidSet or last")
    }
    return {
      messages: selected.map((m) => this.toNormalized(m, folder)),
      folderStatus: {
        uidValidity: 7,
        uidNext: this.stored.length + 1,
        exists: all.length,
        unseen: 0,
      },
    }
  }

  private toNormalized(m: FakeStored, folder: string): NormalizedMessage {
    return {
      uid: m.uid,
      flags: ["\\Seen"],
      subject: m.subject,
      from: [{ email: "someone@example.com" }],
      to: [{ email: "me@example.com" }],
      cc: [],
      bcc: [],
      date: m.date,
      size: 100,
      attachments: [],
      folder,
    }
  }

  async fetchFlags(): Promise<MessageFlags[]> {
    return []
  }
  async storeFlags(): Promise<void> {}
  async markRead(): Promise<void> {}
  async markStarred(): Promise<void> {}
  async addLabels(): Promise<void> {}
  async removeLabels(): Promise<void> {}
  async archive(): Promise<void> {}
  async trash(): Promise<void> {}
  async moveToFolder(): Promise<void> {}
  async deleteForever(): Promise<void> {}
  async getMessageSource(): Promise<string> {
    return ""
  }
  async sendMessage(): Promise<SendEmailResult> {
    throw new Error("unused in backfill tests")
  }
  async appendMessage(): Promise<void> {}
  async testConnection(): Promise<ConnectionTestResult> {
    return { success: true, message: "fake" }
  }
}

describe("history_backfill queue replay", () => {
  let executor: TestExecutor
  let accountId: string
  let provider: FakeRangeProvider

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "imap")
    provider = new FakeRangeProvider(accountId, SINCE, UNTIL)
  })

  afterEach(() => {
    shutdownQueueSystem()
    resumeAccountOperations()
    useOnlineStore.getState().setOnline(true)
    executor.close()
  })

  function options(
    overrides: Partial<ProcessQueueOptions> = {}
  ): ProcessQueueOptions {
    return {
      executor,
      backoffBaseMs: 0,
      getProviderForTest: (id: string) => {
        expect(id).toBe(accountId)
        return provider
      },
      ...overrides,
    }
  }

  async function storedUids(): Promise<number[]> {
    const rows = await executor.select<{ imap_uid: number }>(
      "SELECT imap_uid FROM messages WHERE account_id = $1 ORDER BY imap_uid ASC",
      [accountId]
    )
    return rows.map((row) => row.imap_uid)
  }

  it("freezes the range in payload_json at enqueue time", async () => {
    await enqueueHistoryBackfill(executor, {
      accountId,
      since: SINCE,
      until: null, // widening to All
    })

    const op = await getQueuedOperation(executor, "missing")
    expect(op).toBeNull()

    const rows = await executor.select<{
      op_type: string
      payload_json: string
      status: string
    }>("SELECT op_type, payload_json, status FROM pending_operations")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.op_type).toBe("history_backfill")
    expect(rows[0]?.status).toBe("pending")
    // The frozen payload, verbatim — a restart/retry replays this exact
    // range, never a recomputed (moving) boundary.
    expect(JSON.parse(rows[0]?.payload_json ?? "{}")).toEqual({
      since: SINCE,
      until: null,
    })
  })

  it("replays through the processor and completes the row", async () => {
    const replayed: HistoryBackfillOperation[] = []
    await enqueueHistoryBackfill(executor, {
      accountId,
      since: SINCE,
      until: UNTIL,
    })

    const result = await processQueue(
      options({
        historyBackfillForTest: async (id, op) => {
          expect(id).toBe(accountId)
          replayed.push(op)
        },
      })
    )

    expect(result.succeeded).toBe(1)
    expect(replayed).toEqual([
      { accountId, kind: "history_backfill", since: SINCE, until: UNTIL },
    ])
    const statuses = await executor.select<{ status: string }>(
      "SELECT status FROM pending_operations"
    )
    expect(statuses.map((row) => row.status)).toEqual(["done"])
  })

  it("a pending op survives a restart (queued offline, replayed on a later boot)", async () => {
    const replayed: HistoryBackfillOperation[] = []
    await enqueueHistoryBackfill(executor, {
      accountId,
      since: SINCE,
      until: null,
    })

    // "Offline" app session: the queue cycle runs but skips everything.
    useOnlineStore.getState().setOnline(false)
    const offline = await processQueue(options())
    expect(offline.skippedOffline).toBe(true)

    // The next boot: online again, a FRESH cycle replays the pending row.
    useOnlineStore.getState().setOnline(true)
    const rebooted = await processQueue(
      options({
        historyBackfillForTest: async (_id, op) => {
          replayed.push(op)
        },
      })
    )
    expect(rebooted.succeeded).toBe(1)
    expect(replayed).toEqual([
      { accountId, kind: "history_backfill", since: SINCE, until: null },
    ])
  })

  it("the real dispatch fetches ONLY the frozen range and a crash replay converges", async () => {
    await enqueueHistoryBackfill(executor, {
      accountId,
      since: SINCE,
      until: UNTIL,
    })
    const op = await getQueuedOperation(
      executor,
      (
        await executor.select<{ id: string }>(
          "SELECT id FROM pending_operations"
        )
      )[0]!.id
    )
    if (op?.kind !== "history_backfill") throw new Error("expected the op")

    // First attempt dies mid-flight (the app quits): nothing replayed.
    // The retry after restart runs the REAL executor. It returns void —
    // the stored rows are the evidence:
    await executeHistoryBackfill(executor, accountId, provider, op)
    // The newest window covered every message in one batch (no UID
    // page-down); uids 2–3 landed, 1 (below `since`) and 4 (above
    // `until`) did not — the range is exact on both ends.
    expect(provider.calls).toEqual([{ folder: "INBOX", query: { last: 200 } }])
    expect(await storedUids()).toEqual([2, 3])

    // The op row is still pending at this point (a crash before markDone):
    // replaying the SAME frozen range re-upserts idempotently and converges.
    await executeHistoryBackfill(executor, accountId, provider, op)
    expect(await storedUids()).toEqual([2, 3])
  })

  it("an account deleted while queued is a silent no-op", async () => {
    await executor.execute("DELETE FROM accounts WHERE id = $1", [accountId])
    const op: HistoryBackfillOperation = {
      accountId,
      kind: "history_backfill",
      since: SINCE,
      until: null,
    }

    await executeHistoryBackfill(executor, accountId, provider, op)

    expect(provider.calls).toEqual([])
  })

  it("routes each account type to its driver (dispatch smoke)", async () => {
    // The dispatch table is per-type; imap is proven end-to-end above, so
    // here only the routing needs proving — a gmail row reaches the gmail
    // driver's provider calls, not the imap walk.
    await executor.execute("UPDATE accounts SET type = 'gmail' WHERE id = $1", [
      accountId,
    ])
    const gmailProvider = new FakeRangeProvider(accountId, SINCE, UNTIL)
    const op: HistoryBackfillOperation = {
      accountId,
      kind: "history_backfill",
      since: SINCE,
      until: UNTIL,
    }

    await executeHistoryBackfill(executor, accountId, gmailProvider, op)

    // backfillGmailHistory enumerates through the {last, since, until}
    // search-term window (no UID page-down) — a distinct call shape.
    expect(gmailProvider.calls).toEqual([
      { folder: "", query: { last: 500, since: SINCE, until: UNTIL } },
    ])
  })
})
