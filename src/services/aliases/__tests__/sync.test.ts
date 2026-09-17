import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { SqlExecutor } from "../../db/executor"
import { listAliases } from "../../db/aliases"
import { GMAIL_API_ROOT, createGmailClient } from "../../email/gmail-api"
import type { GmailSendAs } from "../../email/gmail-api"
import { createFetchMock } from "../../email/__tests__/gmail-fixtures"
import { syncGmailAliases } from "../sync"

/**
 * Task 16.1: Gmail SendAs → aliases reconciliation. The API is mocked at
 * the fetch layer (the gmail-api test conventions): a real client runs
 * over createFetchMock, so the endpoint path, auth header and response
 * parsing are exercised, and the reconcile SQL runs on node:sqlite.
 */

function clientFor(mock: ReturnType<typeof createFetchMock>) {
  return createGmailClient({
    accountId: "acc-g",
    getToken: async () => "at-1",
    fetchImpl: mock.fetch,
  })
}

function sendAs(
  overrides: Partial<GmailSendAs> & { sendAsEmail: string }
): GmailSendAs {
  return { isPrimary: false, verificationStatus: "accepted", ...overrides }
}

/** Seed a gmail-source alias row directly (the sync's own writer is under
 * test, so fixtures write through plain SQL). */
async function seedGmailAlias(
  executor: SqlExecutor,
  accountId: string,
  email: string,
  options?: { displayName?: string | null; isDefault?: boolean }
): Promise<string> {
  const id = crypto.randomUUID()
  await executor.execute(
    `INSERT INTO aliases (id, account_id, email, display_name, is_default, source)
     VALUES ($1, $2, $3, $4, $5, 'gmail')`,
    [
      id,
      accountId,
      email.toLowerCase(),
      options?.displayName ?? null,
      options?.isDefault ? 1 : 0,
    ]
  )
  return id
}

async function seedImapAlias(
  executor: SqlExecutor,
  accountId: string,
  email: string,
  options?: { isDefault?: boolean }
): Promise<string> {
  const id = crypto.randomUUID()
  await executor.execute(
    `INSERT INTO aliases (id, account_id, email, display_name, is_default, source)
     VALUES ($1, $2, $3, NULL, $4, 'imap')`,
    [id, accountId, email.toLowerCase(), options?.isDefault ? 1 : 0]
  )
  return id
}

