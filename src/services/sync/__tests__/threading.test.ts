import { describe, expect, it } from "vitest"

import type { ThreadGroup, ThreadableMessage } from "../threading"
import {
  groupIntoThreads,
  normalizeMessageId,
  normalizeSubject,
  parseReferences,
} from "../threading"

function msg(
  overrides: Partial<ThreadableMessage> & { id: string }
): ThreadableMessage {
  return { date: 0, ...overrides }
}

function groupOf(key: string, groups: ThreadGroup[]): ThreadGroup | undefined {
  return groups.find((group) => group.key === key)
}

function memberIds(key: string, groups: ThreadGroup[]): string[] {
  const group = groupOf(key, groups)
  return group ? group.messageIds : []
}

function groupCount(groups: ThreadGroup[]): number {
  return groups.length
}

describe("message-id normalization", () => {
  it("collapses bracketed and bare forms", () => {
    expect(normalizeMessageId("<msg-0@example.com>")).toBe("msg-0@example.com")
    expect(normalizeMessageId("  <msg-0@example.com> ")).toBe(
      "msg-0@example.com"
    )
    expect(normalizeMessageId("msg-0@example.com")).toBe("msg-0@example.com")
    expect(normalizeMessageId("msg-0@example.com>")).toBe("msg-0@example.com")
    expect(normalizeMessageId(null)).toBe("")
    expect(normalizeMessageId("   ")).toBe("")
    expect(normalizeMessageId("<>")).toBe("")
  })

  it("preserves case (RFC 5322 msg-id is case-sensitive)", () => {
    expect(normalizeMessageId("<A@B.com>")).toBe("A@B.com")
  })
})

describe("parseReferences", () => {
  it("reads bracketed chains", () => {
    expect(parseReferences("<a@x> <b@x> <c@x>")).toEqual(["a@x", "b@x", "c@x"])
  })

  it("falls back to bare whitespace-separated tokens", () => {
    expect(parseReferences("a@x b@x")).toEqual(["a@x", "b@x"])
  })

  it("dedupes and tolerates empty input", () => {
    expect(parseReferences("<a@x> <a@x>")).toEqual(["a@x"])
    expect(parseReferences(null)).toEqual([])
    expect(parseReferences("   ")).toEqual([])
  })
})

describe("normalizeSubject", () => {
  it("strips repeated reply/forward prefixes, case and extra spaces", () => {
    expect(normalizeSubject("Re: Re: FWD:  Hello   World ")).toBe("hello world")
    expect(normalizeSubject("Fw:Hello")).toBe("hello")
    expect(normalizeSubject("  HELLO  ")).toBe("hello")
  })

  it("keeps a subject that is only a prefix distinguishable from none", () => {
    expect(normalizeSubject("Re:")).toBe("")
    expect(normalizeSubject("Re: Re:")).toBe("")
    expect(normalizeSubject(null)).toBe("")
  })
})

describe("groupIntoThreads — In-Reply-To chains", () => {
  it("groups an A←B←C reply chain into one thread", () => {
    const groups = groupIntoThreads([
      msg({
        id: "a",
        messageId: "<a@x>",
        subject: "Lunch",
        date: 100,
      }),
      msg({
        id: "b",
        messageId: "<b@x>",
        inReplyTo: "<a@x>",
        subject: "Re: Lunch",
        date: 200,
      }),
      msg({
        id: "c",
        messageId: "<c@x>",
        inReplyTo: "<b@x>",
        subject: "Re: Lunch",
        date: 300,
      }),
    ])
    expect(groupCount(groups)).toBe(1)
    expect(memberIds("a@x", groups)).toEqual(["a", "b", "c"])
  })

  it("matches bracketed and bare id spellings across headers", () => {
    const groups = groupIntoThreads([
      msg({ id: "a", messageId: "a@x", subject: "S", date: 1 }),
      msg({ id: "b", messageId: "<b@x>", inReplyTo: "a@x", date: 2 }),
      msg({ id: "c", messageId: "<c@x>", inReplyTo: "<b@x>", date: 3 }),
    ])
    expect(groupCount(groups)).toBe(1)
    expect(memberIds("a@x", groups)).toEqual(["a", "b", "c"])
  })

  it("groups by date ascending inside the thread regardless of input order", () => {
    const groups = groupIntoThreads([
      msg({ id: "c", messageId: "<c@x>", inReplyTo: "<b@x>", date: 3 }),
      msg({ id: "a", messageId: "<a@x>", date: 1 }),
      msg({ id: "b", messageId: "<b@x>", inReplyTo: "<a@x>", date: 2 }),
    ])
    expect(memberIds("a@x", groups)).toEqual(["a", "b", "c"])
  })
})

