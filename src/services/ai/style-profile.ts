import type { SqlExecutor } from "../db/executor"
import { placeholders } from "../db/executor"
import { findLabelsBySpecialUse } from "../db/labels"
import type { MessageRow } from "../db/messages"
import { getAccount } from "../db/accounts"
import {
  deleteWritingStyleProfile,
  getWritingStyleProfile,
  saveWritingStyleProfile,
} from "./writing-style"
import { isAiConfigured } from "./settings"
import { aiChat, type AiChatArgs } from "./client"

/**
 * Writing-style profile builder (task 4.5, ai-assistance spec "Writing-
 * style smart replies", design D2) — the analysis half of the surface.
 * Samples the account's recent SENT messages (threads filed under the
 * sent-role label, authored by the account's own address), asks the active
 * provider to distill their common style into a compact JSON profile, and
 * persists it through the 4.3 envelope store — the PROFILE is the cached
 * artifact here, not the samples: nothing about the sampled bodies is
 * stored, only the distilled style.
 *
 * Result contract (decided): `buildWritingStyleProfile` NEVER throws —
 * every outcome resolves as a discriminated result. Predictable local
 * conditions come back as typed reasons ("not-configured" — the spec's
 * fail-toward-off gate; "no-sent-mail" — nothing to analyze; "parse" —
 * the model's reply was not a readable profile; "provider" — the
 * transport failed, message carried for the inline error + Retry affordance
 * per spec "AI caching and failure handling"), so both consumers (the
 * Settings block and the reply dialog's consent step) render outcomes
 * without try/catch plumbing.
 *
 * Profile schema (owned by THIS module — task 4.5 took ownership from the
 * opaque 4.3 envelope): `{ version: 1, tone, formality, typicalLength,
 * greetings[], signOffs[], phrasing[] }`. The model's reply is normalized
 * field-by-field (unknown fields dropped, non-strings coerced away, arrays
 * trimmed to non-empty strings) so a sloppy-but-usable reply still yields
 * a well-formed profile, and the smart-reply prompt always serializes a
 * stable shape.
 *
 * Consent (spec: building SHALL clearly state that recent sent messages
 * are analyzed): the copy lives with the two affordances that trigger the
 * build — the reply dialog's consent card and the Settings → AI "Writing
 * style" block. Data boundary: the prompt sends only the sampled
 * messages' subject + body text (bodies capped per message), nothing else.
 */

/** The profile schema persisted in `writing_style_profiles.profile_json`. */
export interface StyleProfile {
  version: 1
  /** Overall tone, e.g. "warm, direct". */
  tone: string
  /** Formality level, e.g. "casual-professional". */
  formality: string
  /** Typical reply length, e.g. "short — two or three sentences". */
  typicalLength: string
  /** Greetings the author actually uses (e.g. "Hi NAME", "Hello"). */
  greetings: string[]
  /** Sign-offs the author actually uses (e.g. "Best,", "Thanks!"). */
  signOffs: string[]
  /** Other notable recurring phrasing habits. */
  phrasing: string[]
}

/** Why a build did not produce a profile. */
export type StyleProfileBuildFailure =
  | "not-configured"
  | "no-sent-mail"
  | "parse"
  | "provider"

export type StyleProfileBuildResult =
  | { ok: true; sampleSize: number }
  | { ok: false; reason: StyleProfileBuildFailure; message?: string }

/** Injectable seams (tests). Production callers omit everything. */
export interface StyleProfileBuildDeps {
  /** Transport override; defaults to the shared `aiChat` client. */
  chat?: (args: AiChatArgs) => Promise<string>
}

/** How many recent sent messages one build samples. */
export const STYLE_PROFILE_SAMPLE_LIMIT = 30
/** Per-message body cap in the prompt — bounds tokens on long mail. */
const MAX_BODY_CHARS = 2000
/** Array-field cap in the normalized profile — it is a digest, not a dump. */
const MAX_LIST_ENTRIES = 8