describe("syncGmailAliases (task 16.1, design D10)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("requests GET settings/sendAs with Bearer auth and parses the list", async () => {
    const accountId = await createAccount(executor, "gmail")
    const mock = createFetchMock()
    mock.on("GET", /\/settings\/sendAs/, () => ({
      json: { sendAs: [sendAs({ sendAsEmail: "work@example.com" })] },
    }))

    const summary = await syncGmailAliases(executor, accountId, clientFor(mock))

    expect(mock.calls[0].method).toBe("GET")
    expect(mock.calls[0].url).toBe(`${GMAIL_API_ROOT}/settings/sendAs`)
    expect(mock.calls[0].headers.authorization).toBe("Bearer at-1")
    expect(summary).toEqual({ inserted: 1, updated: 0, removed: 0 })
  })

  it("inserts aliases, skipping the primary entry and unverified addresses", async () => {
    const accountId = await createAccount(executor, "gmail")
    const mock = createFetchMock()
    mock.on("GET", /\/settings\/sendAs/, () => ({
      json: {
        sendAs: [
          // The account's own address — the baseline identity, not an alias.
          sendAs({ sendAsEmail: "me@gmail.com", isPrimary: true }),
          sendAs({
            sendAsEmail: "Work@Example.com",
            displayName: "Work",
            isDefault: true,
          }),
          sendAs({
            sendAsEmail: "pending@example.com",
            verificationStatus: "pending",
          }),
        ],
      },
    }))

    const summary = await syncGmailAliases(executor, accountId, clientFor(mock))

    expect(summary).toEqual({ inserted: 1, updated: 0, removed: 0 })
    const rows = await listAliases(executor, accountId, "gmail")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      email: "work@example.com",
      display_name: "Work",
      is_default: 1,
      source: "gmail",
    })
  })

  it("updates changed display names/defaults and leaves unchanged rows alone", async () => {
    const accountId = await createAccount(executor, "gmail")
    const keptId = await seedGmailAlias(
      executor,
      accountId,
      "kept@example.com",
      {
        displayName: "Same",
      }
    )
    const movedId = await seedGmailAlias(
      executor,
      accountId,
      "moved@example.com",
      {
        displayName: "Old name",
      }
    )

    const mock = createFetchMock()
    mock.on("GET", /\/settings\/sendAs/, () => ({
      json: {
        sendAs: [
          sendAs({ sendAsEmail: "kept@example.com", displayName: "Same" }),
          sendAs({
            sendAsEmail: "moved@example.com",
            displayName: "New name",
            isDefault: true,
          }),
        ],
      },
    }))

    const summary = await syncGmailAliases(executor, accountId, clientFor(mock))

    expect(summary).toEqual({ inserted: 0, updated: 1, removed: 0 })
    const rows = await listAliases(executor, accountId, "gmail")
    expect(rows).toHaveLength(2)
    const kept = rows.find((row) => row.id === keptId)
    const moved = rows.find((row) => row.id === movedId)
    // The id (and created_at) survive an update.
    expect(kept).toMatchObject({ display_name: "Same", is_default: 0 })
    expect(moved).toMatchObject({
      display_name: "New name",
      is_default: 1,
    })
  })

  it("removes stale gmail rows and never touches imap rows", async () => {
    const accountId = await createAccount(executor, "gmail")
    await seedGmailAlias(executor, accountId, "stale@example.com")
    const keptId = await seedGmailAlias(executor, accountId, "kept@example.com")
    const imapId = await seedImapAlias(
      executor,
      accountId,
      "manual@example.com"
    )

    const mock = createFetchMock()
    mock.on("GET", /\/settings\/sendAs/, () => ({
      json: {
        sendAs: [sendAs({ sendAsEmail: "kept@example.com" })],
      },
    }))

    const summary = await syncGmailAliases(executor, accountId, clientFor(mock))

    expect(summary).toEqual({ inserted: 0, updated: 0, removed: 1 })
    const rows = await listAliases(executor, accountId)
    expect(rows.map((row) => row.id).sort()).toEqual([keptId, imapId].sort())
    expect(rows.find((row) => row.id === imapId)).toMatchObject({
      source: "imap",
      email: "manual@example.com",
    })
  })

  it("an empty API response removes every gmail row (imap rows survive)", async () => {
    const accountId = await createAccount(executor, "gmail")
    await seedGmailAlias(executor, accountId, "gone@example.com")
    await seedImapAlias(executor, accountId, "manual@example.com")
    const mock = createFetchMock()
    mock.on("GET", /\/settings\/sendAs/, () => ({ json: { sendAs: [] } }))

    const summary = await syncGmailAliases(executor, accountId, clientFor(mock))

    expect(summary).toEqual({ inserted: 0, updated: 0, removed: 1 })
    const rows = await listAliases(executor, accountId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.source).toBe("imap")
  })

  it("reconciling twice is idempotent", async () => {
    const accountId = await createAccount(executor, "gmail")
    const mock = createFetchMock()
    mock.on("GET", /\/settings\/sendAs/, () => ({
      json: {
        sendAs: [
          sendAs({ sendAsEmail: "a@example.com", displayName: "A" }),
          sendAs({
            sendAsEmail: "b@example.com",
            displayName: "B",
            isDefault: true,
          }),
        ],
      },
    }))

    const first = await syncGmailAliases(executor, accountId, clientFor(mock))
    const second = await syncGmailAliases(executor, accountId, clientFor(mock))

    expect(first).toEqual({ inserted: 2, updated: 0, removed: 0 })
    expect(second).toEqual({ inserted: 0, updated: 0, removed: 0 })
    expect(await listAliases(executor, accountId, "gmail")).toHaveLength(2)
  })

  it("a gmail default displaces a manual default (exactly one default survives)", async () => {
    // The per-row upsert writes the gmail isDefault without clearing
    // siblings — without the post-pass sweep the manual default would
    // coexist forever.
    const accountId = await createAccount(executor, "gmail")
    const manualId = await seedImapAlias(
      executor,
      accountId,
      "manual@example.com",
      { isDefault: true }
    )

    const mock = createFetchMock()
    mock.on("GET", /\/settings\/sendAs/, () => ({
      json: {
        sendAs: [sendAs({ sendAsEmail: "work@example.com", isDefault: true })],
      },
    }))

    const summary = await syncGmailAliases(executor, accountId, clientFor(mock))

    expect(summary).toEqual({ inserted: 1, updated: 0, removed: 0 })
    const rows = await listAliases(executor, accountId)
    const defaults = rows.filter((row) => row.is_default === 1)
    expect(defaults).toHaveLength(1)
    // The surviving default is the gmail alias, not the manual one.
    expect(defaults[0]?.id).not.toBe(manualId)
    expect(defaults[0]).toMatchObject({
      email: "work@example.com",
      source: "gmail",
    })
    expect(rows.find((row) => row.id === manualId)?.is_default).toBe(0)
  })

  it("keeps the manual default when the gmail sync sets no default", async () => {
    const accountId = await createAccount(executor, "gmail")
    const manualId = await seedImapAlias(
      executor,
      accountId,
      "manual@example.com",
      { isDefault: true }
    )

    const mock = createFetchMock()
    mock.on("GET", /\/settings\/sendAs/, () => ({
      json: { sendAs: [sendAs({ sendAsEmail: "work@example.com" })] },
    }))

    const summary = await syncGmailAliases(executor, accountId, clientFor(mock))

    expect(summary).toEqual({ inserted: 1, updated: 0, removed: 0 })
    const rows = await listAliases(executor, accountId)
    const defaults = rows.filter((row) => row.is_default === 1)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]?.id).toBe(manualId)
  })

  it("follows a two-page SendAs response without deleting page-2 aliases", async () => {
    const accountId = await createAccount(executor, "gmail")
    const mock = createFetchMock()
    mock.on("GET", /\/settings\/sendAs/, (request) => {
      if (request.url.includes("pageToken=")) {
        return {
          json: {
            sendAs: [sendAs({ sendAsEmail: "b@example.com", isDefault: true })],
          },
        }
      }
      return {
        json: {
          sendAs: [sendAs({ sendAsEmail: "a@example.com" })],
          nextPageToken: "page-2",
        },
      }
    })

    const summary = await syncGmailAliases(executor, accountId, clientFor(mock))

    // Both pages were fetched (the second via the server's token)…
    const sendAsCalls = mock.callsTo(/\/settings\/sendAs/)
    expect(sendAsCalls).toHaveLength(2)
    expect(sendAsCalls[1].url).toContain("pageToken=page-2")
    // …both pages' aliases were stored, and nothing was removed by the
    // stale sweep (a single-page read would have deleted page-2 rows).
    expect(summary).toEqual({ inserted: 2, updated: 0, removed: 0 })
    const rows = await listAliases(executor, accountId, "gmail")
    expect(rows.map((row) => row.email).sort()).toEqual([
      "a@example.com",
      "b@example.com",
    ])
    expect(
      rows.filter((row) => row.is_default === 1).map((row) => row.email)
    ).toEqual(["b@example.com"])
  })

  it("maps API failures through GmailApiError without touching the table", async () => {
    const accountId = await createAccount(executor, "gmail")
    await seedGmailAlias(executor, accountId, "kept@example.com")
    const mock = createFetchMock()
    mock.on("GET", /\/settings\/sendAs/, () => ({
      status: 403,
      json: {
        error: {
          code: 403,
          message: "Permission denied",
          errors: [{ reason: "forbidden" }],
        },
      },
    }))

    await expect(
      syncGmailAliases(executor, accountId, clientFor(mock))
    ).rejects.toMatchObject({ name: "GmailApiError", status: 403 })
    // The failed run changed nothing.
    expect(await listAliases(executor, accountId)).toHaveLength(1)
  })
})
