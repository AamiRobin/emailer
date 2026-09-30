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
 * AI event extraction (tasks 2.1/2.2, add-ai-surfaces spec "Event
 * extraction to calendar", design D1) — the prompt/parsing half of the
 * surface, cloned from the task-extraction contract. Given a thread, asks
 * the active provider for the conversation's EXPLICIT events (meetings,
 * appointments, travel, dated deadlines) and returns them as review-ready
 * suggestions; the review dialog owns the accept step, which opens the
 * prefilled event form — nothing is created without the user saving it.
 *
 * Result shape (mirroring task extraction): `extractEvents` RESOLVES with
 * `{ suggestions, warning? }` instead of throwing on model-output
 * problems. Malformed model replies fail toward "no suggestions" —
 * `{ suggestions: [], warning }` — so the dialog can render the warning
 * inline (with Retry) without a thrown-error path for what is a
 * predictable provider misbehavior. The legitimate "no events in this
 * conversation" case is `{ suggestions: [] }` with NO warning. Transport/
 * gating failures still THROW: `AiProviderError` (the dialog's inline
 * error + Retry) and `AiUnavailableError` (not configured / surface
 * disabled — the toolbar hides the affordance in that case, so this is
 * defensive only).
 *
 * Parsing is tolerant by design: code fences are stripped, prose around
 * the JSON object is ignored (first "{" .. last "}"), per-event fields are
 * individually validated, and bad events are DROPPED rather than failing
 * the batch. A `messageIndex` that does not resolve to a thread message
 * drops the event (we never guess a source). Dates must be "YYYY-MM-DD
 * HH:mm" with calendar-plausible components (month 1-12, day 1-31, hour
 * 0-23, minute 0-59 — rollovers like month 13 are rejected, not
 * normalized) inside the same sane year window task extraction uses; an
 * invalid START drops the event while an invalid END drops just the end —
 * a bogus end must not lose the event. An end at or before the start is
 * dropped too (no zero-length events). `allDay: true` ignores the time
 * semantics: the start normalizes to local midnight and no end is
 * exported.
 *
 * Time interpretation (design D1): the model's "YYYY-MM-DD HH:mm" is
 * LOCAL WALL-CLOCK, converted to unix seconds here — mail rarely states
 * timezones unambiguously, and the user reviews every field in the event
 * form before saving, so local wall-clock is the honest interpretation.
 *
 * Caching (task 2.2, mirroring task extraction / design D2): kind
 * "event-extraction", keyed on the thread's message-id set (the
 * chronological ids that ARE the prompt input — any added/removed message
 * changes the key) plus the active provider/model. The RAW model output is
 * cached (parse improvements keep applying to cached content);
 * read-before-call, write-after. Rows carry the thread's account_id as
 * provenance so account removal purges them.
 *
 * Data boundary (spec "AI consent and data boundaries"): the prompt sends
 * only the invoked thread's own messages (from header, date, subject,
 * plain-text body — capped per message) and nothing else.
 */

/** One review-ready event suggestion extracted from the thread. */
export interface EventSuggestion {
  /** Short event title. */
  title: string
  /** Event start, unix seconds — the model's wall-clock read as LOCAL. */
  startAt: number
  /** Event end, unix seconds (local). Absent when all-day or unstated. */
  endAt?: number
  /** True when the message states a date without a usable time. */
  allDay: boolean
  /** Optional where/online link stated in the message. */
  location?: string
  /** Optional extra context from the message. */
  notes?: string
  /** The thread message the event came from (the back-link). */
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
 * "no events in this conversation" case — the empty array alone).
 */
export interface EventExtractionResult {
  suggestions: EventSuggestion[]
  warning?: string
}

/** The ai_cache kind for this surface (task 2.2, design D1). */
const CACHE_KIND = "event-extraction"

/** Per-message body cap in the prompt — bounds tokens on long mail. */
const MAX_BODY_CHARS = 4000

/** Year sanity window for parsed dates; outside it the field is dropped. */
const MIN_EVENT_YEAR = 1970
const MAX_EVENT_YEAR = 2100

/** Warning shown when the reply contained no parseable events object. */
const PARSE_WARNING =
  "The model's reply could not be read as event suggestions. Try again."