const SYSTEM_PROMPT = [
  "You analyze email messages a person wrote and distill their writing style",
  "into a compact profile that a reply assistant can imitate.",
  "Consider tone, formality, typical length, greetings, sign-offs and any",
  "notable recurring phrasing across ALL the messages.",
  "Reply with STRICT JSON and nothing else — no prose, no markdown fences.",
  "The JSON must have exactly this shape:",
  '{"tone": string, "formality": string, "typicalLength": string,',
  ' "greetings": string[], "signOffs": string[], "phrasing": string[]}',
  '- "tone": two or three words describing the overall tone.',
  '- "formality": e.g. "formal", "business-casual", "casual".',
  '- "typicalLength": how long the messages usually are.',
  '- "greetings": the greeting openers the writer actually uses ("{name}"',
  "  marks where a recipient's name goes).",
  '- "signOffs": the closing lines the writer actually uses.',
  '- "phrasing": up to a handful of other distinctive recurring habits.',
].join("\n")

/**
 * The account's recent sent messages, newest first. Sent = membership in a
 * sent-role label through EITHER membership model (gmail thread_labels vs
 * imap folder_label_id — the same predicate the folder lists use), limited
 * to messages the account itself authored (a gmail SENT thread carries the
 * label on the whole thread, so the received replies in it must not leak
 * into the style sample), trashed threads excluded.
 */
async function loadRecentSentMessages(
  executor: SqlExecutor,
  accountId: string,
  limit: number
): Promise<MessageRow[]> {
  const sentLabels = await findLabelsBySpecialUse(executor, accountId, "sent")
  if (sentLabels.length === 0) return []
  const labelIds = sentLabels.map((label) => label.id)
  const params: unknown[] = [accountId]
  const folderList = placeholders(labelIds.length, params.length + 1)
  params.push(...labelIds)
  const membershipList = placeholders(labelIds.length, params.length + 1)
  params.push(...labelIds)
  // The author filter uses the account's own address when known.
  const accountRow = await getAccount(executor, accountId)
  const selfEmail = accountRow?.email?.trim() ?? ""
  const authorFilter = selfEmail
    ? " AND LOWER(m.from_address) = LOWER($" +
      (params.length + 1) +
      ")"
    : ""
  if (selfEmail) params.push(selfEmail)
  params.push(limit)
  return executor.select<MessageRow>(
    `SELECT m.* FROM messages m
     JOIN threads t ON t.id = m.thread_id
     WHERE m.account_id = $1
       AND t.is_trashed = 0
       AND (t.folder_label_id IN (${folderList})
            OR EXISTS (
              SELECT 1 FROM thread_labels tl
              WHERE tl.thread_id = t.id AND tl.label_id IN (${membershipList})
            ))${authorFilter}
     ORDER BY m.date DESC
     LIMIT $${params.length}`,
    params
  )
}

/**
 * Plain text of a sent message: body_text when present, else the HTML
 * body stripped through mime-builder's htmlToText. That module is loaded
 * through a dynamic import on purpose (design D11's lazy-boundary
 * discipline): it statically reaches crypto/pgp-transform, and this
 * service sits in the Settings page's import graph (the AI section's
 * writing-style block) which must stay free of static crypto/pgp-* paths
 * — the stripper loads only when a text-less HTML body actually needs it.
 */
async function htmlBodyToText(html: string | null | undefined): Promise<string> {
  if (!html) return ""
  const { htmlToText } = await import("../email/mime-builder")
  return htmlToText(html)
}

/** One sampled message as a prompt block (subject + capped body text). */
async function formatSample(message: MessageRow): Promise<string> {
  const subject = message.subject?.trim() || "(no subject)"
  const text =
    message.body_text?.trim() || (await htmlBodyToText(message.body_html))
  const body = text.slice(0, MAX_BODY_CHARS)
  return [`Subject: ${subject}`, "", body].join("\n")
}

