import { describe, expect, it } from "vitest"

import type { ThreadRow } from "@/services/db/threads"
import {
  bundleMemberIds,
  bundleSenderOf,
  groupByConsecutiveSender,
} from "../bundles"

/**
 * Pure grouping tests for the group-by-sender bundles (task 9.4, design
 * D4): consecutive-run semantics over the already-materialized window —
 * case-insensitive address identity, senderless rows standing alone,
 * count + latest-subject correctness, and stable keys/ids.
 */

let seq = 0

function thread(
  overrides: Partial<ThreadRow> & { participants?: string | null }
): ThreadRow {
  seq += 1
  return {
    id: `t${seq}`,
    account_id: "acc1",
    subject: `Subject ${seq}`,
    snippet: null,
    first_message_at: 1_700_000_000,
    last_message_at: 1_700_000_000 + seq,
    message_count: 1,
    unread_count: 0,
    has_attachments: 0,
    is_starred: 0,
    participants: null,
    gmail_thread_id: null,
    folder_label_id: null,
    is_archived: 0,
    is_trashed: 0,
    is_spam: 0,
    created_at: 1_700_000_000,
    ...overrides,
  }
}

function sender(name: string | null | undefined, email: string): string {
  return JSON.stringify(name ? [{ name, email }] : [{ email }])
}

/** Subjects of the flattened segments, bundles rendered as their members. */
function shape(threads: ThreadRow[]): string[] {
  return groupByConsecutiveSender(threads).map((segment) =>
    segment.kind === "single"
      ? (segment.thread.subject ?? "")
      : `bundle(${segment.bundle.members.length})`
  )
}

describe("groupByConsecutiveSender", () => {
  it("groups only CONSECUTIVE same-sender runs: A B B A → [A] [B,B] [A]", () => {
    const a1 = thread({ subject: "A1", participants: sender("A", "a@x.com") })
    const b1 = thread({ subject: "B1", participants: sender("B", "b@x.com") })
    const b2 = thread({ subject: "B2", participants: sender("B", "b@x.com") })
    const a2 = thread({ subject: "A2", participants: sender("A", "a@x.com") })

    const segments = groupByConsecutiveSender([a1, b1, b2, a2])
    expect(shape([a1, b1, b2, a2])).toEqual(["A1", "bundle(2)", "A2"])
    const bundle = segments[1].kind === "bundle" ? segments[1].bundle : null
    expect(bundle?.members.map((member) => member.id)).toEqual([b1.id, b2.id])
  })

  it("matches sender addresses case-insensitively (and trims)", () => {
    const first = thread({
      participants: sender("Ann", "  Ann@Example.com "),
    })
    const second = thread({ participants: sender(null, "ann@example.com") })
    const segments = groupByConsecutiveSender([first, second])
    expect(shape([first, second])).toEqual(["bundle(2)"])
    expect(
      segments[0].kind === "bundle" ? segments[0].bundle.sender.email : null
    ).toBe("ann@example.com")
  })

  it("keeps senderless rows standalone; they also break a same-sender run", () => {
    const first = thread({ participants: sender("A", "a@x.com") })
    const nameless = thread({
      participants: JSON.stringify([{ name: "No address", email: "" }]),
    })
    const noCache = thread({ participants: null })
    const second = thread({ participants: sender("A", "a@x.com") })

    // The senderless rows split the two a@x.com rows into separate runs
    // of one — all four rows stay plain (no bundle chrome).
    expect(shape([first, nameless, noCache, second])).toEqual([
      first.subject,
      nameless.subject,
      noCache.subject,
      second.subject,
    ])

    // Without the senderless rows in between, the same two rows bundle.
    expect(shape([first, second])).toEqual(["bundle(2)"])
  })

  it("leaves runs of one as plain rows (no bundle chrome)", () => {
    const only = thread({ participants: sender("A", "a@x.com") })
    const segments = groupByConsecutiveSender([only])
    expect(segments).toEqual([{ kind: "single", thread: only }])
  })

  it("handles empty and all-single lists", () => {
    expect(groupByConsecutiveSender([])).toEqual([])
    const a = thread({ participants: sender("A", "a@x.com") })
    const b = thread({ participants: sender("B", "b@x.com") })
    expect(groupByConsecutiveSender([a, b])).toEqual([
      { kind: "single", thread: a },
      { kind: "single", thread: b },
    ])
  })

  it("carries the member count and the LATEST subject among members", () => {
    const newest = thread({
      subject: "Newest of the run",
      last_message_at: 5_000,
      participants: sender("A", "a@x.com"),
    })
    const middle = thread({
      subject: "Middle",
      last_message_at: 4_000,
      participants: sender("A", "a@x.com"),
    })
    const dateless = thread({
      subject: "Dateless",
      last_message_at: null,
      participants: sender("A", "a@x.com"),
    })

    const segments = groupByConsecutiveSender([dateless, newest, middle])
    expect(segments).toHaveLength(1)
    const segment = segments[0]
    if (segment.kind !== "bundle") throw new Error("expected a bundle")
    expect(segment.bundle.members).toHaveLength(3)
    expect(segment.bundle.latest.subject).toBe("Newest of the run")
  })

  it("derives a stable key from the sender + first member, and member ids in sort order", () => {
    const first = thread({ participants: sender("A", "a@x.com") })
    const second = thread({ participants: sender("A", "a@x.com") })
    const segments = groupByConsecutiveSender([first, second])
    const bundle = segments[0].kind === "bundle" ? segments[0].bundle : null
    if (!bundle) throw new Error("expected a bundle")
    expect(bundle.key).toBe(`bundle:a@x.com:${first.id}`)
    expect(bundleMemberIds(bundle)).toEqual([first.id, second.id])
  })

  it("prefers the cached sender name for display, falling back to the address", () => {
    const named = thread({ participants: sender("Grace Hopper", "g@x.com") })
    expect(bundleSenderOf(named)?.name).toBe("Grace Hopper")

    const unnamed = thread({ participants: sender(null, "g@x.com") })
    expect(bundleSenderOf(unnamed)?.name).toBe("g@x.com")

    // A whitespace-only name falls through to the address too.
    const blank = thread({
      participants: sender("   ", "g@x.com"),
    })
    expect(bundleSenderOf(blank)?.name).toBe("g@x.com")
  })

  it("returns null for rows without a usable sender address", () => {
    expect(bundleSenderOf(thread({ participants: null }))).toBeNull()
    expect(bundleSenderOf(thread({ participants: "not json" }))).toBeNull()
    expect(
      bundleSenderOf(thread({ participants: JSON.stringify([{ email: "" }]) }))
    ).toBeNull()
  })
})