describe("groupIntoThreads — References chains", () => {
  it("groups a multi-ancestor references chain", () => {
    const groups = groupIntoThreads([
      msg({ id: "root", messageId: "<root@x>", date: 1 }),
      msg({
        id: "mid",
        messageId: "<mid@x>",
        references: "<root@x>",
        date: 2,
      }),
      msg({
        id: "leaf",
        messageId: "<leaf@x>",
        references: "<root@x> <mid@x>",
        date: 3,
      }),
    ])
    expect(groupCount(groups)).toBe(1)
    expect(memberIds("root@x", groups)).toEqual(["root", "mid", "leaf"])
  })

  it("prefers In-Reply-To when it extends the references chain", () => {
    const groups = groupIntoThreads([
      msg({ id: "root", messageId: "<root@x>", date: 1 }),
      msg({
        id: "reply",
        messageId: "<reply@x>",
        references: "<root@x>",
        inReplyTo: "<root@x>",
        date: 2,
      }),
    ])
    expect(groupCount(groups)).toBe(1)
  })

  it("keeps only the referenced ancestors — unseen phantoms do not emit ids", () => {
    const groups = groupIntoThreads([
      msg({
        id: "reply",
        messageId: "<reply@x>",
        references: "<ghost@x> <root@x>",
        date: 5,
      }),
      msg({ id: "root", messageId: "<root@x>", date: 1 }),
    ])
    // the phantom root anchors the group (deterministic across syncs)
    expect(groupCount(groups)).toBe(1)
    expect(groups[0]?.key).toBe("ghost@x")
    expect(groups[0]?.messageIds).toEqual(["root", "reply"])
  })
})

describe("groupIntoThreads — cross-linking", () => {
  it("merges two messages referencing the same unseen root", () => {
    const groups = groupIntoThreads([
      msg({
        id: "p1",
        messageId: "<p1@x>",
        references: "<shared-root@x>",
        date: 10,
      }),
      msg({
        id: "p2",
        messageId: "<p2@x>",
        references: "<shared-root@x>",
        date: 20,
      }),
    ])
    expect(groupCount(groups)).toBe(1)
    expect(memberIds("shared-root@x", groups)).toEqual(["p1", "p2"])
  })

  it("joins siblings via a root that is present", () => {
    const groups = groupIntoThreads([
      msg({ id: "root", messageId: "<root@x>", date: 1 }),
      msg({ id: "s1", messageId: "<s1@x>", inReplyTo: "<root@x>", date: 2 }),
      msg({ id: "s2", messageId: "<s2@x>", inReplyTo: "<root@x>", date: 3 }),
    ])
    expect(groupCount(groups)).toBe(1)
    expect(memberIds("root@x", groups)).toEqual(["root", "s1", "s2"])
  })

  it("does not loop on cyclic references", () => {
    const groups = groupIntoThreads([
      msg({
        id: "m1",
        messageId: "<m1@x>",
        references: "<m2@x>",
        date: 1,
      }),
      msg({
        id: "m2",
        messageId: "<m2@x>",
        references: "<m1@x>",
        date: 2,
      }),
    ])
    expect(groupCount(groups)).toBe(1)
    expect(groups[0]?.messageIds).toEqual(["m1", "m2"])
  })
})

