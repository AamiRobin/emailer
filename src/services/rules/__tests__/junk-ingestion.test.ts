import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createAccount,
  createImapFolderLabel,
  createMessage,
  createThread,
} from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { blockSender } from "../../db/blocked-senders"
import { countJunkTokens } from "../../db/junk-tokens"
import { setJunkFilterEnabledPreference } from "../../settings/preferences"
import {
  loadJunkFilterConfig,
  trainJunkDocument,
  type JunkFilterConfig,
} from "../../security/junk-filter"
import {
  applyJunkFiling,
  runIngestionRules,
  type IngestionEvent,
} from "../ingestion"

/**
 * The junk-filter consumer of the ingestion hook (task 18.10, design
 * D19): a preloaded config (imap-sync's once-per-pass load — the gmail
 * engine never passes one) turns high-confidence mail into a junkVerdict,
 * applyJunkFiling performs the markSpam placement WITHOUT training, and
 * everything else — untrained accounts, low posteriors, already-ruled
 * mail, missing spam folders — delivers normally. Runs against the real
 * schema; the spam placement is the same imap junk-folder move a user
 * mark-spam performs.
 */

const SPAM_BODY = "buy cheap pills now winner"
const HAM_BODY = "meeting notes from the project review"

describe("junk filter consumer", () => {
  let executor: TestExecutor
  let accountId: string
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "imap")
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    executor.close()
  })

  /** The D19 defaults live in the hook's gate, so reaching a verdict
   * through the REAL config path needs the full 50-document sample. */
  async function trainToAutoMove(body: string): Promise<JunkFilterConfig> {
    await createImapFolderLabel(executor, accountId, "Junk", "spam")
    for (let i = 0; i < 50; i += 1) {
      await trainJunkDocument(executor, accountId, body, true)
    }
    await setJunkFilterEnabledPreference(executor, accountId, true)
    const config = await loadJunkFilterConfig(executor, accountId)
    if (!config) throw new Error("junk config missing")
    return config
  }

  /** An inbox message row + its hook event (the event's messageRowId
   * must resolve to a stored row — classification reads body_text). */
  async function seedArrival(body: string) {
    const threadId = await createThread(executor, accountId, {
      subject: "Arrival",
    })
    const messageRowId = await createMessage(executor, {
      threadId,
      accountId,
      date: 1000,
      fromAddress: "news@x.com",
      subject: "Arrival",
      bodyText: body,
      imapFolder: "INBOX",
      imapUid: 7,
    })
    const event: IngestionEvent = {
      messageRowId,
      threadId,
      fromAddress: "news@x.com",
      fromName: null,
      toJson: null,
      ccJson: null,
      bccJson: null,
      subject: "Arrival",
      date: 1000,
      snippet: null,
      labelNames: ["INBOX"],
      isRead: false,
      isStarred: false,
      hasAttachments: false,
      threadHasUserMessage: false,
      isMailingList: false,
      headers: {},
      sizeEstimate: null,
    }
    return { threadId, messageRowId, event }
  }

  async function threadRow(threadId: string) {
    const rows = await executor.select<{
      is_spam: number
      folder_label_id: string | null
    }>("SELECT is_spam, folder_label_id FROM threads WHERE id = $1", [threadId])
    return rows[0]
  }

  async function pendingOps(): Promise<
    { op_type: string; payload_json: string }[]
  > {
    return executor.select(
      `SELECT op_type, payload_json FROM pending_operations
       WHERE account_id = $1 ORDER BY seq ASC`,
      [accountId]
    )
  }

  it("without a config nothing classifies (the gmail path)", async () => {
    const config = await trainToAutoMove(SPAM_BODY)
    const { event } = await seedArrival(SPAM_BODY)
    const tokensBefore = await countJunkTokens(executor, accountId)

    // No options.junk — exactly what gmail-sync's hook calls look like.
    const outcomes = await runIngestionRules(executor, accountId, [event])

    expect(outcomes[0]?.junkVerdict).toBeNull()
    expect(outcomes[0]?.suppressesNotification).toBe(false)
    await applyJunkFiling(executor, accountId, outcomes)
    expect(await pendingOps()).toEqual([])
    expect(await countJunkTokens(executor, accountId)).toBe(tokensBefore)
    expect(config.spamDocuments).toBe(50) // and the sample gate was met
  })

  it("high-confidence mail is auto-junked: verdict, suppression, spam placement", async () => {
    const config = await trainToAutoMove(SPAM_BODY)
    const { threadId, event } = await seedArrival(SPAM_BODY)

    const outcomes = await runIngestionRules(executor, accountId, [event], {
      junk: config,
    })
    await applyJunkFiling(executor, accountId, outcomes)

    const verdict = outcomes[0]?.junkVerdict
    expect(verdict).not.toBeNull()
    expect(verdict?.posterior).toBeGreaterThanOrEqual(0.95)
    expect(verdict?.spamDocuments).toBe(50)
    expect(outcomes[0]?.suppressesNotification).toBe(true) // junk never announces

    // The placement IS the user mark-spam move: junk folder, is_spam,
    // and the imap move op addressing the server-side location.
    expect(await threadRow(threadId)).toMatchObject({ is_spam: 1 })
    const ops = await pendingOps()
    expect(ops.map((op) => op.op_type)).toEqual(["move"])
    expect(JSON.parse(ops[0]?.payload_json ?? "{}")).toMatchObject({
      destinationFolder: "Junk",
      refs: [{ folder: "INBOX", uid: 7 }],
    })
    // D19: the auto-move NEVER trains — the store is exactly as trained.
    expect(await countJunkTokens(executor, accountId)).toBe(5)
  })

  it("below the posterior threshold mail delivers normally", async () => {
    const config = await trainToAutoMove(SPAM_BODY)
    const { threadId, event } = await seedArrival(HAM_BODY)

    const outcomes = await runIngestionRules(executor, accountId, [event], {
      junk: config,
    })
    await applyJunkFiling(executor, accountId, outcomes)

    expect(outcomes[0]?.junkVerdict).toBeNull()
    expect(outcomes[0]?.suppressesNotification).toBe(false)
    expect(await threadRow(threadId)).toMatchObject({ is_spam: 0 })
    expect(await pendingOps()).toEqual([])
  })

  it("below the training sample the verdict never fires (50-doc gate)", async () => {
    await createImapFolderLabel(executor, accountId, "Junk", "spam")
    for (let i = 0; i < 49; i += 1) {
      await trainJunkDocument(executor, accountId, SPAM_BODY, true)
    }
    await setJunkFilterEnabledPreference(executor, accountId, true)
    const config = await loadJunkFilterConfig(executor, accountId)
    if (!config) throw new Error("junk config missing")
    const { threadId, event } = await seedArrival(SPAM_BODY)

    const outcomes = await runIngestionRules(executor, accountId, [event], {
      junk: config,
    })
    await applyJunkFiling(executor, accountId, outcomes)

    // Posterior would clear 0.95 — the missing document blocks the move.
    expect(config.spamDocuments).toBe(49)
    expect(outcomes[0]?.junkVerdict).toBeNull()
    expect(outcomes[0]?.suppressesNotification).toBe(false)
    expect(await threadRow(threadId)).toMatchObject({ is_spam: 0 })
  })

  it("already-ruled mail (blocked sender) is never re-classified", async () => {
    const config = await trainToAutoMove(SPAM_BODY)
    await blockSender(executor, accountId, {
      sender: "news@x.com",
      action: "trash",
    })
    const { event } = await seedArrival(SPAM_BODY)

    const outcomes = await runIngestionRules(executor, accountId, [event], {
      junk: config,
    })

    // The blocklist hit stands alone: one consumer decides, the junk
    // filter does not pile a second placement on top.
    expect(outcomes[0]?.blockedAction).toBe("trash")
    expect(outcomes[0]?.junkVerdict).toBeNull()
    expect(outcomes[0]?.suppressesNotification).toBe(true)
  })

  it("files once per thread and isolates a missing spam folder", async () => {
    const config = await trainToAutoMove(SPAM_BODY)
    const { threadId, event } = await seedArrival(SPAM_BODY)
    // A second spammy message of the SAME thread (another inbox arrival).
    const twinRowId = await createMessage(executor, {
      threadId,
      accountId,
      date: 1100,
      fromAddress: "news@x.com",
      subject: "Arrival again",
      bodyText: SPAM_BODY,
      imapFolder: "INBOX",
      imapUid: 8,
    })
    const twin = { ...event, messageRowId: twinRowId }

    // Two junked events on ONE thread: the placement is thread-level, so
    // the second filing is skipped. Then the same verdicts against an
    // account whose spam folder vanished degrade to a warning.
    const outcomes = await runIngestionRules(executor, accountId, [event], {
      junk: config,
    })
    const twinOutcomes = await runIngestionRules(executor, accountId, [twin], {
      junk: config,
    })
    expect(outcomes[0]?.junkVerdict).not.toBeNull()
    expect(twinOutcomes[0]?.junkVerdict).not.toBeNull()
    await applyJunkFiling(executor, accountId, [...outcomes, ...twinOutcomes])
    expect(await pendingOps()).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()

    // ON DELETE SET NULL drops the thread's folder cache — the spam-role
    // label row is gone either way.
    await executor.execute("DELETE FROM labels WHERE special_use = 'spam'", [])
    const refreshed = await runIngestionRules(executor, accountId, [event], {
      junk: config,
    })
    await applyJunkFiling(executor, accountId, refreshed)
    expect(warn).toHaveBeenCalled()
    expect(await threadRow(threadId)).toMatchObject({ is_spam: 1 }) // first filing stuck
    expect(await pendingOps()).toHaveLength(1) // no new op
  })
})
