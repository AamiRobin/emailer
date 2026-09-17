import type { SenderStatRow } from "../db/sender-stats"

/**
 * The priority-inbox classifier (task 13.2, design D7): a scored sender
 * heuristic, NOT a model. Every new message accumulates its sender's row
 * in sender_stats (rules/ingestion.ts recordSenderStats); classification
 * happens lazily at view time from the accumulated row — zero new
 * dependencies, no training data, and a user override always wins.
 *
 * The score per sender:
 *
 *   score = 2 * reply_count
 *         + 3 * direct_to_me_count
 *         + recency bonus on last_message_at  (≤ 7 days: +2, ≤ 30 days: +1,
 *                                              older/never: 0)
 *         − 4 when is_mailing_list            (bulk/list senders push DOWN)
 *
 *   "important" ⇔ score >= IMPORTANT_SCORE_THRESHOLD (3).
 *
 * Threshold rationale (3): ONE direct-to-me message (3) classifies a
 * sender important — being personally addressed is the strongest single
 * signal — and so do two recent replies (2+2, the ongoing-conversation
 * signal), while a single reply (2) does not. Recency decays the bonus to
 * nothing after 30 days, so a stale contact sinks back until it writes
 * again. A pure newsletter never crosses the line: its list penalty (−4)
 * grows no matter how many issues arrive, and even a replied-to list
 * (replies 2 → +4) stays negative unless the user answers it repeatedly
 * AND it addresses them directly.
 *
 * D7's "participation in thread" signal is folded into reply_count: a
 * message is a reply when its subject starts with Re: OR its thread
 * already carries a message from the user's own address — i.e. the user
 * participates in the conversation it belongs to (flags derived in
 * rules/ingestion.ts).
 *
 * The user's per-sender override (sender_stats.user_class, migration v4)
 * dominates BOTH ways regardless of the score: "important" stays important
 * and "other" stays other. Clearing the override (NULL) returns the sender
 * to the pure heuristic. A sender with NO row at all classifies "other" —
 * no evidence, no promotion (brand-new senders land in Other until they
 * accumulate signals).
 */

export type SenderClass = "important" | "other"

/** score >= 3 → important (see the module doc's rationale). */
export const IMPORTANT_SCORE_THRESHOLD = 3

/** Recency bonus windows (unix seconds): ≤ 7 days +2, ≤ 30 days +1. */
const RECENCY_WEEK_SECONDS = 7 * 86400
const RECENCY_MONTH_SECONDS = 30 * 86400

/** Recency penalty: a mailing-list sender is pushed toward Other. */
export const MAILING_LIST_PENALTY = 4

/**
 * The stat fields the score reads — a full SenderStatRow satisfies this,
 * and tests can pass bare objects.
 */
export interface SenderScoreInput {
  reply_count: number
  direct_to_me_count: number
  last_message_at: number | null
  is_mailing_list: number
  user_class?: SenderStatRow["user_class"]
}

/** The D7 score of one sender's accumulated row (pure; `now` pinned for tests). */
export function senderScore(
  stat: SenderScoreInput,
  now: number = Math.floor(Date.now() / 1000)
): number {
  const last = stat.last_message_at
  let recency = 0
  if (last !== null) {
    const age = now - last
    if (age <= RECENCY_WEEK_SECONDS) recency = 2
    else if (age <= RECENCY_MONTH_SECONDS) recency = 1
  }
  return (
    2 * stat.reply_count +
    3 * stat.direct_to_me_count +
    recency -
    (stat.is_mailing_list ? MAILING_LIST_PENALTY : 0)
  )
}

/**
 * Classify one sender: the override dominates, otherwise the score decides
 * against IMPORTANT_SCORE_THRESHOLD. A missing row (never-mailed sender)
 * classifies "other".
 */
export function classifySender(
  stat: SenderScoreInput | null,
  now: number = Math.floor(Date.now() / 1000)
): SenderClass {
  if (!stat) return "other"
  if (stat.user_class) return stat.user_class
  return senderScore(stat, now) >= IMPORTANT_SCORE_THRESHOLD
    ? "important"
    : "other"
}
