import type { ThreadRow } from "@/services/db/threads"
import { parseThreadParticipants } from "@/stores/thread-list-store"

/**
 * Group-by-sender bundles (task 9.4, design D4). Bundles are a GROUP BY
 * over the ALREADY-MATERIALIZED windowed rows — the list query stays
 * untouched; this module collapses CONSECUTIVE rows (in the current sort
 * order) whose newest-message sender address matches case-insensitively
 * into one bundle. A run of one stays a normal row; a run of two or more
 * becomes a bundle carrying the count and the latest subject. Expansion
 * (which member rows to splice back in) is client-side state in the list;
 * a bundle action is exactly a multi-target action over `memberIds`.
 *
 * The sender identity is `participants[0]` of the cached participants
 * JSON (buildParticipantsCache puts the newest message's from-contact
 * first) — the SAME identity the sender sort uses. Design note: D4
 * mentions the contacts table for the display name, but the participants
 * cache already carries the newest sender's name, so the display name is
 * `participants[0].name` falling back to the address — no extra join,
 * everything stays client-side over the loaded rows (kept simplification).
 */

/** Minimal row shape the grouping reads (ThreadRow satisfies it). */
export interface BundleableThread {
  id: string
  subject: string | null
  last_message_at: number | null
  participants: string | null
}

/** Normalized newest-sender of a thread: the grouping identity (`email`
 * lowercased) plus its display name (cached name, falling back to the
 * raw address). */
export interface BundleSender {
  email: string
  name: string
}

/** One collapsed run of ≥2 consecutive same-sender threads. */
export interface SenderBundle<T extends BundleableThread = ThreadRow> {
  /** Stable per-composition key (virtual-row key + expansion identity):
   * sender address + the run's first member id. */
  key: string
  sender: BundleSender
  /** The run's threads, in the current sort order. */
  members: T[]
  /** The member with the newest last_message_at (nulls last) — supplies
   * the bundle's "latest subject". */
  latest: T
}

/** One step of a grouped list: a standalone thread or a collapsed run. */
export type GroupedSegment<T extends BundleableThread = ThreadRow> =
  { kind: "single"; thread: T } | { kind: "bundle"; bundle: SenderBundle<T> }

/**
 * The thread's bundle-sender, or null when the row has no usable cached
 * sender (no participants JSON, or a newest sender without an address —
 * e.g. a from-name-only contact). Senderless rows always stand alone.
 */
export function bundleSenderOf(thread: BundleableThread): BundleSender | null {
  const first = parseThreadParticipants(thread.participants)[0]
  const email = first?.email.trim().toLowerCase()
  if (!email) return null
  return { email, name: first.name?.trim() || first.email }
}

/** Every member id, in sort order — the target list for bundle actions. */
export function bundleMemberIds(bundle: SenderBundle): string[] {
  return bundle.members.map((member) => member.id)
}

/** Newest member by last_message_at (a null date sorts last; ties keep
 * the earlier-listed member). */
function latestMember<T extends BundleableThread>(members: T[]): T {
  let latest = members[0]
  for (const member of members.slice(1)) {
    if (
      member.last_message_at !== null &&
      (latest.last_message_at === null ||
        member.last_message_at > latest.last_message_at)
    ) {
      latest = member
    }
  }
  return latest
}

/**
 * Collapse consecutive same-sender runs (case-insensitive address match)
 * into bundles. Non-consecutive runs of the same sender stay separate —
 * A B B A groups as [A] [B,B] [A] — and senderless rows stand alone.
 * Runs of exactly one stay plain thread rows (no bundle chrome).
 */
export function groupByConsecutiveSender<T extends BundleableThread>(
  threads: readonly T[]
): GroupedSegment<T>[] {
  const segments: GroupedSegment<T>[] = []
  let index = 0
  while (index < threads.length) {
    const sender = bundleSenderOf(threads[index])
    if (!sender) {
      segments.push({ kind: "single", thread: threads[index] })
      index += 1
      continue
    }
    let end = index + 1
    while (end < threads.length) {
      const next = bundleSenderOf(threads[end])
      if (!next || next.email !== sender.email) break
      end += 1
    }
    const members = threads.slice(index, end)
    if (members.length === 1) {
      segments.push({ kind: "single", thread: members[0] })
    } else {
      segments.push({
        kind: "bundle",
        bundle: {
          key: `bundle:${sender.email}:${members[0].id}`,
          sender,
          members,
          latest: latestMember(members),
        },
      })
    }
    index = end
  }
  return segments
}
