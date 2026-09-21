import type { SqlExecutor } from "../db/executor"
import { getExecutor } from "../db/executor"
import type { MessageRow } from "../db/messages"
import { getThreadWithMessages } from "../db/threads"
import { getAiCache, putAiCache } from "./cache"
import {
  AiProviderError,
  AiUnavailableError,
  aiChat,
  resolveSurfaceRuntime,
} from "./client"
import {
  cleanUntrusted,
  fenceThread,
  UNTRUSTED_THREAD_NOTICE,
  withOutputLanguage,
} from "./prompt"
import { getOutputLanguage } from "./settings"

/**
 * AI compose-from-prompt + generate-reply (batch C3, Shortwave-style
 * "write me an email" surfaces with our safety semantics). Two composer
 * entry points, one service module:
 *
 * - `generateDraftFromPrompt`: the user's typed instruction becomes a NEW
 *   message body (blank-slate compose only — the composer disables the
 *   affordance in reply/forward where the transforms cover editing). The
 *   instruction is the USER'S OWN typed input, so it enters the prompt
 *   verbatim — no untrusted-text treatment (prompt.ts: the user is
 *   trusted for their own words).
 * - `generateReplyForThread`: a full reply draft generated from the reply
 *   target thread. The conversation is ATTACKER-CONTROLLED data: it is
 *   cleaned (cleanUntrusted) and fenced per the shared fence contract
 *   (fenceThread + UNTRUSTED_THREAD_NOTICE), exactly like the summaries /
 *   smart-replies surfaces.
 *
 * Gating + caching follow the single-resolution pattern (smart-replies /
 * summaries): `resolveSurfaceRuntime` runs ONCE per request — the
 * resolved tier model keys the ai_cache identity AND rides the
 * `aiChat` request (a tier-model switch therefore invalidates). Both
 * surfaces gate and bill under the EXISTING `composeTransform` surface id
 * (composer writing = the intelligent tier, spec's quality-critical
 * bucket) — no new wire name, no limiter change.
 *
 * Errors propagate as the shared client's typed exceptions so the
 * composer's pending bar can offer Retry: `AiUnavailableError` (surface
 * off mid-session — the UI hides the affordance for that) and
 * `AiProviderError` (network/status/parse/rate_limited/config). An empty
 * completion is a parse failure. `regenerate: true` bypasses the cache
 * read and overwrites the row — Retry regenerates instead of re-serving
 * the cached answer.
 *
 * Results are plain text; the composer converts them to editor HTML
 * through the transform's `transformedTextToHtml` and only ever applies
 * them through the pending-replacement accept flow — never directly.
 */

/** The ai_cache kind for prompt-drafted bodies. */
const DRAFT_CACHE_KIND = "compose-draft"
/** The ai_cache kind for generated reply drafts. */
const REPLY_CACHE_KIND = "compose-reply"

/** How many trailing messages of the thread form the reply context. */
const CONTEXT_MESSAGE_LIMIT = 6

/** Per-message body cap in the prompt — bounds tokens on long mail. */
const MAX_BODY_CHARS = 4000

/** Shared output contract: the answer is spliced into the draft verbatim,
 * so preamble/wrapper quotes would leak into the email. */
const OUTPUT_CONTRACT =
  "Return ONLY the message body text itself: no subject line, no preamble, " +
  "no explanations, no notes, and do not wrap it in quotation marks. " +
  "Separate paragraphs with blank lines."

const DRAFT_SYSTEM_PROMPT =
  "You are an email writing assistant. Write a complete email draft that " +
  "follows the instruction you are given: cover every point it asks for, " +
  "in a natural tone suited to the request. " +
  OUTPUT_CONTRACT

const REPLY_SYSTEM_PROMPT = [
  "You are an email writing assistant. Draft a reply to the conversation below.",
  "Reply only to what needs answering; do not summarize the thread.",
  // The fenced conversation below is attacker-controlled: state the fence
  // contract (same line every fencing surface carries).
  UNTRUSTED_THREAD_NOTICE,
  OUTPUT_CONTRACT,
].join("\n")

/** One service result: the plain-text body and whether the cache served it. */
export interface ComposeGenerateResult {
  text: string
  cached: boolean
}

export interface GenerateDraftFromPromptArgs {
  /** The user's instruction (their own words — enters the prompt as-is). */
  prompt: string
  /** Cache provenance (the composing account); never part of the key. */
  accountId?: string | null
  /** Skip the cache read and overwrite the row (Retry). */
  regenerate?: boolean
  /** Executor override (tests inject; production resolves getExecutor()). */
  executor?: SqlExecutor
}

/**
 * Draft a new message body from the user's instruction. Throws the shared
 * client's typed errors (AiUnavailableError / AiProviderError); resolves
 * with the trimmed plain-text draft.
 */
