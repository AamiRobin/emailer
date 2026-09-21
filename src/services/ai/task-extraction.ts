import type { SqlExecutor } from "../db/executor"
import type { MessageRow } from "../db/messages"
import { getThreadWithMessages } from "../db/threads"
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
 * AI task extraction (task 4.8, ai-assistance spec "Task extraction",
 * design D2) — the prompt/parsing half of the surface. Given a thread,
 * asks the active provider for the conversation's EXPLICIT commitments and
 * returns them as review-ready suggestions; the review dialog owns the
 * accept step, and creation goes exclusively through the frozen
 * `services/tasks/create` seam (task 5.8 swaps its stub body).
 *
 * Result shape (decided): `extractTasks` RESOLVES with
 * `{ suggestions, warning? }` instead of throwing on model-output
 * problems. Malformed model replies fail toward "no suggestions" —
 * `{ suggestions: [], warning }` — so the dialog can render the warning
 * inline (with Retry) without a thrown-error path for what is a
 * predictable provider misbehavior. Transport/gating failures still
 * THROW: `AiProviderError` (kind network/status/parse/rate_limited —
 * the dialog's inline error + Retry) and `AiUnavailableError`
 * (not configured / surface disabled — the toolbar hides the affordance
 * in that case, so this is defensive only).
 *
 * Parsing is tolerant by design: code fences are stripped, prose around
 * the JSON array is ignored (first "[" .. last "]"), per-item fields are
 * individually validated, and bad items are DROPPED rather than failing
 * the batch. A `messageIndex` that does not resolve to a thread message
 * drops the suggestion (we never guess a source). A due date that fails
 * the "YYYY-MM-DD" shape, the calendar sanity check, or the year clamp is
 * dropped while the suggestion is KEPT — a bogus date must not lose the
 * task.
 *
 * Caching (task 4.3 service, design D2): kind "task-extraction", keyed on
 * the thread's message-id set (the chronological ids that ARE the prompt
 * input — any added/removed message changes the key, satisfying the spec's
 * "new messages invalidate" requirement) plus the active provider/model.
 * The RAW model output is cached (like every surface — parse improvements
 * keep applying to cached content); read-before-call, write-after.
 * Rows carry the thread's account_id as provenance so account removal
 * purges them ("Account removal clears cache").
 *
 * Data boundary (spec "AI consent and data boundaries"): the prompt sends
 * only the invoked thread's own messages (from header, date, subject,
 * plain-text body — capped per message) and nothing else.
 */

/** One review-ready suggestion extracted from the thread. */
export interface TaskSuggestion {
  /** Short imperative task title. */
  title: string
  /** Optional extra context from the message. */
  notes?: string
  /** Optional due date, unix seconds (UTC midnight of the model's date). */
  dueAt?: number
  /** The thread message the suggestion came from (the back-link). */
  messageId: string
  /** The source message's date, unix seconds (for the review line). */
  messageDate: number
  /** The source message's sender, formatted for display. */
  messageFrom: string
}

/**
 * The extraction outcome: parsed suggestions plus an optional human-
 * readable warning when the model's reply could only be partially (or not
 * at all) honored. No warning = clean result (including the legitimate
 * "no action items in this conversation" case — the empty array alone).
 */
export interface TaskExtractionResult {
  suggestions: TaskSuggestion[]
  warning?: string
}

/** The ai_cache kind for this surface (design D2). */
const CACHE_KIND = "task-extraction"

/** Per-message body cap in the prompt — bounds tokens on long mail. */
const MAX_BODY_CHARS = 4000

/** Year sanity window for parsed due dates; outside it the due is dropped. */
const MIN_DUE_YEAR = 1970
const MAX_DUE_YEAR = 2100

/** Warning shown when the reply contained no parseable JSON array. */
const PARSE_WARNING =
  "The model's reply could not be read as task suggestions. Try again."
/** Warning when the reply held suggestions but none mapped to a message. */
const UNMAPPABLE_WARNING =
  "The model suggested tasks, but none could be traced to a message in this conversation."