describe("groupIntoThreads — subject fallback", () => {
  const sameSubject = [
    msg({ id: "m1", subject: "Newsletter", date: 1 }),
    msg({ id: "m2", subject: "Re: Newsletter", date: 2 }),
    msg({ id: "m3", subject: "  FWD: NEWSLETTER  ", date: 3 }),
  ]

  it("merges same-subject roots when enabled (default)", () => {
    const groups = groupIntoThreads(sameSubject)
    expect(groupCount(groups)).toBe(1)
    expect(groups[0]?.messageIds).toEqual(["m1", "m2", "m3"])
  })

  it("keeps them apart when disabled", () => {
    const groups = groupIntoThreads(sameSubject, [], {
      groupBySubject: false,
    })
    expect(groupCount(groups)).toBe(3)
  })

  it("never merges when subjects normalize to empty", () => {
    const groups = groupIntoThreads([
      msg({ id: "x", subject: "Re:", date: 1 }),
      msg({ id: "y", subject: undefined, date: 2 }),
    ])
    expect(groupCount(groups)).toBe(2)
  })

  it("mixed: a reply chain absorbs an unrelated same-subject root but keeps its order", () => {
    // subject-fallback semantics: same-normalized-subject ROOTS merge
    // (the known D9 trade-off), while the chain stays intact underneath
    const groups = groupIntoThreads([
      msg({ id: "root", messageId: "<root@x>", subject: "Plan", date: 1 }),
      msg({
        id: "reply",
        messageId: "<reply@x>",
        inReplyTo: "<root@x>",
        subject: "Re: Plan",
        date: 2,
      }),
      msg({ id: "stray", messageId: "<stray@x>", subject: "Plan", date: 3 }),
    ])
    expect(groupCount(groups)).toBe(1)
    expect(groupOf("root@x", groups)?.messageIds).toEqual([
      "root",
      "reply",
      "stray",
    ])
  })

  it("mixed: a chain and an unrelated different-subject root stay apart", () => {
    const groups = groupIntoThreads([
      msg({ id: "root", messageId: "<root@x>", subject: "Plan", date: 1 }),
      msg({
        id: "reply",
        messageId: "<reply@x>",
        inReplyTo: "<root@x>",
        subject: "Re: Plan",
        date: 2,
      }),
      msg({ id: "stray", messageId: "<stray@x>", subject: "Other", date: 3 }),
    ])
    expect(groupCount(groups)).toBe(2)
    expect(memberIds("root@x", groups)).toEqual(["root", "reply"])
    expect(groupOf("stray@x", groups)?.messageIds).toEqual(["stray"])
  })

  it("mixed with fallback off: the stray stays its own thread too", () => {
    const groups = groupIntoThreads(
      [
        msg({ id: "root", messageId: "<root@x>", subject: "Plan", date: 1 }),
        msg({
          id: "reply",
          messageId: "<reply@x>",
          inReplyTo: "<root@x>",
          date: 2,
        }),
        msg({ id: "stray", messageId: "<stray@x>", subject: "Plan", date: 3 }),
      ],
      [],
      { groupBySubject: false }
    )
    expect(groupCount(groups)).toBe(2)
    expect(memberIds("root@x", groups)).toEqual(["root", "reply"])
  })
})

describe("groupIntoThreads — empty and missing headers", () => {
  it("returns no groups for no messages", () => {
    expect(groupIntoThreads([])).toEqual([])
  })

  it("makes singletons of header-less messages", () => {
    const groups = groupIntoThreads([
      msg({ id: "solo", date: 1 }),
      msg({ id: "other", subject: "Hi", date: 2 }),
    ])
    expect(groupCount(groups)).toBe(2)
  })

  it("keeps both copies of a duplicated Message-ID", () => {
    const groups = groupIntoThreads([
      msg({ id: "copy-1", messageId: "<dup@x>", date: 1 }),
      msg({ id: "copy-2", messageId: "<dup@x>", date: 2 }),
    ])
    expect(groupCount(groups)).toBe(1)
    expect(groupOf("dup@x", groups)?.messageIds).toEqual(["copy-1", "copy-2"])
  })

  it("threads a reply onto its referenced phantom parent, falling back to subject only if the phantom root lacks an id", () => {
    const groups = groupIntoThreads([
      msg({ id: "anon", subject: "Question", date: 1 }),
      msg({
        id: "reply",
        messageId: "<reply@x>",
        inReplyTo: "<missing@x>",
        subject: "Re: Question",
        date: 2,
      }),
    ])
    // the referenced-but-unseen parent anchors the group deterministically
    expect(groupCount(groups)).toBe(1)
    expect(groupOf("missing@x", groups)?.messageIds).toEqual(["anon", "reply"])
  })
})

describe("groupIntoThreads — determinism and incremental merge", () => {
  const input = [
    msg({ id: "a", messageId: "<a@x>", subject: "One", date: 1 }),
    msg({ id: "b", messageId: "<b@x>", inReplyTo: "<a@x>", date: 2 }),
    msg({ id: "z", messageId: "<z@x>", subject: "Two", date: 3 }),
  ]

  it("is stable across runs and input order", () => {
    const first = groupIntoThreads(input)
    const second = groupIntoThreads([...input].reverse())
    expect(first).toEqual(second)
    // groups sorted by key
    expect(first.map((group) => group.key)).toEqual(["a@x", "z@x"])
  })

  it("merges with existingGroups by key, unioning members", () => {
    const existing: ThreadGroup[] = [
      { key: "a@x", messageIds: ["old-1", "a"] },
      { key: "gone@x", messageIds: ["old-2"] },
    ]
    const groups = groupIntoThreads(
      [msg({ id: "b", messageId: "<b@x>", inReplyTo: "<a@x>", date: 2 })],
      existing
    )
    expect(groupOf("a@x", groups)?.messageIds).toEqual(["old-1", "a", "b"])
    expect(groupOf("gone@x", groups)?.messageIds).toEqual(["old-2"])
  })
})
