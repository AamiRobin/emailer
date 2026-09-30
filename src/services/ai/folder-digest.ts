import type { SqlExecutor } from "../db/executor"
import type { MessageRow } from "../db/messages"
import type { Category } from "../categorization/classify"
import {
  getThreadWithMessages,
  listThreadsByCategoryAcrossAccounts,
  listThreadsByFolder,
  type FolderSelection,
  type ThreadRow,
} from "../db/threads"
import { getAiCache, putAiCache } from "./cache"
import { AiUnavailableError, aiChat, resolveSurfaceRuntime } from "./client"
import {
  cleanUntrusted,
  fenceThread,
  UNTRUSTED_THREAD_NOTICE,
  withOutputLanguage,
} from "./prompt"
import { getOutputLanguage } from "./settings"

/**
 * Folder unread digest (task 6, ai-assistance spec "Folder unread digest",
 * design D4) — the prompt/cache half of the "catch me up" surface,
 * consumed by the mailbox header affordance (task 7). Given the active
 * view's scope — one account's folder, or one category across accounts —
 * asks the active provider for a short markdown briefing over the scope's
 * unread threads and caches it under the scope's unread thread-id set.
 *
 * Scope (design D4): the digest is scoped to the INVOKED view, never the
 * whole mailbox. The scope rides the call as a discriminated union
 * (`DigestScope`); the category scope is inherently cross-account, the
 * folder scope pins one account.
 *
 * Gating/throwing (task 6.1): zero unread threads in scope short-circuits
 * to null — no provider round-trip, nothing cached (the UI hides the
 * affordance in that case; null is the defensive backstop). Everything
 * else that fails throws: `AiUnavailableError` (not configured / surface
 * disabled — the UI hides first, so this is the fail-toward-off guard)
 * and `AiProviderError` (transport/provider — the dialog owns Retry).
 *
 * Caching (task 6.2, design D2/D4): kind "folder-digest", keyed on
 * `scope + "\n" + sorted unread thread-id set` plus the active
 * provider/model. Reading a thread removes it from the unread set, which
 * changes the key — exactly the spec's "threads read after the digest was
 * generated are covered by a new digest, not the cached one". The WHOLE
 * `DigestResult` is stored and returned verbatim on a hit: the cached
 * briefing must be the exact text the user saw before, with the
 * thread/omitted counts it was generated from — not recomputed against
 * drifted state. Read-before-call, write-after.
 *
 * Data boundary (spec "AI consent and data boundaries"): the prompt sends
 * only the scope's own unread threads (subject, cached participants, and
 * the newest message's plain-text body — capped) and nothing else.
 * Request size is bounded by construction: DIGEST_MAX_THREADS threads ×
 * MAX_THREAD_CHARS per body.
 */

/** The scope a digest is built over — the active view's selection. */
export type DigestScope =
  | { kind: "accountFolder"; accountId: string; folder: FolderSelection }
  /** One inbox category, across every account (the category tabs). */
  | { kind: "category"; category: Category }

export interface DigestOptions {
  scope: DigestScope
}

export interface DigestResult {
  /** The markdown briefing as returned by the provider (or cached). */
  digest: string
  /** Unread threads included in the prompt (≤ DIGEST_MAX_THREADS). */
  threadCount: number
  /** Unread threads beyond the cap (the "and N more" tail). */
  omittedCount: number
}

/** The ai_cache kind for this surface (design D4). */
const CACHE_KIND = "folder-digest"

/** Cap on the threads a digest covers — bounds the request regardless of
 * how many unread threads the scope has; overflow lands in the
 * "and N more" tail instead of being silently dropped. */
export const DIGEST_MAX_THREADS = 25

/** Per-thread body cap in the prompt — the newest message's plain text,
 * hard-sliced (design D4's ~1200-char per-thread bound). */
const MAX_THREAD_CHARS = 1200

const SYSTEM_PROMPT = [
  "You write the user's unread-mail briefing.",
  "Write a short markdown briefing of the UNREAD THREADS below:",
  "one markdown bullet per thread (\"- <subject> — <one-line gist>\"),",
  "then a final line \"Overview: <one sentence over the whole set>\".",
  "Keep every line grounded in the thread content; do not invent content.",
  // The fenced thread list below is attacker-controlled: state the fence
  // contract (same line every fencing surface carries).
  UNTRUSTED_THREAD_NOTICE,
].join("\n")

