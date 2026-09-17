import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  deleteContact,
  getContact,
  listAllContacts,
  listContactThreads,
  listContactsByAccount,
  recordContactInteraction,
  searchContactsRanked,
  updateContact,
  upsertContact,
} from "../contacts"
import { createTestExecutor, type TestExecutor } from "./test-executor"
import { at, createAccount, createMessage, createThread } from "./fixtures"

/** Ranking fixtures need explicit counts/recency, which the write API
 * derives from `now` — so these rows are seeded directly; the CRUD and
 * interaction suites below go through the query layer itself. */
async function seedContact(
  executor: TestExecutor,
  accountId: string,
  email: string,
  options?: {
    name?: string
    interactionCount?: number
    lastInteractionAt?: number
  }
): Promise<void> {
  await executor.execute(
    `INSERT INTO contacts (id, account_id, email, name, interaction_count,
       last_interaction_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      crypto.randomUUID(),
      accountId,
      email,
      options?.name ?? null,
      options?.interactionCount ?? 0,
      options?.lastInteractionAt ?? null,
    ]
  )
}

describe("contacts query module", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  describe("listContactsByAccount", () => {
    it("lists only the account's contacts, alphabetically", async () => {
      const accountId = await createAccount(executor)
      const otherId = await createAccount(executor)
      await upsertContact(executor, accountId, { email: "zoe@x.com" })
      await upsertContact(executor, accountId, {
        email: "amy@x.com",
        name: "Amy",
      })
      await upsertContact(executor, otherId, { email: "hidden@x.com" })

      const rows = await listContactsByAccount(executor, accountId)
      expect(rows.map((row) => row.email)).toEqual(["amy@x.com", "zoe@x.com"])
    })

    it("returns an empty list for an account without contacts", async () => {
      const accountId = await createAccount(executor)
      expect(await listContactsByAccount(executor, accountId)).toEqual([])
    })
  })

  describe("upsertContact", () => {
    it("inserts a new contact and is idempotent on re-apply", async () => {
      const accountId = await createAccount(executor)
      await upsertContact(executor, accountId, {
        email: "Bob@Example.com",
        name: "Bob",
      })
      await upsertContact(executor, accountId, {
        email: "bob@example.com",
        name: "Bob",
      })

      const rows = await listContactsByAccount(executor, accountId)
      expect(rows).toHaveLength(1)
      // normalized identity: one row for the case-insensitive same address
      expect(rows[0].email).toBe("bob@example.com")
      expect(rows[0].interaction_count).toBe(0)
    })

    it("fills a null name but never overwrites an existing one", async () => {
      const accountId = await createAccount(executor)
      await upsertContact(executor, accountId, { email: "carol@x.com" })
      await upsertContact(executor, accountId, {
        email: "carol@x.com",
        name: "Carol",
      })
      let rows = await listContactsByAccount(executor, accountId)
      expect(rows[0].name).toBe("Carol")

      // existing non-null name wins over a different incoming name
      await upsertContact(executor, accountId, {
        email: "carol@x.com",
        name: "Other",
      })
      rows = await listContactsByAccount(executor, accountId)
      expect(rows[0].name).toBe("Carol")
    })

    it("keeps the same account's contacts isolated", async () => {
      const accountId = await createAccount(executor)
      const otherId = await createAccount(executor)
      await upsertContact(executor, accountId, { email: "dan@x.com" })
      await upsertContact(executor, otherId, { email: "dan@x.com" })

      const rows = await listContactsByAccount(executor, accountId)
      expect(rows).toHaveLength(1)
    })
  })

  describe("recordContactInteraction", () => {
    it("starts new contacts at 1 and increments existing ones", async () => {
      const accountId = await createAccount(executor)
      await recordContactInteraction(executor, accountId, [
        { email: "erin@x.com" },
      ])
      await recordContactInteraction(executor, accountId, [
        { email: "erin@x.com", name: "Erin" },
      ])

      const rows = await listContactsByAccount(executor, accountId)
      expect(rows[0].interaction_count).toBe(2)
      expect(rows[0].last_interaction_at).not.toBeNull()
    })

    it("deduplicates the same address within one call", async () => {
      const accountId = await createAccount(executor)
      await recordContactInteraction(executor, accountId, [
        { email: "Frank@x.com", name: "Frank" },
        { email: "frank@x.com" }, // same person on To and Cc
      ])

      const rows = await listContactsByAccount(executor, accountId)
      expect(rows).toHaveLength(1)
      expect(rows[0].interaction_count).toBe(1)
    })

    it("counts each distinct address once per call", async () => {
      const accountId = await createAccount(executor)
      await recordContactInteraction(executor, accountId, [
        { email: "a@x.com" },
        { email: "b@x.com" },
      ])

      const rows = await listContactsByAccount(executor, accountId)
      expect(
        Object.fromEntries(
          rows.map((row) => [row.email, row.interaction_count])
        )
      ).toEqual({ "a@x.com": 1, "b@x.com": 1 })
    })

    it("ignores blank addresses", async () => {
      const accountId = await createAccount(executor)
      await recordContactInteraction(executor, accountId, [
        { email: "   " },
        { email: "" },
      ])
      expect(await listContactsByAccount(executor, accountId)).toEqual([])
    })

    it("applies the name fill policy on the interaction path too", async () => {
      const accountId = await createAccount(executor)
      await upsertContact(executor, accountId, {
        email: "grace@x.com",
        name: "Grace",
      })
      await recordContactInteraction(executor, accountId, [
        { email: "grace@x.com", name: "Overwrite" },
      ])
      let rows = await listContactsByAccount(executor, accountId)
      expect(rows[0].name).toBe("Grace")

      await upsertContact(executor, accountId, { email: "henry@x.com" })
      await recordContactInteraction(executor, accountId, [
        { email: "henry@x.com", name: "Henry" },
      ])
      rows = await listContactsByAccount(executor, accountId)
      expect(rows.find((row) => row.email === "henry@x.com")?.name).toBe(
        "Henry"
      )
    })
  })

  describe("searchContactsRanked", () => {
    it("ranks by interaction count before prefix priority", async () => {
      const accountId = await createAccount(executor)
      // high-frequency substring-only match beats a low-frequency prefix
      await seedContact(executor, accountId, "gal@x.com", {
        interactionCount: 10,
        lastInteractionAt: 100,
      })
      await seedContact(executor, accountId, "al@x.com", {
        interactionCount: 2,
        lastInteractionAt: 200,
      })

      const rows = await searchContactsRanked(executor, accountId, "al")
      expect(rows.map((row) => row.email)).toEqual(["gal@x.com", "al@x.com"])
    })

    it("ranks prefix matches ahead of substring matches at equal count", async () => {
      const accountId = await createAccount(executor)
      // both match "ti": tina as a prefix, martin only as a substring —
      // and martin is the MORE recent interaction, so the prefix rule
      // (not recency) must decide
      await seedContact(executor, accountId, "tina@x.com", {
        interactionCount: 3,
        lastInteractionAt: 100,
      })
      await seedContact(executor, accountId, "martin@x.com", {
        interactionCount: 3,
        lastInteractionAt: 300,
      })

      const rows = await searchContactsRanked(executor, accountId, "ti")
      expect(rows.map((row) => row.email)).toEqual([
        "tina@x.com",
        "martin@x.com",
      ])
    })

    it("breaks prefix ties by recency, then by email", async () => {
      const accountId = await createAccount(executor)
      await seedContact(executor, accountId, "old@x.com", {
        interactionCount: 4,
        lastInteractionAt: 100,
      })
      await seedContact(executor, accountId, "new@x.com", {
        interactionCount: 4,
        lastInteractionAt: 900,
      })

      let rows = await searchContactsRanked(executor, accountId, "@x.com")
      // both substring matches, equal counts — recency decides
      expect(rows.map((row) => row.email)).toEqual(["new@x.com", "old@x.com"])

      // full tie on count and recency: prefix ("old" starts with "o")
      // still outranks the substring match ("new" contains "o" in .com)
      await executor.execute(
        "UPDATE contacts SET last_interaction_at = 100 WHERE email = ?",
        ["old@x.com"]
      )
      rows = await searchContactsRanked(executor, accountId, "o")
      expect(rows.map((row) => row.email)).toEqual(["old@x.com", "new@x.com"])
    })

    it("matches against the name with the same prefix-first rule", async () => {
      const accountId = await createAccount(executor)
      // both match "ali": by name prefix vs by email substring only —
      // equal frequency, and the email-substring row is more recent
      await seedContact(executor, accountId, "secret@x.com", {
        name: "Alice Wonder",
        interactionCount: 5,
        lastInteractionAt: 100,
      })
      await seedContact(executor, accountId, "notalice@x.com", {
        interactionCount: 5,
        lastInteractionAt: 900,
      })

      const rows = await searchContactsRanked(executor, accountId, "ali")
      expect(rows.map((row) => row.email)).toEqual([
        "secret@x.com",
        "notalice@x.com",
      ])
    })

    it("matches case-insensitively", async () => {
      const accountId = await createAccount(executor)
      await seedContact(executor, accountId, "Mallory@x.com", {
        name: "EVE",
        interactionCount: 1,
      })

      const rows = await searchContactsRanked(executor, accountId, "EvE")
      expect(rows.map((row) => row.email)).toEqual(["Mallory@x.com"])
    })

    it("treats LIKE wildcards in the query as literal text", async () => {
      const accountId = await createAccount(executor)
      await seedContact(executor, accountId, "u_1@x.com", {
        interactionCount: 1,
      })
      await seedContact(executor, accountId, "ub1@x.com", {
        interactionCount: 1,
      })

      // `_` would match any character as a wildcard; escaped it only
      // matches the literal underscore
      const rows = await searchContactsRanked(executor, accountId, "u_1")
      expect(rows.map((row) => row.email)).toEqual(["u_1@x.com"])
    })

    it("returns top contacts by frequency for an empty query", async () => {
      const accountId = await createAccount(executor)
      await seedContact(executor, accountId, "low@x.com", {
        interactionCount: 1,
        lastInteractionAt: 900,
      })
      await seedContact(executor, accountId, "top@x.com", {
        interactionCount: 7,
        lastInteractionAt: 100,
      })
      await seedContact(executor, accountId, "idle@x.com", {
        interactionCount: 7,
        lastInteractionAt: 50,
      })

      const rows = await searchContactsRanked(executor, accountId, "")
      expect(rows.map((row) => row.email)).toEqual([
        "top@x.com",
        "idle@x.com",
        "low@x.com",
      ])
      // whitespace-only behaves like empty
      expect(
        (await searchContactsRanked(executor, accountId, "   ")).map(
          (row) => row.email
        )
      ).toEqual(["top@x.com", "idle@x.com", "low@x.com"])
    })

    it("honors the limit option (default 8)", async () => {
      const accountId = await createAccount(executor)
      for (let index = 0; index < 10; index += 1) {
        await seedContact(executor, accountId, `p${index}@x.com`, {
          interactionCount: index,
        })
      }

      expect(await searchContactsRanked(executor, accountId, "")).toHaveLength(
        8
      )
      expect(
        await searchContactsRanked(executor, accountId, "", { limit: 3 })
      ).toHaveLength(3)
    })

    it("never leaks another account's contacts", async () => {
      const accountId = await createAccount(executor)
      const otherId = await createAccount(executor)
      await seedContact(executor, accountId, "mine@x.com", {
        interactionCount: 1,
      })
      await seedContact(executor, otherId, "theirs@x.com", {
        interactionCount: 99,
      })

      const rows = await searchContactsRanked(executor, accountId, "theirs")
      expect(rows).toEqual([])
      expect(
        (await searchContactsRanked(executor, accountId, "")).map(
          (row) => row.email
        )
      ).toEqual(["mine@x.com"])
    })
  })

  describe("listAllContacts (task 20.2 browser)", () => {
    it("lists every contact across ALL accounts, most recent correspondence first", async () => {
      const accountId = await createAccount(executor)
      const otherId = await createAccount(executor)
      await seedContact(executor, accountId, "old@x.com", {
        name: "Old",
        interactionCount: 3,
        lastInteractionAt: 100,
      })
      await seedContact(executor, otherId, "recent@x.com", {
        name: "Recent",
        interactionCount: 1,
        lastInteractionAt: 900,
      })
      await seedContact(executor, accountId, "never@x.com", {
        name: "Never",
        interactionCount: 0,
        // undefined (not null): seedContact writes last_interaction_at as
        // NULL when the option is absent — the column has no null variant
        // in the fixture's option type.
        lastInteractionAt: undefined,
      })

      const rows = await listAllContacts(executor)
      // One cross-account list; never-contacted rows sort last (NULL is
      // smallest, so DESC recency puts them at the end).
      expect(rows.map((row) => row.email)).toEqual([
        "recent@x.com",
        "old@x.com",
        "never@x.com",
      ])
    })

    it("narrows by partial name or email, keeping the recency order", async () => {
      const accountId = await createAccount(executor)
      await seedContact(executor, accountId, "amy@x.com", {
        name: "Amy Chen",
        interactionCount: 1,
        lastInteractionAt: 100,
      })
      await seedContact(executor, accountId, "berto@x.com", {
        name: "Berto",
        interactionCount: 1,
        lastInteractionAt: 200,
      })

      // by partial name (case-insensitive)
      expect(
        (await listAllContacts(executor, { query: "chen" })).map(
          (row) => row.email
        )
      ).toEqual(["amy@x.com"])
      // by partial email
      expect(
        (await listAllContacts(executor, { query: "BERT" })).map(
          (row) => row.email
        )
      ).toEqual(["berto@x.com"])
      // no matches narrows to nothing; whitespace behaves like empty
      expect(await listAllContacts(executor, { query: "zzz" })).toEqual([])
      expect(
        (await listAllContacts(executor, { query: "   " })).map(
          (row) => row.email
        )
      ).toEqual(["berto@x.com", "amy@x.com"])
    })

    it("treats LIKE wildcards in the query as literal text", async () => {
      const accountId = await createAccount(executor)
      await seedContact(executor, accountId, "u_1@x.com", {
        interactionCount: 1,
      })
      await seedContact(executor, accountId, "ub1@x.com", {
        interactionCount: 1,
      })

      const rows = await listAllContacts(executor, { query: "u_1" })
      expect(rows.map((row) => row.email)).toEqual(["u_1@x.com"])
    })
  })

  describe("getContact (task 20.2)", () => {
    it("returns the row by id and null when it is gone", async () => {
      const accountId = await createAccount(executor)
      await upsertContact(executor, accountId, {
        email: "bob@x.com",
        name: "Bob",
      })
      const [row] = await listContactsByAccount(executor, accountId)

      const fetched = await getContact(executor, row.id)
      expect(fetched?.email).toBe("bob@x.com")
      expect(fetched?.notes).toBeNull()

      await deleteContact(executor, row.id)
      expect(await getContact(executor, row.id)).toBeNull()
    })
  })

  describe("updateContact (task 20.2 editing)", () => {
    it("renames explicitly and clears the name on an empty value", async () => {
      const accountId = await createAccount(executor)
      await upsertContact(executor, accountId, {
        email: "carol@x.com",
        name: "Carol",
      })
      const [row] = await listContactsByAccount(executor, accountId)

      await updateContact(executor, row.id, { name: "Carol M." })
      let rows = await listContactsByAccount(executor, accountId)
      expect(rows[0].name).toBe("Carol M.")

      await updateContact(executor, row.id, { name: "  " })
      rows = await listContactsByAccount(executor, accountId)
      expect(rows[0].name).toBeNull()
    })

    it("keeps an explicit rename against the upsert fill policy", async () => {
      const accountId = await createAccount(executor)
      await upsertContact(executor, accountId, {
        email: "dave@x.com",
        name: "Dave",
      })
      const [row] = await listContactsByAccount(executor, accountId)
      await updateContact(executor, row.id, { name: "Dave Renamed" })

      // Later correspondence carries the (stale) header name — the
      // explicit edit wins, matching the module's name policy.
      await upsertContact(executor, accountId, {
        email: "dave@x.com",
        name: "Dave",
      })
      const rows = await listContactsByAccount(executor, accountId)
      expect(rows[0].name).toBe("Dave Renamed")
    })

    it("saves and clears free-form notes the other writes never touch", async () => {
      const accountId = await createAccount(executor)
      await upsertContact(executor, accountId, { email: "erin@x.com" })
      const [row] = await listContactsByAccount(executor, accountId)

      await updateContact(executor, row.id, {
        notes: "Met at the conference",
      })
      let rows = await listContactsByAccount(executor, accountId)
      expect(rows[0].notes).toBe("Met at the conference")

      // Interaction bookkeeping and upserts leave notes alone
      await recordContactInteraction(executor, accountId, [
        { email: "erin@x.com" },
      ])
      await upsertContact(executor, accountId, { email: "erin@x.com" })
      rows = await listContactsByAccount(executor, accountId)
      expect(rows[0].notes).toBe("Met at the conference")
      expect(rows[0].interaction_count).toBe(1)

      await updateContact(executor, row.id, { notes: "" })
      rows = await listContactsByAccount(executor, accountId)
      expect(rows[0].notes).toBeNull()
    })

    it("updates nothing on an empty patch", async () => {
      const accountId = await createAccount(executor)
      await upsertContact(executor, accountId, {
        email: "frank@x.com",
        name: "Frank",
      })
      const [row] = await listContactsByAccount(executor, accountId)

      await updateContact(executor, row.id, {})
      const rows = await listContactsByAccount(executor, accountId)
      expect(rows[0]).toMatchObject({ name: "Frank", notes: null })
    })

    it("reflects the rename in recipient autocomplete", async () => {
      // recipient-field.tsx suggests through searchContactsRanked — the
      // renamed contact must surface there under the new name only.
      const accountId = await createAccount(executor)
      await upsertContact(executor, accountId, {
        email: "grace@x.com",
        name: "Grace Hopper",
      })
      const [row] = await listContactsByAccount(executor, accountId)
      await updateContact(executor, row.id, { name: "Grace Murray" })

      const rows = await searchContactsRanked(executor, accountId, "grace")
      expect(rows.map((suggestion) => suggestion.name)).toEqual([
        "Grace Murray",
      ])
      // The old name no longer matches at all
      expect(await searchContactsRanked(executor, accountId, "hopper")).toEqual(
        []
      )
    })
  })

  describe("deleteContact (task 20.2 lifecycle)", () => {
    it("removes only the contact row — messages stay untouched", async () => {
      const accountId = await createAccount(executor)
      await upsertContact(executor, accountId, {
        email: "hank@x.com",
        name: "Hank",
      })
      const [contact] = await listContactsByAccount(executor, accountId)
      const threadId = await createThread(executor, accountId, {
        subject: "Quarterly report",
      })
      const messageId = await createMessage(executor, {
        threadId,
        accountId,
        date: at(10),
        fromAddress: "hank@x.com",
        fromName: "Hank",
        subject: "Quarterly report",
        snippet: "Numbers attached",
      })

      await deleteContact(executor, contact.id)

      expect(await listContactsByAccount(executor, accountId)).toEqual([])
      // The correspondence the contact was derived from remains intact.
      const threads = await executor.select("SELECT id FROM threads")
      const messages = await executor.select<{
        id: string
        from_address: string | null
      }>("SELECT id, from_address FROM messages")
      expect(threads).toHaveLength(1)
      expect(messages).toEqual([{ id: messageId, from_address: "hank@x.com" }])
    })

    it("reappears automatically on the next correspondence", async () => {
      const accountId = await createAccount(executor)
      await upsertContact(executor, accountId, {
        email: "ivy@x.com",
        name: "Ivy",
      })
      const [contact] = await listContactsByAccount(executor, accountId)
      await deleteContact(executor, contact.id)

      await recordContactInteraction(executor, accountId, [
        { email: "ivy@x.com", name: "Ivy" },
      ])
      const rows = await listContactsByAccount(executor, accountId)
      expect(rows).toHaveLength(1)
      expect(rows[0].email).toBe("ivy@x.com")
      expect(rows[0].interaction_count).toBe(1)
    })
  })

  describe("listContactThreads (task 20.2 related threads)", () => {
    it("finds threads the contact sent or was addressed on, recent first", async () => {
      const accountId = await createAccount(executor)
      const threadOld = await createThread(executor, accountId, {
        subject: "Older thread",
      })
      const threadNew = await createThread(executor, accountId, {
        subject: "Newer thread",
      })
      await createMessage(executor, {
        threadId: threadOld,
        accountId,
        date: at(10),
        fromAddress: "Jack@X.com", // header casing varies; match is on lower
        subject: "Older thread",
      })
      await createMessage(executor, {
        threadId: threadNew,
        accountId,
        date: at(20),
        fromAddress: "me@x.com",
        to: [{ email: "jack@x.com", name: "Jack" }],
        subject: "Newer thread",
      })
      // The fixture doesn't run the thread-cache recompute; stamp the
      // last-activity cache the production ordering reads.
      await executor.execute(
        "UPDATE threads SET last_message_at = $1 WHERE id = $2",
        [at(10), threadOld]
      )
      await executor.execute(
        "UPDATE threads SET last_message_at = $1 WHERE id = $2",
        [at(20), threadNew]
      )

      const rows = await listContactThreads(executor, accountId, "jack@x.com")
      expect(rows.map((row) => row.subject)).toEqual([
        "Newer thread",
        "Older thread",
      ])
    })

    it("matches Cc recipients and honors the limit", async () => {
      const accountId = await createAccount(executor)
      const first = await createThread(executor, accountId, {
        subject: "Cc thread 1",
      })
      const second = await createThread(executor, accountId, {
        subject: "Cc thread 2",
      })
      await createMessage(executor, {
        threadId: first,
        accountId,
        date: at(10),
        fromAddress: "me@x.com",
        cc: [{ email: "kate@x.com" }],
      })
      await createMessage(executor, {
        threadId: second,
        accountId,
        date: at(11),
        fromAddress: "me@x.com",
        cc: [{ email: "kate@x.com" }],
      })
      await executor.execute(
        "UPDATE threads SET last_message_at = $1 WHERE id = $2",
        [at(11), second]
      )

      const rows = await listContactThreads(executor, accountId, "kate@x.com")
      expect(rows.map((row) => row.subject)).toEqual([
        "Cc thread 2",
        "Cc thread 1",
      ])
      expect(
        (
          await listContactThreads(executor, accountId, "kate@x.com", {
            limit: 1,
          })
        ).map((row) => row.subject)
      ).toEqual(["Cc thread 2"])
    })

    it("excludes trashed/spam threads and other accounts' threads", async () => {
      const accountId = await createAccount(executor)
      const otherId = await createAccount(executor)
      const trashed = await createThread(executor, accountId, {
        subject: "Trashed",
      })
      const spam = await createThread(executor, accountId, {
        subject: "Spam",
      })
      const kept = await createThread(executor, accountId, {
        subject: "Kept",
      })
      await createMessage(executor, {
        threadId: trashed,
        accountId,
        date: at(10),
        fromAddress: "li@x.com",
      })
      await createMessage(executor, {
        threadId: spam,
        accountId,
        date: at(11),
        fromAddress: "li@x.com",
      })
      await createMessage(executor, {
        threadId: kept,
        accountId,
        date: at(12),
        fromAddress: "li@x.com",
      })
      const otherThread = await createThread(executor, otherId, {
        subject: "Other account",
      })
      await createMessage(executor, {
        threadId: otherThread,
        accountId: otherId,
        date: at(13),
        fromAddress: "li@x.com",
      })
      await executor.execute(
        "UPDATE threads SET is_trashed = 1 WHERE id = $1",
        [trashed]
      )
      await executor.execute("UPDATE threads SET is_spam = 1 WHERE id = $1", [
        spam,
      ])

      const rows = await listContactThreads(executor, accountId, "li@x.com")
      expect(rows.map((row) => row.subject)).toEqual(["Kept"])
    })

    it("returns nothing for a blank address", async () => {
      const accountId = await createAccount(executor)
      expect(await listContactThreads(executor, accountId, "   ")).toEqual([])
    })
  })
})
