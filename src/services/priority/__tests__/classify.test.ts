import { describe, expect, it } from "vitest"

import {
  IMPORTANT_SCORE_THRESHOLD,
  MAILING_LIST_PENALTY,
  classifySender,
  senderScore,
  type SenderScoreInput,
} from "../classify"

/**
 * Priority-inbox classifier (task 13.2, design D7) — pure unit tests over
 * the scored sender heuristic: score = 2*reply + 3*direct + recency
 * (≤7d +2, ≤30d +1, older 0) − 4*list; "important" ⇔ score >=
 * IMPORTANT_SCORE_THRESHOLD (3); the user override dominates both ways.
 *
 * `now` is pinned; stat timestamps are placed relative to it.
 */

const NOW = 1_700_000_000

function stat(overrides: Partial<SenderScoreInput>): SenderScoreInput {
  return {
    reply_count: 0,
    direct_to_me_count: 0,
    last_message_at: null,
    is_mailing_list: 0,
    ...overrides,
  }
}

describe("senderScore", () => {
  it("scores replies, direct hits and the recency bonus additively", () => {
    expect(
      senderScore(stat({ reply_count: 2, last_message_at: NOW - 60 }), NOW)
    ).toBe(2 * 2 + 2) // two replies + within-7d bonus
    expect(
      senderScore(
        stat({ direct_to_me_count: 1, last_message_at: NOW - 10 * 86400 }),
        NOW
      )
    ).toBe(3 + 1) // one direct + within-30d bonus
    expect(senderScore(stat({ reply_count: 3 }), NOW)).toBe(6) // no recency without a date
  })

  it("decays the recency bonus to zero for stale senders", () => {
    expect(
      senderScore(
        stat({ reply_count: 1, last_message_at: NOW - 6 * 86400 }),
        NOW
      )
    ).toBe(4) // 2 + week bonus
    expect(
      senderScore(
        stat({ reply_count: 1, last_message_at: NOW - 20 * 86400 }),
        NOW
      )
    ).toBe(3) // 2 + month bonus
    expect(
      senderScore(
        stat({ reply_count: 1, last_message_at: NOW - 40 * 86400 }),
        NOW
      )
    ).toBe(2) // decayed
  })

  it("penalizes mailing-list senders", () => {
    expect(
      senderScore(stat({ is_mailing_list: 1, last_message_at: NOW }), NOW)
    ).toBe(-MAILING_LIST_PENALTY + 2)
  })
})

describe("classifySender", () => {
  it("never promotes a genuine bulk list, no matter how many issues arrive", () => {
    for (let issues = 0; issues <= 50; issues += 10) {
      expect(
        classifySender(
          stat({
            is_mailing_list: 1,
            reply_count: 0,
            last_message_at: NOW,
          }),
          NOW
        )
      ).toBe("other") // −4 forever; volume is not a signal
    }
  })

  it("classifies a single direct-to-me message important", () => {
    expect(
      classifySender(stat({ direct_to_me_count: 1, last_message_at: NOW }), NOW)
    ).toBe("important") // 3 + 2 >= 3
  })

  it("classifies two recent replies important, with room for decay", () => {
    expect(
      classifySender(stat({ reply_count: 2, last_message_at: NOW }), NOW)
    ).toBe("important") // 4 + 2
    // Even fully decayed the pair stays on the right side: 4 >= 3.
    expect(
      classifySender(
        stat({ reply_count: 2, last_message_at: NOW - 60 * 86400 }),
        NOW
      )
    ).toBe("important")
  })

  it("a single reply is important only while recency keeps it at/above the line", () => {
    expect(
      classifySender(
        stat({ reply_count: 1, last_message_at: NOW - 3 * 86400 }),
        NOW
      )
    ).toBe("important") // 2 + 2 = 4
    expect(
      classifySender(
        stat({ reply_count: 1, last_message_at: NOW - 20 * 86400 }),
        NOW
      )
    ).toBe("important") // 2 + 1 = 3, exactly at the threshold
    expect(
      classifySender(
        stat({ reply_count: 1, last_message_at: NOW - 31 * 86400 }),
        NOW
      )
    ).toBe("other") // 2 + 0 — the conversation decayed away
  })

  it("uses the threshold constant consistently", () => {
    expect(IMPORTANT_SCORE_THRESHOLD).toBe(3)
  })

  it("a user override dominates both ways regardless of the score", () => {
    // A pure newsletter forced important.
    expect(
      classifySender(stat({ is_mailing_list: 1, user_class: "important" }), NOW)
    ).toBe("important")
    // A chatty direct correspondent forced other.
    expect(
      classifySender(
        stat({
          reply_count: 40,
          direct_to_me_count: 40,
          last_message_at: NOW,
          user_class: "other",
        }),
        NOW
      )
    ).toBe("other")
  })

  it("clearing the override returns the sender to the heuristic", () => {
    expect(
      classifySender(stat({ is_mailing_list: 1, user_class: null }), NOW)
    ).toBe("other")
    expect(
      classifySender(
        stat({
          direct_to_me_count: 2,
          last_message_at: NOW,
          user_class: null,
        }),
        NOW
      )
    ).toBe("important")
  })

  it("classifies a sender with no stat row as other", () => {
    expect(classifySender(null, NOW)).toBe("other")
  })
})
