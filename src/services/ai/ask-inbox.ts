import { format } from "date-fns"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import {
  isEmptyQuery,
  parseSearchQuery,
  resolveDateTokens,
} from "@/services/search"
import { aiChat } from "./client"
import { getOutputLanguage, withOutputLanguage } from "./prompt"

/**
 * Ask My Inbox — natural-language question → operator query (task 4.7,
 * design D3). Query TRANSLATION, not RAG: the model receives the operator
 * grammar (ASK_INBOX_GRAMMAR below, the same language the search parser
 * consumes) plus the user's question, and returns a constrained query
 * string. ONLY the question and the grammar leave the machine — never
 * message content (spec "Ask My Inbox": no mailbox contents beyond what
 * translation requires). The returned query is not trusted: it is parsed
 * with the REAL parser before being shown, so a broken or empty mapping
 * degrades to a clarification instead of wrong results (spec "Ambiguous
 * request").
 *
 * Execution stays entirely local: the caller feeds the query through the
 * normal search entry (the search view, exactly like a typed query), so
 * `resolveDateTokens` (task 3.8) expands `__TODAY±ND__` at query time on
 * the same run seam — the translation never resolves dates itself.
 *
 * Failures are the caller's to surface: provider/transport errors
 * (AiProviderError / AiUnavailableError) propagate so the dialog can show
 * its inline error with retry (spec "AI caching and failure handling").
 * Only model-content problems (malformed reply, unmappable request)
 * become clarifications.
 */

/**
 * The operator grammar as the translation prompt states it — a compact
 * restatement of the parser's contract (parser.ts module docs, the
 * authoritative description; task 4.7, design D3). Kept next to the call
 * that uses it so the two evolve together: if the parser grows an
 * operator, this reference must name it (the model may emit ONLY what is
 * documented here; anything else degrades to free text in the parser).
 * Deliberately the ONLY mail knowledge the model receives — no message
 * content, no labels/folders from the user's account (design D3).
 */
export const ASK_INBOX_GRAMMAR = `Search grammar (the only query language the app understands):
- Tokens are whitespace-separated; double quotes group a phrase: from:"Alice Smith", "annual report". No escape character.
- A leading - negates one token: -term, -from:x, -has:attachment, -before:2026-01-01.
- Operators (key:value):
  - from:<value> — sender name or address.
  - to:<value> — any to/cc/bcc recipient.
  - subject:<value> — subject text.
  - label:<name> — a label of the account.
  - has:attachment — has attachments.
  - is:unread, is:starred — state flags.
  - larger:<N>[k|m|kb|mb], smaller:<N>[k|m|kb|mb] — message size thresholds.
  - after:<date>, before:<date> — date bounds as yyyy-MM-dd; after: is inclusive, before: exclusive.
- Repeated operators AND together; free-text terms AND together; negated tokens exclude.
- No other operators exist. Anything else (foo:bar, is:read, has:file) would be searched as literal text — never emit it.`

/** The clarification shown when the reply is malformed or the query
 * fails validation — the model's own question when it gave one, this
 * otherwise (never show broken results). */
const GENERIC_CLARIFICATION =
  "I couldn't map that to a mailbox search. Try naming a sender, subject, keyword, or date range."

/** What a translation turned into: an executable operator query, or a
 * clarifying question to put back to the user (spec "Ambiguous request":
 * say so instead of showing wrong results). */
export type TranslationResult =
  | { kind: "query"; query: string }
  | { kind: "clarification"; question: string }

/**
 * Translate one natural-language question into the search-operator
 * language via the active provider (surface "askInbox"). `today` anchors
 * relative phrases ("since monday") — the prompt states it and the strict
 * output rules make the model emit concrete yyyy-MM-dd dates or
 * `__TODAY±ND__` tokens (resolved by the pipeline at search time, so an
 * edited-but-rerun query stays current). Never throws for model-content
 * reasons: those come back as clarifications; provider failures throw
 * (the caller's retry affordance).
 *
 * Output language (parity-round-2 task 2.6, spec "AI output language"):
 * the reply the user reads — the QUERY line's interpretation aside, the
 * `CLARIFY:` question is user-facing prose — obeys the configured
 * language via the shared directive; unset appends nothing and the model
 * infers from the question. The optional `executor` overrides the db seam
 * for the language read (production omits it → getExecutor(); tests pass
 * the node:sqlite executor — or omit it and the read degrades to unset,
 * never throwing, the compose-transform guard).
 */
