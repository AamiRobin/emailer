import type { SqlExecutor } from "../db/executor"
import type { MessageRow } from "../db/messages"
import { getThreadWithMessages } from "../db/threads"
import { getAiCache, putAiCache } from "./cache"
import { aiChat, resolveSurfaceRuntime } from "./client"
import {
  cleanUntrusted,
  fenceThread,
  UNTRUSTED_THREAD_NOTICE,
  withOutputLanguage,
} from "./prompt"
import {
  loadStyleProfile,
  type StyleProfile,
} from "./style-profile"
import { getOutputLanguage, isAiConfigured, isSurfaceEnabled } from "./settings"

/**
 * Smart replies (task 4.5, ai-assistance spec "Writing-style smart
 * replies", design D2) — the generation half of the surface. Given an open
 * thread, drafts ONE short reply consistent with the account's stored
 * writing-style profile (the 4.5 builder's artifact). The suggestion is
 * plain text returned to the caller; the reply-dialog inserts it into the
 * composer as an EDITABLE draft through the reply-opener contract —
 * nothing is ever sent automatically (spec "Nothing sends without the
 * user").
 *
 * Result contract (decided, matching style-profile.ts): NEVER throws —
 * every outcome resolves as a discriminated result. Gating folds into
 * reasons ("not-configured" / "surface-disabled" — the toolbar hides the
 * affordance for both, so these are defensive), a missing profile is the
 * typed "no-profile" (the dialog routes to its consent/build step), an
 * unknown thread is "no-thread", and transport failures come back as
 * "provider" with the message for the inline error + Retry affordance.
 *
 * Caching (task 4.3 service, design D2): kind "smart-reply", keyed on the
 * thread's message-id set in prompt order plus the LAST message's id —
 * a new message changes the set and the tail, so the key invalidates the
 * same way summaries do (spec "New messages … invalidate"). The profile's
 * builtAt is folded into the input too, so REBUILDING the profile also
 * invalidates: a cached suggestion must never predate the style it claims
 * to follow. The RAW reply text is cached (like every surface); rows carry
 * the thread's account_id as provenance for the account-removal purge.
 * `regenerate: true` bypasses the read and overwrites the row — the next
 * plain request serves the fresh suggestion.
 *
 * Data boundary (spec "AI consent and data boundaries"): the prompt sends
 * only the invoked thread's last few messages (sender, date, subject,
 * capped body) plus the stored profile — nothing else.
 */

/** The ai_cache kind for this surface (task 4.5; design D2 open text). */
const CACHE_KIND = "smart-reply"

/** How many trailing messages of the thread form the context. */
const CONTEXT_MESSAGE_LIMIT = 6

/** Per-message body cap in the prompt — bounds tokens on long mail. */
const MAX_BODY_CHARS = 4000

export type SmartReplyFailureReason =
  | "not-configured"
  | "surface-disabled"
  | "no-profile"
  | "no-thread"
  | "provider"

export type SmartReplyResult =
  | { ok: true; reply: string; cached: boolean }
  | { ok: false; reason: SmartReplyFailureReason; message?: string }

export interface GenerateSmartReplyOptions {
  /** Skip the cache read and overwrite the cached row (Regenerate). */
  regenerate?: boolean
}

const SYSTEM_PROMPT = [
  "You draft email replies that imitate the author's personal writing style,",
  "described in the STYLE PROFILE below. Follow it closely: its tone,",
  "formality, typical length, greetings, sign-offs and phrasing habits.",
  "Draft a SHORT reply to the last message of the conversation — reply only",
  "to what needs answering; do not summarize the thread.",
  "Return ONLY the reply body text itself: no subject line, no preamble, no",
  "explanations, no quotation of the original message, and do not wrap it",
  "in quotation marks. Separate paragraphs with blank lines.",
  // The fenced conversation below is attacker-controlled: state the fence
  // contract (same line every fencing surface carries).
  UNTRUSTED_THREAD_NOTICE,
].join("\n")