/** Stable cache-identity string for the folder half of a scope. */
function folderKey(folder: FolderSelection): string {
  switch (folder.kind) {
    case "labelId":
      return `labelId:${folder.labelId}`
    case "specialUse":
      return `specialUse:${folder.specialUse}`
    case "preset":
      return `preset:${folder.preset}`
  }
}

/**
 * The scope half of the cache identity (design D4: `scope + "\n" + sorted
 * unread thread-id set`). Stable per view so the same view unchanged hits
 * the same row, and different views never share one.
 */
function scopeKey(scope: DigestScope): string {
  return scope.kind === "accountFolder"
    ? `accountFolder:${scope.accountId}:${folderKey(scope.folder)}`
    : `category:${scope.category}`
}

/**
 * The scope's unread threads, most recent first (last_message_at desc, id
 * tiebreak so equal timestamps order deterministically). The folder-list
 * queries resolve membership through BOTH account models (gmail
 * thread_labels, imap folder cache) and carry the inbox-only exclusions;
 * the unread filter and recency order are applied here — the digest is a
 * briefing, not the list (no pinned-first lead).
 */
async function loadUnreadThreads(
  executor: SqlExecutor,
  scope: DigestScope
): Promise<ThreadRow[]> {
  const rows =
    scope.kind === "accountFolder"
      ? await listThreadsByFolder(executor, {
          accountId: scope.accountId,
          folder: scope.folder,
        })
      : await listThreadsByCategoryAcrossAccounts(executor, {
          category: scope.category,
        })
  return rows
    .filter((thread) => thread.unread_count > 0)
    .sort(
      (a, b) =>
        (b.last_message_at ?? 0) - (a.last_message_at ?? 0) ||
        a.id.localeCompare(b.id)
    )
}

/**
 * Display line for a thread's cached participants (migration v2 JSON —
 * the newest message's from plus up to two to-recipients). The cache is
 * email-derived (attacker-controlled names): untrusted, so invisibles are
 * stripped; an absent/unparseable cache degrades to a placeholder.
 */
function describeParticipants(participantsJson: string | null): string {
  if (participantsJson === null) return "Unknown participants"
  let parsed: unknown
  try {
    parsed = JSON.parse(participantsJson)
  } catch {
    return "Unknown participants"
  }
  if (!Array.isArray(parsed)) return "Unknown participants"
  const refs: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const email = typeof record.email === "string" ? record.email.trim() : ""
    const name = typeof record.name === "string" ? record.name.trim() : ""
    if (email === "" && name === "") continue
    refs.push(email !== "" && name !== "" ? `${name} <${email}>` : name || email)
  }
  return refs.length > 0 ? cleanUntrusted(refs.join(", ")) : "Unknown participants"
}

/** One prompt-ready thread: its row plus the newest message (the body the
 * prompt carries). `latest` is null only if the thread lost its messages
 * underneath the list read. */
interface DigestThread {
  thread: ThreadRow
  latest: MessageRow | null
}

/** Format one thread as a marker-indexed prompt block. Subject, name and
 * body are untrusted email content: invisibles are stripped first. */
function formatPromptThread(entry: DigestThread, index: number): string {
  const subject = cleanUntrusted(
    entry.thread.subject?.trim() || "(no subject)"
  )
  const body = cleanUntrusted(
    (entry.latest?.body_text ?? entry.latest?.snippet ?? "").trim()
  ).slice(0, MAX_THREAD_CHARS)
  return [
    `[${index}] Subject: ${subject}`,
    `Participants: ${describeParticipants(entry.thread.participants)}`,
    "",
    body,
  ].join("\n")
}

/** Shape-check a cache hit before serving it (the row is service-written
 * JSON; a corrupt row regenerates instead of failing the view). */
function isDigestResult(value: unknown): value is DigestResult {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.digest === "string" &&
    typeof record.threadCount === "number" &&
    typeof record.omittedCount === "number"
  )
}