const SYSTEM_PROMPT = [
  "You extract action items from email conversations.",
  "Identify ONLY explicit commitments and action items stated in the conversation:",
  "tasks someone said they would do, or explicitly asked someone to do.",
  "Do not invent tasks; do not list vague topics, FYIs or newsletter items.",
  "Reply with a STRICT JSON array and nothing else — no prose, no markdown fences.",
  "Each element has exactly this shape:",
  '{"title": string, "notes"?: string, "due": "YYYY-MM-DD" | null, "messageIndex": number}',
  '- "title": a short imperative summary of the task.',
  '- "notes": optional one-line context for the task.',
  '- "due": the due date as YYYY-MM-DD when the message states one, otherwise null.',
  '- "messageIndex": the 0-based [N] marker of the message the item came from.',
  "Return [] when the conversation contains no action items.",
  // The fenced conversation below is attacker-controlled: state the fence
  // contract (same line every fencing surface carries).
  UNTRUSTED_THREAD_NOTICE,
].join("\n")

/** Format one message as a marker-indexed prompt block. Subject and body
 * are untrusted email content: invisibles are stripped first. */
function formatPromptMessage(message: MessageRow, index: number): string {
  const sender = describeSender(message)
  const date = new Date(message.date * 1000).toISOString().slice(0, 10)
  const subject = cleanUntrusted(message.subject?.trim() || "(no subject)")
  const body = cleanUntrusted(
    (message.body_text ?? message.snippet ?? "").trim()
  ).slice(0, MAX_BODY_CHARS)
  return [
    `[${index}] From: ${sender}`,
    `Date: ${date}`,
    `Subject: ${subject}`,
    "",
    body,
  ].join("\n")
}

/** Display identity of a message's sender (never empty). */
function describeSender(message: MessageRow): string {
  const name = message.from_name?.trim()
  const address = message.from_address?.trim()
  if (name && address) return `${name} <${address}>`
  return name ?? address ?? "Unknown sender"
}

/**
 * Strip markdown code fences (a model habit even when told not to) so the
 * array slice below finds the JSON either way.
 */