/** Strip markdown code fences (a model habit even when told not to). */
function stripCodeFences(text: string): string {
  return text.replace(/```[a-zA-Z]*\s*/g, "").trim()
}

/**
 * Tolerant profile extraction: everything from the first "{" to the last
 * "}" (prose around it ignored), JSON-parsed. Throws when no object-shaped
 * region exists or the slice is not JSON — the caller maps that to the
 * typed "parse" reason.
 */
function parseProfileReply(reply: string): unknown {
  const text = stripCodeFences(reply)
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) {
    throw new Error("no JSON object in model reply")
  }
  return JSON.parse(text.slice(start, end + 1))
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** Non-empty strings only, capped — the digest stays compact. */
function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .slice(0, MAX_LIST_ENTRIES)
}

/**
 * Normalize the parsed model object into the owned schema: known fields
 * only, junk coerced away. A partially-broken reply still yields whatever
 * fields survived — a missing field degrades the imitations, not the flow.
 */
export function normalizeStyleProfile(parsed: unknown): StyleProfile | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const raw = parsed as Record<string, unknown>
  const profile: StyleProfile = {
    version: 1,
    tone: asString(raw.tone),
    formality: asString(raw.formality),
    typicalLength: asString(raw.typicalLength),
    greetings: asStringList(raw.greetings),
    signOffs: asStringList(raw.signOffs),
    phrasing: asStringList(raw.phrasing),
  }
  // A reply with literally nothing usable is treated as unreadable.
  const hasAny =
    profile.tone !== "" ||
    profile.formality !== "" ||
    profile.typicalLength !== "" ||
    profile.greetings.length > 0 ||
    profile.signOffs.length > 0 ||
    profile.phrasing.length > 0
  return hasAny ? profile : null
}

/**
 * Build (or rebuild) the writing-style profile for one account (task 4.5,
 * spec scenario "Rebuild the profile"): samples the recent sent mail, asks
 * the active provider for the distilled style, and saves it with the
 * sample size. See the module doc for the result contract and consent
 * posture. Executor-first: production callers pass getExecutor(); tests
 * pass the node:sqlite test executor.
 */
export async function buildWritingStyleProfile(
  executor: SqlExecutor,
  accountId: string,
  deps: StyleProfileBuildDeps = {}
): Promise<StyleProfileBuildResult> {
  if (!(await isAiConfigured(executor))) {
    return { ok: false, reason: "not-configured" }
  }

  const samples = await loadRecentSentMessages(
    executor,
    accountId,
    STYLE_PROFILE_SAMPLE_LIMIT
  )
  if (samples.length === 0) {
    return { ok: false, reason: "no-sent-mail" }
  }

  const chat = deps.chat ?? aiChat
  let reply: string
  try {
    reply = await chat({
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            "These are recent email messages I wrote. Distill my writing",
            "style into the JSON profile described in your instructions.",
            "",
            ...(await Promise.all(samples.map((message) => formatSample(message)))),
          ].join("\n"),
        },
      ],
      maxTokens: 1024,
      surface: "smartReplies",
    })
  } catch (error) {
    return {
      ok: false,
      reason: "provider",
      message: error instanceof Error ? error.message : String(error),
    }
  }

  let profile: StyleProfile | null
  try {
    profile = normalizeStyleProfile(parseProfileReply(reply))
  } catch {
    profile = null
  }
  if (!profile) {
    return { ok: false, reason: "parse" }
  }

  await saveWritingStyleProfile(
    executor,
    accountId,
    JSON.stringify(profile),
    samples.length
  )
  return { ok: true, sampleSize: samples.length }
}

/**
 * The stored profile for an account, typed with the owned schema (null
 * when none/corrupt — the 4.3 store's contract). The reply flow and the
 * Settings block both read through this.
 */
export async function loadStyleProfile(
  executor: SqlExecutor,
  accountId: string
): Promise<WritingStyleProfileEnvelope | null> {
  return getWritingStyleProfile<StyleProfile>(executor, accountId)
}

/** The decoded envelope with the profile typed to the owned schema. */
export interface WritingStyleProfileEnvelope {
  profile: StyleProfile
  builtAt: number
  sampleSize: number
}

/** Delete an account's profile (Settings block; rebuilds simply save over). */
export async function deleteStyleProfile(
  executor: SqlExecutor,
  accountId: string
): Promise<void> {
  await deleteWritingStyleProfile(executor, accountId)
}