/**
 * Build the unread digest for one scope (task 6). Loads the scope's
 * unread threads (newest first, capped at DIGEST_MAX_THREADS), consults
 * the folder-digest cache, and on a miss asks the active provider
 * (surface "folderDigest" — the per-surface toggle and rate limiter
 * apply). Resolves null when the scope has no unread threads (no provider
 * call, no cache write); transport/gating failures throw — see the module
 * doc for the contract.
 *
 * Executor-first: production callers pass getExecutor(); tests pass the
 * node:sqlite test executor.
 */
export async function buildFolderDigest(
  executor: SqlExecutor,
  options: DigestOptions
): Promise<DigestResult | null> {
  const unread = await loadUnreadThreads(executor, options.scope)
  if (unread.length === 0) {
    // Zero unread in scope: nothing to brief — no provider round-trip,
    // no cache write (the UI hides the affordance; null is the backstop).
    return null
  }

  // One resolution for the whole flow (task 2.2): `runtime.model` is the
  // tier-resolved id, used for BOTH the cache identity below and the
  // request (AiChatArgs.model).
  const runtime = await resolveSurfaceRuntime(executor, "folderDigest")
  if (!runtime) {
    // Unreachable through the UI (the affordance hides itself when this
    // is null) — kept as the fail-toward-off guard, matching client.ts.
    throw new AiUnavailableError("not-configured")
  }

  // Design D4 identity: kind + provider/model + scope key + the unread
  // thread-id SET (order-normalized by sorting). Reading a thread drops
  // it from the set — that change of membership IS the invalidation —
  // and so is a tier-model switch, the resolved model being part of
  // every key.
  const identity = {
    provider: runtime.provider,
    model: runtime.model,
    kind: CACHE_KIND,
    input: `${scopeKey(options.scope)}\n${unread
      .map((thread) => thread.id)
      .sort()
      .join(",")}`,
  }

  const cached = await getAiCache(executor, identity)
  if (cached !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(cached)
    } catch {
      parsed = null
    }
    if (isDigestResult(parsed)) {
      // Returned VERBATIM — not recomputed against current state: the
      // cached briefing must be the exact text the user saw before, with
      // the counts it was generated from (task 6.2).
      return parsed
    }
    // Corrupt row: fall through and regenerate (and overwrite below).
  }

  const capped = unread.slice(0, DIGEST_MAX_THREADS)
  const omittedCount = unread.length - capped.length

  // Only the covered threads' bodies are loaded — the identity needs the
  // ids alone, so a cache hit never pays for the per-thread reads.
  const details: DigestThread[] = []
  for (const thread of capped) {
    const loaded = await getThreadWithMessages(executor, thread.id)
    const messages = loaded?.messages ?? []
    details.push({ thread, latest: messages[messages.length - 1] ?? null })
  }

  const tail =
    omittedCount > 0
      ? [
          `${omittedCount} further unread threads are not listed; end the ` +
            `briefing with the exact line "…and ${omittedCount} more unread ` +
            'threads not covered."',
        ]
      : []

  const digest = await aiChat({
    // The exact model the identity above was built from (task 2.2).
    model: runtime.model,
    // Task 2.6: output-language directive, absent when unset — the
    // briefing is user-visible prose, like the summaries surface.
    system: withOutputLanguage(
      SYSTEM_PROMPT,
      await getOutputLanguage(executor)
    ),
    messages: [
      {
        role: "user",
        content: [
          "Write the unread-mail briefing for this mailbox view.",
          "Threads are marked [1], [2], … newest first.",
          ...tail,
          "",
          // The threads are untrusted email content: fenced so the model
          // knows where the data ends (fenceThread also strips any fence
          // markers the bodies forge).
          fenceThread(
            details
              .map((entry, index) => formatPromptThread(entry, index + 1))
              .join("\n\n")
          ),
        ].join("\n"),
      },
    ],
    maxTokens: 1024,
    surface: "folderDigest",
  })

  const result: DigestResult = {
    digest,
    threadCount: capped.length,
    omittedCount,
  }

  // Cache the whole DigestResult under the SAME identity: an unchanged
  // unread set re-opens hit it instantly (spec "reopening it unchanged
  // makes no provider call"); a changed set is a new row (the old one
  // stays, harmless, purged with the account). Provenance: the folder
  // scope's account; a cross-account category scope derives from no one
  // account.
  await putAiCache(executor, {
    ...identity,
    output: JSON.stringify(result),
    accountId:
      options.scope.kind === "accountFolder" ? options.scope.accountId : null,
  })

  return result
}
