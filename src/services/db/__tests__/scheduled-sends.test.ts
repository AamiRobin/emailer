import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "./fixtures"
import {
  cancelScheduledSend,
  createScheduledSend,
  getScheduledSend,
  listScheduledSends,
  parseScheduledRecipients,
  replaceScheduledSendPayload,
  updateScheduledSendDue,
} from "../scheduled-sends"
import { createTestExecutor, type TestExecutor } from "./test-executor"

describe("scheduled_sends queries", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor)
  })

  afterEach(() => {
    executor.close()
  })

  const input = (overrides?: {
    accountId?: string
    mimePayload?: string
    recipients?: { name?: string; email: string }[]
    subject?: string
    dueAt?: number
  }) => ({
    accountId: overrides?.accountId ?? accountId,
    mimePayload:
      overrides?.mimePayload ??
      "MIME-Version: 1.0\r\nSubject: test\r\n\r\nbody",
    recipients: overrides?.recipients ?? [{ email: "ada@example.com" }],
    subject: overrides?.subject,
    dueAt: overrides?.dueAt ?? 1_800_000_000,
  })

  it("stores the built payload, recipients JSON, subject and due time", async () => {
    const id = await createScheduledSend(
      executor,
      input({
        recipients: [
          { name: "Ada Lovelace", email: "ada@example.com" },
          { email: "bob@example.com" },
        ],
        subject: "Quarterly report",
        dueAt: 1_800_000_100,
      })
    )

    const row = await getScheduledSend(executor, id)
    expect(row).toMatchObject({
      id,
      account_id: accountId,
      status: "scheduled",
      subject: "Quarterly report",
      due_at: 1_800_000_100,
      last_error: null,
      sent_at: null,
    })
    expect(row?.mime_payload).toContain("Subject: test")
    expect(parseScheduledRecipients(row?.recipients_json ?? "")).toEqual([
      { name: "Ada Lovelace", email: "ada@example.com" },
      { email: "bob@example.com" },
    ])
    expect(typeof row?.created_at).toBe("number")
  })

  it("stores NULL for an omitted or blank subject", async () => {
    await createScheduledSend(executor, input())
    await createScheduledSend(executor, input({ subject: "   " }))

    const rows = await listScheduledSends(executor)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.subject).toBeNull()
    expect(rows[1]!.subject).toBeNull()
  })

  it("lists pending sends by due time ascending across accounts", async () => {
    const other = await createAccount(executor, "imap")
    await createScheduledSend(executor, input({ dueAt: 1_800_000_200 }))
    await createScheduledSend(executor, input({ dueAt: 1_800_000_100 }))
    await createScheduledSend(
      executor,
      input({ dueAt: 1_800_000_300, accountId: other })
    )

    expect(
      (await listScheduledSends(executor)).map((row) => row.due_at)
    ).toEqual([1_800_000_100, 1_800_000_200, 1_800_000_300])

    // Account filter: only that account's jobs, still due-ascending.
    expect(
      (await listScheduledSends(executor, other)).map((row) => row.due_at)
    ).toEqual([1_800_000_300])
  })

  it("excludes cancelled rows and includes history only on request", async () => {
    const first = await createScheduledSend(
      executor,
      input({ dueAt: 1_800_000_100 })
    )
    await createScheduledSend(executor, input({ dueAt: 1_800_000_200 }))

    await cancelScheduledSend(executor, first)
    expect((await listScheduledSends(executor)).map((r) => r.due_at)).toEqual([
      1_800_000_200,
    ])
    // Audit-only: the cancelled row is not in history either.
    expect(
      await listScheduledSends(executor, undefined, { includeHistory: true })
    ).toHaveLength(1)
    // The row itself survives, marked cancelled.
    expect((await getScheduledSend(executor, first))?.status).toBe("cancelled")
  })

  it("append sent/failed history (most recent first) with includeHistory", async () => {
    await executor.execute(
      `INSERT INTO scheduled_sends (id, account_id, mime_payload, recipients_json, due_at, status, sent_at)
       VALUES ('sent-1', $1, 'm', '[]', 1800000050, 'sent', 1800000060)`,
      [accountId]
    )
    await executor.execute(
      `INSERT INTO scheduled_sends (id, account_id, mime_payload, recipients_json, due_at, status, last_error)
       VALUES ('failed-1', $1, 'm', '[]', 1800000040, 'failed', 'smtp refused')`,
      [accountId]
    )
    await createScheduledSend(executor, input({ dueAt: 1_800_000_100 }))

    const rows = await listScheduledSends(executor, undefined, {
      includeHistory: true,
    })
    expect(rows.map((row) => row.id)).toEqual([
      expect.any(String), // the pending row, due first
      "sent-1", // history: most recent due first
      "failed-1",
    ])
    expect(rows[1]!.status).toBe("sent")
    expect(rows[1]!.sent_at).toBe(1_800_000_060)
    expect(rows[2]!.status).toBe("failed")
    expect(rows[2]!.last_error).toBe("smtp refused")
  })

  it("moves only a pending send's due time", async () => {
    const id = await createScheduledSend(executor, input())
    await updateScheduledSendDue(executor, id, 1_900_000_000)
    expect((await getScheduledSend(executor, id))?.due_at).toBe(1_900_000_000)

    // Unknown ids and non-scheduled rows are untouched.
    await updateScheduledSendDue(executor, "missing", 1)
    await cancelScheduledSend(executor, id)
    await updateScheduledSendDue(executor, id, 2)
    expect((await getScheduledSend(executor, id))?.due_at).toBe(1_900_000_000)
  })

  it("replaces a pending send's payload in place", async () => {
    const id = await createScheduledSend(executor, input({ subject: "old" }))
    await replaceScheduledSendPayload(executor, id, {
      mimePayload: "MIME-Version: 1.0\r\n\r\nnew body",
      recipients: [{ email: "new@example.com" }],
      subject: "new",
      dueAt: 1_950_000_000,
    })

    const row = await getScheduledSend(executor, id)
    expect(row).toMatchObject({
      mime_payload: "MIME-Version: 1.0\r\n\r\nnew body",
      subject: "new",
      due_at: 1_950_000_000,
      status: "scheduled",
    })
    expect(parseScheduledRecipients(row?.recipients_json ?? "")).toEqual([
      { email: "new@example.com" },
    ])

    // A cancelled row cannot be rewritten.
    await cancelScheduledSend(executor, id)
    await replaceScheduledSendPayload(executor, id, {
      mimePayload: "x",
      recipients: [],
      subject: "nope",
    })
    expect((await getScheduledSend(executor, id))?.mime_payload).toBe(
      "MIME-Version: 1.0\r\n\r\nnew body"
    )
  })

  it("deletes with the account (FK cascade) and parses bad recipients defensively", async () => {
    const other = await createAccount(executor, "imap")
    await createScheduledSend(executor, input({ accountId: other }))

    await executor.execute("DELETE FROM accounts WHERE id = $1", [other])
    expect(await listScheduledSends(executor)).toHaveLength(0)

    expect(parseScheduledRecipients("not json")).toEqual([])
    expect(parseScheduledRecipients('{"email":"x"}')).toEqual([])
    expect(
      parseScheduledRecipients('[{"email":"ok@example.com"},{"nope":1}]')
    ).toEqual([{ email: "ok@example.com" }])
  })
})