/** Warning when the reply held events but none mapped to a message. */
const UNMAPPABLE_WARNING =
  "The model suggested events, but none could be traced to a message in this conversation."

const SYSTEM_PROMPT = [
  "You extract calendar events from email conversations.",
  "Identify ONLY events explicitly stated in the conversation:",
  "meetings, appointments, travel or other dated occurrences someone",
  "announced or committed to.",
  "Do not invent events; do not list vague topics, possibilities or FYIs.",
  "Reply with a STRICT JSON object and nothing else — no prose, no markdown fences.",
  "The object has exactly this shape:",
  '{"events": [{"title": string, "start": "YYYY-MM-DD HH:mm", "end": "YYYY-MM-DD HH:mm" | null, "allDay": boolean, "location": string | null, "notes": string | null, "messageIndex": number}]}',
  '- "title": a short name for the event.',
  '- "start": the start as YYYY-MM-DD HH:mm, local time; for all-day events use 00:00.',
  '- "end": the end in the same form when the message states one, otherwise null.',
  '- "allDay": true when the message states a date without a time, otherwise false.',
  '- "location": where the event takes place, otherwise null.',
  '- "notes": optional one-line context for the event, otherwise null.',
  '- "messageIndex": the 0-based [N] marker of the message the event came from.',
  'Return {"events": []} when the conversation contains no events.',
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
 * object slice below finds the JSON either way.
 */
function stripCodeFences(text: string): string {
  return text.replace(/```[a-zA-Z]*\s*/g, "").trim()
}

/**
 * Extract the JSON object from a (fence-stripped) reply, ignoring any
 * surrounding prose: everything from the first "{" to the last "}".
 * Throws when no object-shaped region exists or the slice is not JSON —
 * both cases are the parse-failure warning path.
 */
function parseJsonObject(reply: string): unknown {
  const text = stripCodeFences(reply)
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) {
    throw new Error("no JSON object in model reply")
  }
  return JSON.parse(text.slice(start, end + 1))
}

/** The calendar components of one parsed "YYYY-MM-DD HH:mm" string. */
interface ParsedDateTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

/**
 * Parse the model's "YYYY-MM-DD HH:mm" into its components, or undefined
 * when absent/invalid. Every component must be calendar-plausible (month
 * 1-12, day 1-31, hour 0-23, minute 0-59 — no rollover normalization) and
 * the year inside the same sane window task extraction applies to dues.
 */
function parseEventDateTime(raw: unknown): ParsedDateTime | undefined {
  if (typeof raw !== "string") return undefined
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2})$/.exec(
    raw.trim()
  )
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  if (
    year < MIN_EVENT_YEAR ||
    year > MAX_EVENT_YEAR ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59
  ) {
    return undefined
  }
  return { year, month, day, hour, minute }
}

/** Local wall-clock components → unix seconds (design D1). */
function localUnixSeconds(parts: ParsedDateTime): number {
  return Math.floor(
    new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute
    ).getTime() / 1000
  )
}

/** Local midnight of a parsed date, as unix seconds (the all-day start). */
function localMidnightSeconds(parts: ParsedDateTime): number {
  return Math.floor(
    new Date(parts.year, parts.month - 1, parts.day).getTime() / 1000
  )
}

/** The raw event shape the prompt asks the model for. */
interface RawEvent {
  title?: unknown
  start?: unknown
  end?: unknown
  allDay?: unknown
  location?: unknown
  notes?: unknown
  messageIndex?: unknown
}

function isRawEvent(value: unknown): value is RawEvent {
  return typeof value === "object" && value !== null
}

/** A trimmed non-empty string field, or undefined. */
function optionalText(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() !== ""
    ? raw.trim()
    : undefined
}

/**
 * Map the parsed model events array onto thread messages. Invalid events
 * and out-of-range indexes are dropped silently (documented in the module
 * doc); returns the kept suggestions plus whether the model HAD claimed
 * any events (drives the "nothing mappable" warning).
 */
function mapEvents(
  parsed: unknown[],
  messages: MessageRow[]
): { suggestions: EventSuggestion[]; modelClaimedAny: boolean } {
  const suggestions: EventSuggestion[] = []
  for (const entry of parsed) {
    if (!isRawEvent(entry)) continue
    const title = optionalText(entry.title)
    if (title === undefined) continue
    const index = entry.messageIndex
    const message =
      typeof index === "number" && Number.isInteger(index)
        ? messages[index]
        : undefined
    if (!message) continue
    // The start carries the event: an invalid one drops the suggestion.
    const start = parseEventDateTime(entry.start)
    if (!start) continue
    const allDay = entry.allDay === true
    const location = optionalText(entry.location)
    const notes = optionalText(entry.notes)
    let endAt: number | undefined
    if (!allDay) {
      const end = parseEventDateTime(entry.end)
      if (end) {
        const endSeconds = localUnixSeconds(end)
        const startSeconds = localUnixSeconds(start)
        // An end at or before the start is a model mistake — drop just
        // the end, the event survives as start-only.
        if (endSeconds > startSeconds) endAt = endSeconds
      }
    }
    suggestions.push({
      title,
      // All-day events ignore the time semantics: local midnight start,
      // no end exported.
      startAt: allDay
        ? localMidnightSeconds(start)
        : localUnixSeconds(start),
      ...(endAt !== undefined ? { endAt } : {}),
      allDay,
      ...(location !== undefined ? { location } : {}),
      ...(notes !== undefined ? { notes } : {}),
      messageId: message.id,
      messageDate: message.date,
      messageFrom: describeSender(message),
    })
  }
  return { suggestions, modelClaimedAny: parsed.length > 0 }
}

/** Parse a (cached or fresh) raw model reply against the thread messages. */
function toResult(reply: string, messages: MessageRow[]): EventExtractionResult {
  let parsed: unknown
  try {
    parsed = parseJsonObject(reply)
  } catch {
    return { suggestions: [], warning: PARSE_WARNING }
  }
  // The reply must carry the {"events": [...]} envelope; a JSON object
  // without it cannot be read as event suggestions (the same
  // parse-failure path as no JSON at all).
  const events =
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as { events?: unknown }).events)
      ? ((parsed as { events: unknown[] }).events)
      : undefined
  if (!events) {
    return { suggestions: [], warning: PARSE_WARNING }
  }
  const { suggestions, modelClaimedAny } = mapEvents(events, messages)
  if (suggestions.length === 0 && modelClaimedAny) {
    return { suggestions: [], warning: UNMAPPABLE_WARNING }
  }
  return { suggestions }
}

/**
 * Extract event suggestions from one thread for review (task 2.1). Loads
 * the thread's chronological messages, consults the event-extraction
 * cache, and on a miss asks the active provider (surface
 * "eventExtraction" — the per-surface toggle and rate limiter apply).
 * Throws on transport/gating failures (typed `AiProviderError` /
 * `AiUnavailableError`); resolves with a warning instead of throwing when
 * the model's reply cannot be honored — see the module doc for the
 * decision and the dropping rules.
 *
 * Executor-first: production callers pass getExecutor(); tests pass the
 * node:sqlite test executor.
 */
export async function extractEvents(
  executor: SqlExecutor,
  threadId: string
): Promise<EventExtractionResult> {
  const loaded = await getThreadWithMessages(executor, threadId)
  const messages = loaded?.messages ?? []
  if (messages.length === 0) {
    // Nothing to extract from (empty/unknown thread): succeed empty with
    // no provider round-trip and nothing cached.
    return { suggestions: [] }
  }

  // One resolution for the whole flow (mirroring task extraction):
  // `runtime.model` is the tier-resolved id, used for BOTH the cache
  // identity below and the request (AiChatArgs.model).
  const runtime = await resolveSurfaceRuntime(executor, "eventExtraction")
  if (!runtime) {
    // Unreachable through the UI (the toolbar hides itself when this is
    // null) — kept as the fail-toward-off guard, matching client.ts.
    throw new AiUnavailableError("not-configured")
  }

  // Design D1 identity: kind + provider/model + the message-id set (in
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
          "Extract the calendar events from this email conversation.",
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
    surface: "eventExtraction",
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