export async function generateDraftFromPrompt({
  prompt,
  accountId,
  regenerate,
  executor,
}: GenerateDraftFromPromptArgs): Promise<ComposeGenerateResult> {
  const db = executor ?? getExecutor()
  // One resolution for the whole flow: the tier-resolved model is BOTH
  // the cache identity's model and the request's model (task 2.2).
  const runtime = await resolveSurfaceRuntime(db, "composeTransform")
  if (!runtime) {
    throw new AiUnavailableError("not-configured")
  }
  const identity = {
    provider: runtime.provider,
    model: runtime.model,
    kind: DRAFT_CACHE_KIND,
    input: prompt,
  }
  if (!regenerate) {
    const cached = await getAiCache(db, identity)
    if (cached !== null) return { text: cached, cached: true }
  }
  const content = await aiChat({
    surface: "composeTransform",
    model: runtime.model,
    system: withOutputLanguage(
      DRAFT_SYSTEM_PROMPT,
      await getOutputLanguage(db)
    ),
    // The user's own instruction: trusted input, sent verbatim.
    messages: [{ role: "user", content: prompt }],
    // Email-scale output budget, same as the compose transforms.
    maxTokens: 2048,
  })
  const trimmed = content.trim()
  if (trimmed === "") {
    throw new AiProviderError(
      "parse",
      "The model returned an empty draft. Try again."
    )
  }
  await putAiCache(db, { ...identity, output: trimmed, accountId: accountId ?? null })
  return { text: trimmed, cached: false }
}

export interface GenerateReplyForThreadArgs {
  accountId: string
  /** The reply/forward source thread (composer mode's sourceThreadId). */
  threadId: string
  regenerate?: boolean
  /** Executor override (tests inject; production resolves getExecutor()). */
  executor?: SqlExecutor
}

/**
 * Draft a full reply from the reply target's thread. Same contract as
 * `generateDraftFromPrompt`; the thread context is the last few messages
 * (chronological, the last one marked), cleaned and fenced.
 */
export async function generateReplyForThread({
  accountId,
  threadId,
  regenerate,
  executor,
}: GenerateReplyForThreadArgs): Promise<ComposeGenerateResult> {
  const db = executor ?? getExecutor()
  const runtime = await resolveSurfaceRuntime(db, "composeTransform")
  if (!runtime) {
    throw new AiUnavailableError("not-configured")
  }
  const loaded = await getThreadWithMessages(db, threadId)
  const messages = loaded?.messages ?? []
  if (messages.length === 0) {
    throw new AiProviderError(
      "config",
      "The conversation is no longer available"
    )
  }

  // The context: the thread's last few messages, chronological, the last
  // one marked as the reply target.
  const context = messages.slice(-CONTEXT_MESSAGE_LIMIT)
  const lastMessage = messages[messages.length - 1]

  // Identity mirrors smart replies: the message-id set in prompt order
  // plus the last message's id — a new message changes the key.
  const identity = {
    provider: runtime.provider,
    model: runtime.model,
    kind: REPLY_CACHE_KIND,
    input: [...messages.map((message) => message.id), lastMessage.id].join(","),
  }
  if (!regenerate) {
    const cached = await getAiCache(db, identity)
    if (cached !== null) return { text: cached, cached: true }
  }

  // The shared client's typed errors (AiUnavailableError for a surface
  // disabled mid-session, AiProviderError for transport failures)
  // propagate unchanged — the pending bar maps them to Retry.
  const content = await aiChat({
    surface: "composeTransform",
    model: runtime.model,
    system: withOutputLanguage(
      REPLY_SYSTEM_PROMPT,
      await getOutputLanguage(db)
    ),
    messages: [
      {
        role: "user",
        content: [
          "Conversation so far, chronological:",
          "",
          // The conversation is untrusted email content: fenced so the
          // model knows where the data ends (fenceThread also strips any
          // fence markers the bodies forge).
          fenceThread(
            context
              .map((message) =>
                formatPromptMessage(message, message.id === lastMessage.id)
              )
              .join("\n")
          ),
        ].join("\n"),
      },
    ],
    maxTokens: 2048,
  })
  const trimmed = content.trim()
  if (trimmed === "") {
    throw new AiProviderError(
      "parse",
      "The model returned an empty draft. Try again."
    )
  }
  await putAiCache(db, {
    ...identity,
    output: trimmed,
    accountId: loaded?.thread.account_id ?? accountId,
  })
  return { text: trimmed, cached: false }
}

/** Display identity of a message's sender (never empty). */
function describeSender(message: MessageRow): string {
  const name = message.from_name?.trim()
  const address = message.from_address?.trim()
  if (name && address) return `${name} <${address}>`
  return name ?? address ?? "Unknown sender"
}

/** One conversation message as a prompt block (capped body). Subject and
 * body are untrusted email content: invisibles are stripped first. */
function formatPromptMessage(message: MessageRow, isLast: boolean): string {
  const date = new Date(message.date * 1000).toISOString().slice(0, 10)
  const subject = cleanUntrusted(message.subject?.trim() || "(no subject)")
  const body = cleanUntrusted(
    message.body_text?.trim() || message.snippet?.trim() || ""
  ).slice(0, MAX_BODY_CHARS)
  const marker = isLast ? " [LAST — reply to this one]" : ""
  return [
    `From: ${describeSender(message)}${marker}`,
    `Date: ${date}`,
    `Subject: ${subject}`,
    "",
    body,
  ].join("\n")
}
