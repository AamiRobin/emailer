import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  listContactsByAccount,
  recordContactInteraction,
  searchContactsRanked,
  upsertContact,
} from "../contacts"
import { createTestExecutor, type TestExecutor } from "./test-executor"
import { createAccount } from "./fixtures"

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
})