/** The style profile as the system prompt sees it (stable serialized shape). */
function formatProfile(profile: StyleProfile): string {
  return [
    "STYLE PROFILE:",
    JSON.stringify(profile, null, 2),
  ].join("\n")
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

/**
 * Draft one style-matched reply for an open thread (task 4.5, spec
 * scenario "Generate a style-matched suggestion"). Requires a stored
 * writing-style profile for `accountId` (typed "no-profile" otherwise —
 * the dialog's consent step builds it first). Executor-first: production
 * callers pass getExecutor(); tests pass the node:sqlite test executor.
 */
export async function generateSmartReply(
  executor: SqlExecutor,
  accountId: string,
  threadId: string,
  options: GenerateSmartReplyOptions = {}
): Promise<SmartReplyResult> {
  if (!(await isAiConfigured(executor))) {
    return { ok: false, reason: "not-configured" }
  }
  if (!(await isSurfaceEnabled(executor, "smartReplies"))) {
    return { ok: false, reason: "surface-disabled" }
  }

  const stored = await loadStyleProfile(executor, accountId)
  if (!stored) {
    return { ok: false, reason: "no-profile" }
  }

  const loaded = await getThreadWithMessages(executor, threadId)
  const messages = loaded?.messages ?? []
  if (messages.length === 0) {
    return { ok: false, reason: "no-thread" }
  }

  // One resolution for the whole flow (task 2.2): `runtime.model` is the
  // tier-resolved id, used for BOTH the cache identity below and the
  // request (AiChatArgs.model).
  const runtime = await resolveSurfaceRuntime(executor, "smartReplies")
  if (!runtime) {
    // isAiConfigured reads the same state — defensive fail-toward-off.
    return { ok: false, reason: "not-configured" }
  }

  // The context: the thread's last few messages, chronological, the last
  // one marked as the reply target.
  const context = messages.slice(-CONTEXT_MESSAGE_LIMIT)
  const lastMessage = messages[messages.length - 1]

  // Design D2 identity: kind + provider/model + the message-id set in
  // prompt order + the last message id + the profile's builtAt (a rebuilt
  // profile invalidates — see the module doc). The model is the resolved
  // one, so a tier-model switch invalidates too.
  const identity = {
    provider: runtime.provider,
    model: runtime.model,
    kind: CACHE_KIND,
    input: [
      ...messages.map((message) => message.id),
      lastMessage.id,
      String(stored.builtAt),
    ].join(","),
  }

  if (!options.regenerate) {
    const cached = await getAiCache(executor, identity)
    if (cached !== null) {
      return { ok: true, reply: cached, cached: true }
    }
  }

  let reply: string
  try {
    reply = await aiChat({
      // The exact model the identity above was built from (task 2.2).
      model: runtime.model,
      // Task 2.6: the output-language directive appends after the style
      // profile — additive to the surface's own instructions, absent when
      // the language is unset.
      system: withOutputLanguage(
        `${SYSTEM_PROMPT}\n\n${formatProfile(stored.profile)}`,
        await getOutputLanguage(executor)
      ),
      messages: [
        {
          role: "user",
          content: [
            "Conversation so far, chronological:",
            "",
            // The conversation is untrusted email content: fenced so the
            // model knows where the data ends (fenceThread also strips
            // any fence markers the bodies forge).
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
      maxTokens: 512,
      surface: "smartReplies",
    })
  } catch (error) {
    return {
      ok: false,
      reason: "provider",
      message: error instanceof Error ? error.message : String(error),
    }
  }

  const trimmed = reply.trim()
  if (trimmed === "") {
    return {
      ok: false,
      reason: "provider",
      message: "The model returned an empty reply. Try again.",
    }
  }

  // Cache the raw text under the SAME identity even on a regenerate pass —
  // the overwrite is what makes the fresh suggestion the cached one.
  await putAiCache(executor, {
    ...identity,
    output: trimmed,
    accountId: loaded?.thread.account_id ?? null,
  })

  return { ok: true, reply: trimmed, cached: false }
}