export async function translateQuestion(
  question: string,
  today: Date = new Date(),
  executor?: SqlExecutor
): Promise<TranslationResult> {
  const trimmed = question.trim()
  if (trimmed === "") {
    return { kind: "clarification", question: GENERIC_CLARIFICATION }
  }
  let language: string | null = null
  try {
    language = await getOutputLanguage(executor ?? getExecutor())
  } catch {
    // No executor (plain vite) — stay unset.
  }
  const reply = await aiChat({
    system: withOutputLanguage(buildSystemPrompt(today), language),
    messages: [{ role: "user", content: trimmed }],
    // The reply is one short line — a tight cap keeps a runaway
    // generation from stalling the dialog without constraining queries.
    maxTokens: 200,
    surface: "askInbox",
  })
  return extractReply(reply, today)
}

/**
 * The system prompt (task 4.7, design D3): the grammar reference, today's
 * date for relative-phrase resolution, and the STRICT two-line output
 * contract — `QUERY: <operator query>` or `CLARIFY: <question>`, nothing
 * else. The example is kept abstract (a shape, not a computed date) so
 * the prompt never encodes a stale calendar.
 */
function buildSystemPrompt(today: Date): string {
  return [
    "You translate a natural-language question about someone's mailbox into a search query. You never see any mail content — translation only.",
    `Today is ${format(today, "EEEE, yyyy-MM-dd")}. Resolve relative phrases ("yesterday", "since monday", "last week") against that date.`,
    'Dates: emit a concrete yyyy-MM-dd date, or a dynamic token __TODAY±ND__ ("__TODAY-7D__", "__TODAY__") that the app resolves at search time — prefer the token for anything relative to today.',
    "Respond with EXACTLY ONE line and nothing else:",
    "- `QUERY: <query>` when the request maps confidently onto the grammar below (single line, only the documented operators).",
    "- `CLARIFY: <question>` when the request is ambiguous or cannot be expressed with them.",
    "Prefer CLARIFY over a wrong guess. Never invent operators.",
    "",
    ASK_INBOX_GRAMMAR,
    "",
    "Example — Question: attachments from maria since monday",
    "QUERY: from:maria has:attachment after:<that monday, as yyyy-MM-dd>",
  ].join("\n")
}

/**
 * Parse the model reply tolerantly (task 4.7): code fences and stray
 * whitespace are stripped, the directive keyword is matched
 * case-insensitively, and the FIRST recognized line decides. A `QUERY:`
 * whose payload fails parser validation degrades to the generic
 * clarification — the interpreted query is only ever returned when the
 * real parser accepts it.
 */
function extractReply(raw: string, today: Date): TranslationResult {
  // Strip fenced blocks (``` ... ```), keeping their inner lines.
  const text = raw.replace(/```[a-z]*\n?/gi, "").trim()
  for (const line of text.split("\n")) {
    const match = /^\s*(query|clarify)\s*:\s*(.*?)\s*$/i.exec(line)
    if (!match) continue
    if (match[1]!.toLowerCase() === "clarify") {
      const question = match[2]!.trim()
      return {
        kind: "clarification",
        question: question === "" ? GENERIC_CLARIFICATION : question,
      }
    }
    const query = stripWrappingBackticks(match[2]!.trim())
    if (isUsableQuery(query, today)) return { kind: "query", query }
    return { kind: "clarification", question: GENERIC_CLARIFICATION }
  }
  return { kind: "clarification", question: GENERIC_CLARIFICATION }
}

/** Drop one pair of wrapping backticks — the fenced-code habit models
 * sometimes carry over (`QUERY: \`from:x\``). */
function stripWrappingBackticks(query: string): string {
  return query.replace(/^`(.*)`$/s, "$1").trim()
}

/**
 * Validate the returned query against the REAL parser (task 4.7): it must
 * contribute at least one predicate — positive or negated. Date tokens
 * are resolved first, mirroring the run seam (searchThreadsAcrossAccounts
 * expands tokens before parsing), so `after:__TODAY-3D__` validates as a
 * real date bound while the UNRESOLVED query is still what the caller
 * receives and the pipeline re-resolves at execution time. A parse throw
 * (defensive — the parser never throws on strings) fails toward
 * clarification, never toward showing results.
 */
function isUsableQuery(query: string, today: Date): boolean {
  if (query === "") return false
  try {
    return !isEmptyQuery(parseSearchQuery(resolveDateTokens(query, today)))
  } catch {
    return false
  }
}