function stripCodeFences(text: string): string {
  return text.replace(/```[a-zA-Z]*\s*/g, "").trim()
}

/**
 * Extract the JSON array from a (fence-stripped) reply, ignoring any
 * surrounding prose: everything from the first "[" to the last "]".
 * Throws when no array-shaped region exists or the slice is not JSON —
 * both callers treat as the parse-failure warning path.
 */
function parseJsonArray(reply: string): unknown {
  const text = stripCodeFences(reply)
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start === -1 || end <= start) {
    throw new Error("no JSON array in model reply")
  }
  return JSON.parse(text.slice(start, end + 1))
}

/**
 * Parse the model's "YYYY-MM-DD" due into unix seconds (UTC midnight),
 * or undefined when absent/invalid/out of the sane year window. Month and
 * day must be calendar-plausible (1-12 / 1-31) — rollovers like month 13
 * are rejected, not normalized.
 */
function parseDueAt(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim())
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (
    year < MIN_DUE_YEAR ||
    year > MAX_DUE_YEAR ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return undefined
  }
  return Date.UTC(year, month - 1, day) / 1000
}

/** The raw item shape the prompt asks the model for. */
interface RawSuggestion {
  title: unknown
  notes?: unknown
  due?: unknown
  messageIndex?: unknown
}

function isRawSuggestion(value: unknown): value is RawSuggestion {
  return typeof value === "object" && value !== null
}

/**
 * Map the parsed model array onto thread messages. Invalid items and
 * out-of-range indexes are dropped silently (documented in the module
 * doc); returns the kept suggestions plus whether the model HAD claimed
 * any items (drives the "nothing mappable" warning).
 */
function mapSuggestions(
  parsed: unknown,
  messages: MessageRow[]
): { suggestions: TaskSuggestion[]; modelClaimedAny: boolean } {
  if (!Array.isArray(parsed)) {
    return { suggestions: [], modelClaimedAny: false }
  }
  const suggestions: TaskSuggestion[] = []
  for (const entry of parsed) {
    if (!isRawSuggestion(entry)) continue
    const title =
      typeof entry.title === "string" ? entry.title.trim() : ""
    if (title === "") continue
    const index = entry.messageIndex
    const message =
      typeof index === "number" && Number.isInteger(index)
        ? messages[index]
        : undefined
    if (!message) continue
    const notes =
      typeof entry.notes === "string" && entry.notes.trim() !== ""
        ? entry.notes.trim()
        : undefined
    const dueAt = parseDueAt(entry.due)
    suggestions.push({
      title,
      ...(notes !== undefined ? { notes } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
      messageId: message.id,
      messageDate: message.date,
      messageFrom: describeSender(message),
    })
  }
  return { suggestions, modelClaimedAny: parsed.length > 0 }
}

/** Parse a (cached or fresh) raw model reply against the thread messages. */
function toResult(
  reply: string,
  messages: MessageRow[]
): TaskExtractionResult {
  let parsed: unknown
  try {
    parsed = parseJsonArray(reply)
  } catch {
    return { suggestions: [], warning: PARSE_WARNING }
  }
  const { suggestions, modelClaimedAny } = mapSuggestions(parsed, messages)
  if (suggestions.length === 0 && modelClaimedAny) {
    return { suggestions: [], warning: UNMAPPABLE_WARNING }
  }
  return { suggestions }
}

/**
 * Extract task suggestions from one thread for review (task 4.8). Loads
 * the thread's chronological messages, consults the task-extraction
 * cache, and on a miss asks the active provider (surface
 * "taskExtraction" — the per-surface toggle and rate limiter apply).
 * Throws on transport/gating failures (typed `AiProviderError` /
 * `AiUnavailableError`); resolves with a warning instead of throwing when
 * the model's reply cannot be honored — see the module doc for the
 * decision and the dropping rules.
 *
 * Executor-first: production callers pass getExecutor(); tests pass the
 * node:sqlite test executor.
 */
export async function extractTasks(
  executor: SqlExecutor,
  threadId: string
): Promise<TaskExtractionResult> {
  const loaded = await getThreadWithMessages(executor, threadId)
  const messages = loaded?.messages ?? []
  if (messages.length === 0) {
    // Nothing to extract from (empty/unknown thread): succeed empty with
    // no provider round-trip and nothing cached.
    return { suggestions: [] }
  }

  // One resolution for the whole flow (task 2.2): `runtime.model` is the
  // tier-resolved id, used for BOTH the cache identity below and the
  // request (AiChatArgs.model).
  const runtime = await resolveSurfaceRuntime(executor, "taskExtraction")
  if (!runtime) {
    // Unreachable through the UI (the toolbar hides itself when this is
    // null) — kept as the fail-toward-off guard, matching client.ts.
    throw new AiUnavailableError("not-configured")
  }

  // Design D2 identity: kind + provider/model + the message-id set (in
  // prompt order). Any thread mutation changes the set and invalidates —
  // and so does a tier-model switch, the resolved model being part of
  // every key.
  const identity = {
    provider: runtime.provider,
    model: runtime.model,
    kind: CACHE_KIND,
    input: messages.map((message) => message.id).join(","),
  }

  const cached = await getAiCache(executor, identity)
  if (cached !== null) {
    return toResult(cached, messages)
  }

  const reply = await aiChat({
    // The exact model the identity above was built from (task 2.2).
    model: runtime.model,
    // Task 2.6: output-language directive, absent when unset.
    system: withOutputLanguage(
      SYSTEM_PROMPT,
      await getOutputLanguage(executor)
    ),
    messages: [
      {
        role: "user",
        content: [
          "Extract the action items from this email conversation.",
          "Messages are marked [0], [1], … in chronological order.",
          "",
          // The conversation is untrusted email content: fenced so the
          // model knows where the data ends (fenceThread also strips any
          // fence markers the bodies forge).
          fenceThread(
            messages
              .map((message, index) => formatPromptMessage(message, index))
              .join("\n")
          ),
        ].join("\n"),
      },
    ],
    maxTokens: 1024,
    surface: "taskExtraction",
  })

  // Cache the RAW reply: re-parses stay cheap and parser improvements
  // apply to cached content without a provider re-call.
  await putAiCache(executor, {
    ...identity,
    output: reply,
    accountId: loaded?.thread.account_id ?? null,
  })

  return toResult(reply, messages)
}
