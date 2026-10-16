import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * Merge-mode restore tests (task 5.3, data-portability spec "merge
 * behaviors"). Two real-schema in-memory databases (the shared test
 * executor) stand in for the LIVE database and the extracted SNAPSHOT,
 * so mergeSnapshotInto runs its exact shipped SQL: natural-key matching,
 * id regeneration on collision, accounts by email, the settings
 * signature remap, the single-transaction rollback on cancel/failure,
 * and the untouched message store.
 */

import {
  mergeSnapshotInto,
  RestoreCancelledError,
  type MergeSummary,
} from "../backup-merge"
import { createThread, createMessage, at } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"

const SEALED = JSON.stringify({ v: 1, ct: "ciphertext" })

describe("mergeSnapshotInto (task 5.3)", () => {
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

  /** An account row in the SNAPSHOT shaped like a stripped export: no
   * credentials, this machine's cursors present (they must not travel). */
  async function seedSnapshotAccount(options: {
    id: string
    email: string
    profileId?: string
  }): Promise<void> {
    await snapshot.execute(
      `INSERT INTO accounts (
         id, type, email, display_name, imap_host, imap_port, imap_security,
         smtp_host, smtp_port, smtp_security, oauth_scope, oauth_client_id,
         gmail_history_id, labels_synced_at, last_sync_at, credentials_json,
         history_window, created_at
       ) VALUES ($1, 'gmail', $2, 'Snapshot Account', 'imap.example.com',
                 993, 'tls', 'smtp.example.com', 465, 'tls', 'scope1', 'client1',
                 'cursor-99', 12345, 67890, $3, '3m', 1700000000)`,
      [options.id, options.email, SEALED]
    )
    if (options.profileId) {
      await snapshot.execute(
        "INSERT INTO account_profiles (id, name, color, created_at) VALUES ($1, 'Work', '#8b5cf6', 1700000000)",
        [options.profileId]
      )
      await snapshot.execute(
        "UPDATE accounts SET profile_id = $2 WHERE id = $1",
        [options.id, options.profileId]
      )
    }
  }

  async function counts(
    executor: TestExecutor,
    table: string
  ): Promise<number> {
    const rows = await executor.select<{ n: number }>(
      `SELECT count(*) AS n FROM ${table}`
    )
    return rows[0].n
  }

  it("imports non-conflicting rows and regenerates ids on collision", async () => {
    await seedSnapshotAccount({ id: "snap-acc", email: "new@example.com" })
    // A profile rides along so its insertion + the account's FK link are
    // exercised in the same pass.
    await snapshot.execute(
      "INSERT INTO account_profiles (id, name, color, created_at) VALUES ('shared-id', 'Work', '#8b5cf6', 1700000000)"
    )
    await snapshot.execute(
      "UPDATE accounts SET profile_id = 'shared-id' WHERE id = 'snap-acc'"
    )
    // The snapshot's rows ALL carry the id the live database already
    // gave another row of the same table — every insert must get a
    // fresh id, never fail.
    await snapshot.execute(
      "INSERT INTO snippets (id, name, body, created_at) VALUES ('shared-id', 'Snapshot snippet', 'Hello', 1700000000)"
    )
    await snapshot.execute(
      "INSERT INTO saved_searches (id, name, query, position, created_at) VALUES ('shared-id', 'From snapshot', 'is:unread', 0, 1700000000)"
    )
    await snapshot.execute(
      "INSERT INTO rules (id, account_id, name, criteria_json, actions_json, position, created_at) VALUES ('shared-id', 'snap-acc', 'From snapshot', '{}', '{}', 0, 1700000000)"
    )
    await snapshot.execute(
      "INSERT INTO settings (key, value, updated_at) VALUES ('organization.quickSteps', '[]', 1700000000)"
    )
    await snapshot.execute(
      "INSERT INTO sender_categories (sender_key, category, source, updated_at) VALUES ('news@list.example', 'newsletters', 'user', 1700000000)"
    )

    // The live database pre-owns the colliding ids (different rows).
    await live.execute(
      "INSERT INTO accounts (id, type, email) VALUES ('local-acc', 'imap', 'local@example.com')"
    )
    await live.execute(
      "INSERT INTO snippets (id, name, body, created_at) VALUES ('shared-id', 'Local snippet', 'Hi', 1700000000)"
    )

    const summary = await mergeSnapshotInto(live, snapshot)

    expect(summary).toEqual({
      accountsAdded: 1,
      accountsKept: 0,
      profilesAdded: 1,
      settingsAdded: 1,
      rulesAdded: 1,
      snippetsAdded: 1,
      savedSearchesAdded: 1,
      senderCategoriesAdded: 1,
    } satisfies MergeSummary)

    // The colliding snippet kept its local body; the snapshot's arrived
    // under a NEW id.
    const snippets = await live.select<{ id: string; name: string }>(
      "SELECT id, name FROM snippets ORDER BY name"
    )
    expect(snippets.map((row) => row.name)).toEqual([
      "Local snippet",
      "Snapshot snippet",
    ])
    const mergedSnippet = snippets.find((row) => row.name === "Snapshot snippet")
    expect(mergedSnippet?.id).not.toBe("shared-id")

    // The local account row survived untouched.
    expect(await counts(live, "accounts")).toBe(2)
    // The rule's account FK resolved to the INSERTED account's new id.
    const rule = (
      await live.select<{ account_id: string }>("SELECT account_id FROM rules")
    )[0]
    const inserted = await live.select<{ id: string }>(
      "SELECT id FROM accounts WHERE email = 'new@example.com'"
    )
    expect(rule.account_id).toBe(inserted[0].id)
  })

  it("matches accounts by email, keeps the local row, and remaps the rule's account", async () => {
    await live.execute(
      "INSERT INTO accounts (id, type, email) VALUES ('live-acc', 'gmail', 'shared@example.com')"
    )
    // Same email on both sides, different machine-local ids.
    await seedSnapshotAccount({ id: "snap-acc", email: "shared@example.com" })
    await snapshot.execute(
      "INSERT INTO rules (id, account_id, name, criteria_json, actions_json, position, created_at) VALUES ('snap-rule', 'snap-acc', 'Shared rule', '{}', '{}', 0, 1700000000)"
    )

    const summary = await mergeSnapshotInto(live, snapshot)

    expect(summary.accountsAdded).toBe(0)
    expect(summary.accountsKept).toBe(1)
    expect(await counts(live, "accounts")).toBe(1)

    // The rule imported under the LIVE account id.
    const rule = (
      await live.select<{ account_id: string }>("SELECT account_id FROM rules")
    )[0]
    expect(rule.account_id).toBe("live-acc")

    // The local account kept its credentials; the snapshot's sealed
    // envelope never travels (the column is not even read).
    const local = await live.select<{ credentials_json: string | null }>(
      "SELECT credentials_json FROM accounts WHERE id = 'live-acc'"
    )
    expect(local[0].credentials_json).toBeNull()
  })

  it("lands inserted accounts in the needs-reauth state with reset sync cursors", async () => {
    await seedSnapshotAccount({ id: "snap-acc", email: "new@example.com" })

    await mergeSnapshotInto(live, snapshot)

    const account = (
      await live.select<{
        status: string
        credentials_json: string | null
        gmail_history_id: string | null
        labels_synced_at: number | null
        last_sync_at: number | null
        history_window: string | null
      }>("SELECT status, credentials_json, gmail_history_id, labels_synced_at, last_sync_at, history_window FROM accounts")
    )[0]
    // Needs-reauth state (task 5.4) — there is nothing to sign in with.
    expect(account.status).toBe("auth-error")
    // The other machine's credentials and sync cursors did not travel;
    // the first sync is a FULL download (merge module comment).
    expect(account.credentials_json).toBeNull()
    expect(account.gmail_history_id).toBeNull()
    expect(account.labels_synced_at).toBeNull()
    expect(account.last_sync_at).toBeNull()
    // User preferences DO travel.
    expect(account.history_window).toBe("3m")
  })

  it("remaps signature settings onto the live account id and skips orphans", async () => {
    await live.execute(
      "INSERT INTO accounts (id, type, email) VALUES ('live-acc', 'gmail', 'shared@example.com')"
    )
    await seedSnapshotAccount({ id: "snap-acc", email: "shared@example.com" })
    await snapshot.execute(
      `INSERT INTO settings (key, value, updated_at) VALUES
         ('signature:snap-acc', '"Snapshot signature"', 1700000000),
         ('signature:gone-acc', '"Orphan"', 1700000000),
         ('organization.quickSteps', '[]', 1700000000)`
    )
    // Local already has a quick-steps row: local wins, nothing inserted.
    await live.execute(
      "INSERT INTO settings (key, value, updated_at) VALUES ('organization.quickSteps', '[local]', 1700000000)"
    )

    const summary = await mergeSnapshotInto(live, snapshot)

    expect(summary.settingsAdded).toBe(1)
    const settings = await live.select<{ key: string; value: string }>(
      "SELECT key, value FROM settings ORDER BY key"
    )
    expect(settings).toEqual([
      // The snapshot's per-account signature landed under the LIVE id;
      // the orphan signature:gone-acc row was skipped.
      { key: "organization.quickSteps", value: "[local]" },
      { key: "signature:live-acc", value: '"Snapshot signature"' },
    ])
  })

  it("skips snapshot rows whose natural key already exists locally", async () => {
    await live.execute(
      "INSERT INTO accounts (id, type, email) VALUES ('live-acc', 'gmail', 'shared@example.com')"
    )
    await seedSnapshotAccount({ id: "snap-acc", email: "shared@example.com" })
    // Same rule name under the same account: local wins.
    await live.execute(
      `INSERT INTO rules (id, account_id, name, criteria_json, actions_json, position, created_at) VALUES ('local-rule', 'live-acc', 'Shared rule', '{"local": true}', '{}', 0, 1700000000)`
    )
    await snapshot.execute(
      `INSERT INTO rules (id, account_id, name, criteria_json, actions_json, position, created_at) VALUES ('snap-rule', 'snap-acc', 'Shared rule', '{"snapshot": true}', '{}', 0, 1700000000)`
    )
    await live.execute(
      "INSERT INTO sender_categories (sender_key, category, source, updated_at) VALUES ('news@list.example', 'newsletters', 'user', 1700000000)"
    )
    await snapshot.execute(
      "INSERT INTO sender_categories (sender_key, category, source, updated_at) VALUES ('news@list.example', 'promotions', 'user', 1700000001)"
    )

    const summary = await mergeSnapshotInto(live, snapshot)

    expect(summary.rulesAdded).toBe(0)
    expect(summary.senderCategoriesAdded).toBe(0)
    const rule = (
      await live.select<{ criteria_json: string }>("SELECT criteria_json FROM rules")
    )[0]
    expect(rule.criteria_json).toBe('{"local": true}')
    const override = (
      await live.select<{ category: string }>(
        "SELECT category FROM sender_categories"
      )
    )[0]
    expect(override.category).toBe("newsletters")
  })

  it("never merges the message database", async () => {
    await live.execute(
      "INSERT INTO accounts (id, type, email) VALUES ('live-acc', 'gmail', 'live@example.com')"
    )
    const liveThreadId = await createThread(live, "live-acc")
    await createMessage(live, {
      threadId: liveThreadId,
      accountId: "live-acc",
      date: at(1),
      subject: "Live message",
    })

    // The snapshot carries a whole other mailbox.
    await seedSnapshotAccount({ id: "snap-acc", email: "snap@example.com" })
    const snapThreadId = await createThread(snapshot, "snap-acc")
    await createMessage(snapshot, {
      threadId: snapThreadId,
      accountId: "snap-acc",
      date: at(2),
      subject: "Snapshot message",
    })

    await mergeSnapshotInto(live, snapshot)

    expect(await counts(live, "messages")).toBe(1)
    expect(await counts(live, "threads")).toBe(1)
    const subject = (
      await live.select<{ subject: string }>(
        "SELECT subject FROM messages"
      )
    )[0]
    expect(subject.subject).toBe("Live message")
  })

  it("rolls the whole merge back when the user cancels mid-merge", async () => {
    await seedSnapshotAccount({ id: "snap-acc", email: "new@example.com" })
    await snapshot.execute(
      "INSERT INTO account_profiles (id, name, color, created_at) VALUES ('snap-profile', 'Work', '#8b5cf6', 1700000000)"
    )

    // Abort after the first snapshot read: profiles were already
    // inserted when the cancel fires — only the transaction boundary
    // can keep the live database intact.
    const signal = { aborted: false }
    const originalSelect = snapshot.select.bind(snapshot)
    snapshot.select = async <T>(
      sql: string,
      params: unknown[] = []
    ): Promise<T[]> => {
      const rows = await originalSelect<T>(sql, params)
      signal.aborted = true
      return rows
    }

    await expect(
      mergeSnapshotInto(live, snapshot, { signal })
    ).rejects.toBeInstanceOf(RestoreCancelledError)

    // Byte-identical live state: the profile insert is gone.
    expect(await counts(live, "account_profiles")).toBe(0)
    expect(await counts(live, "accounts")).toBe(0)
  })

  it("rolls the whole merge back when a write fails mid-merge", async () => {
    await seedSnapshotAccount({ id: "snap-acc", email: "new@example.com" })

    // Fail the merge once it reaches the rules table.
    const originalSelect = snapshot.select.bind(snapshot)
    snapshot.select = async <T>(
      sql: string,
      params: unknown[] = []
    ): Promise<T[]> => {
      if (sql.includes("FROM rules")) {
        throw new Error("snapshot read failure")
      }
      return originalSelect<T>(sql, params)
    }

    await expect(mergeSnapshotInto(live, snapshot)).rejects.toThrow(
      "snapshot read failure"
    )
    expect(await counts(live, "accounts")).toBe(0)
  })
})
