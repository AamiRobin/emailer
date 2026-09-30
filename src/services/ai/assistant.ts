import type { SqlExecutor } from "../db/executor"
import { listActiveAccounts } from "../db/accounts"
import type { MessageRow } from "../db/messages"
import {
  getThreadWithMessages,
  listThreadsAcrossAccounts,
  type ThreadRow,
} from "../db/threads"
import { searchThreadsAcrossAccounts } from "../search"
import { ASK_INBOX_GRAMMAR } from "./ask-inbox"
import {
  AiUnavailableError,
  aiChat,
  resolveSurfaceRuntime,
  type AiChatMessage,
} from "./client"
import {
  cleanUntrusted,
  fenceThread,
  UNTRUSTED_THREAD_NOTICE,
  withOutputLanguage,
} from "./prompt"
import { getOutputLanguage } from "./settings"
import { estimateTokens } from "./usage"

/**
 * AI assistant loop (ai-assistant-panel tasks 2.1–2.4, design D2/D3/D4) —
 * the app's first multi-turn, tool-using surface. One USER TURN is a
 * bounded TS-side loop over the strict text envelope the system prompt
 * defines: the model replies EITHER with a single JSON object
 * `{"tool": "search" | "read_thread" | "list_unread", "args": {...}}` OR
 * with the final answer as plain text. Parsing is strict by design
 * (design D2): a reply is a tool call only when it parses as a JSON
 * object with a string "tool" key — anything else IS the answer, so
 * neither direction of model confusion can crash the loop.
 *
 * Tools (design D3) are read-only mailbox lookups over the ACTIVE
 * accounts (`listActiveAccounts`, the same getter the unified/split
 * cross-account scopes use): operator-grammar search
 * (`searchThreadsAcrossAccounts`, grammar text in the prompt so the model
 * writes queries directly), one thread's messages
 * (`getThreadWithMessages`), and recent unread threads (the folder-digest
 * gather shape: unread_count > 0, last_message_at desc, capped).
 * `read_thread` accepts ONLY thread ids its earlier tool results surfaced
 * in this conversation (per-turn id plus the caller-accumulated set from
 * previous turns) — the model cannot read its way to a hallucinated id.
 * Argument validation is manual schema-shaping; every failure — unknown
 * tool, malformed args, unsurfaced id, an internal DB error — becomes a
 * `[TOOL_ERROR]` user message the model may react to, never a throw at
 * the user. `AiUnavailableError` / `AiProviderError` from `aiChat`
 * propagate untouched (the dialog owns hide-vs-show and Retry).
 *
 * Every tool result re-enters the conversation as a user message:
 * `[TOOL_RESULT name=<tool>]` + a `fenceThread`-fenced payload whose
 * fields passed `cleanUntrusted` first — mailbox content is
 * attacker-controlled, and the system prompt carries the fence contract
 * (UNTRUSTED_THREAD_NOTICE). The loop is hard-capped at MAX_TOOL_ROUNDS
 * tool-shaped replies per turn (executed or rejected — failed attempts
 * count, so the cap bounds the whole loop); on reaching it the loop sends
 * a final "answer now" instruction whose reply is returned as the answer
 * whatever it is.
 *
 * Cost (design D4): the turn accumulates chars/4 (`estimateTokens`, the
 * usage.ts basis) over EVERYTHING sent and received — the system prompt
 * rides every call, each message content is counted on every call that
 * carries it, and every reply is counted on receipt. Real per-call rows
 * still land in `ai_usage` inside the shared client. No caching: a
 * conversation turn is live by nature.
 */

/** Hard cap on tool-shaped replies per user turn (design D2). */
export const MAX_TOOL_ROUNDS = 6

/** Per-call completion cap — the generative surfaces' standard 1024;
 * bounds a runaway generation without constraining an answer. */
const MAX_REPLY_TOKENS = 1024

/** Search rows returned per call (design D3). */
const SEARCH_RESULT_LIMIT = 20

/** Unread threads list_unread returns at most (design D3, the
 * folder-digest cap). */
const LIST_UNREAD_LIMIT = 25

/** Per-message body cap in a read_thread payload (design D3, the
 * codebase-standard 4000 chars). */
const MAX_BODY_CHARS = 4000

/** Messages a read_thread payload shows at most (design D3). */
const MAX_READ_MESSAGES = 20

/** Snippet cap in a thread-list row — list rows stay scannable. */
const MAX_SNIPPET_CHARS = 200

/** The registered read-only tools (design D3) — anything else is a
 * `[TOOL_ERROR]`, never executed. */
export const ASSISTANT_TOOLS = [
  "search",
  "read_thread",
  "list_unread",
] as const

export type AssistantToolName = (typeof ASSISTANT_TOOLS)[number]

function isAssistantToolName(value: string): value is AssistantToolName {
  return ASSISTANT_TOOLS.some((tool) => tool === value)
}

/** A parsed tool-call attempt: the raw name plus its args object (absent
 * args degrade to `{}` — per-tool validation rejects what it needs). */
export interface AssistantToolCall {
  tool: string
  args: Record<string, unknown>
}

/**
 * The strict envelope parse of one model reply (design D2): a tool call
 * only when the trimmed reply is a JSON object carrying a string "tool"
 * key — fenced JSON, prose around JSON, arrays and non-string tool names
 * are all simply the final answer.
 */
export type AssistantReply =
  | { kind: "tool"; call: AssistantToolCall }
  | { kind: "answer"; text: string }

export function parseAssistantReply(raw: string): AssistantReply {
  const trimmed = raw.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { kind: "answer", text: trimmed }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "answer", text: trimmed }
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.tool !== "string") {
    return { kind: "answer", text: trimmed }
  }
  const args =
    typeof record.args === "object" &&
    record.args !== null &&
    !Array.isArray(record.args)
      ? (record.args as Record<string, unknown>)
      : {}
  return { kind: "tool", call: { tool: record.tool, args } }
}

/**
 * The system prompt (tasks 2.1, design D2/D3): the assistant's role, the
 * strict two-way envelope contract, the three tools with their exact
 * shapes, the operator grammar (ASK_INBOX_GRAMMAR verbatim — the same
 * language the search parser consumes, so the model writes operator
 * queries directly), the grounding rule, and the untrusted-fence
 * contract for the tool payloads it is about to receive.
 */
function buildSystemPrompt(): string {
  return [
    "You are the user's mailbox assistant. You answer questions about " +
      "their email by running read-only lookups with tools, then " +
      "answering from what the tools return.",
    "",
    "Every reply is EXACTLY ONE of:",
    '1. A tool call — a single JSON object {"tool": "<name>", "args": ' +
      "{...}} and nothing else, choosing one of:",
    '   - search — operator search over the mailbox: {"tool": "search", ' +
      '"args": {"query": "from:alice has:attachment"}}',
    '   - read_thread — one conversation in full: {"tool": ' +
      '"read_thread", "args": {"threadId": "<id copied from an earlier ' +
      'tool result>"}}',
    '   - list_unread — recent unread threads: {"tool": "list_unread", ' +
      '"args": {}}',
    "   read_thread accepts only thread ids an earlier tool result " +
      "returned in this conversation.",
    "2. The final answer as plain text — no JSON, no code fence. " +
      "Anything that is not the JSON object above IS treated as the " +
      "final answer.",
    "",
    "Make at most one tool call per reply and wait for its result " +
      "before deciding the next step. As soon as the results already " +
      "answer the question, stop calling tools and answer. Ground every " +
      "claim in the threads the tools returned and reference them by " +
      "subject; never invent threads, senders or content.",
    "",
    ASK_INBOX_GRAMMAR,
    "",
    UNTRUSTED_THREAD_NOTICE,
  ].join("\n")
}

/** The final instruction when the tool cap is hit (design D2): no more
 * tools — answer from what the conversation already holds. */
const FINAL_ANSWER_INSTRUCTION =
  "[TOOL_CAP] The tool budget for this turn is exhausted. Do not " +
  "request any more tools: answer the user's question now, from the " +
  "information the conversation already contains."

/** Display identity of a message's sender (never empty) — the
 * task-extraction formatting, for identical prompt blocks. */
function describeSender(message: MessageRow): string {
  const name = message.from_name?.trim()
  const address = message.from_address?.trim()
  if (name && address) return `${name} <${address}>`
  return name ?? address ?? "Unknown sender"
}

/**
 * Display line for a thread's cached participants JSON (migration v2
 * cache) — the folder-digest parsing: email-derived (attacker-controlled)
 * so invisibles are stripped; an absent/unparseable cache degrades to a
 * placeholder.
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

/** Format a UTC date (unix seconds) as the yyyy-MM-dd prompt line —
 * date-only keeps payloads compact and timezone-agnostic. */
function formatDate(unixSeconds: number | null): string {
  return unixSeconds
    ? new Date(unixSeconds * 1000).toISOString().slice(0, 10)
    : "unknown date"
}

/**
 * One thread-list row for the search / list_unread payloads (design D3:
 * id, subject, snippet, participants, date, unread, account). The id line
 * is what read_thread copies back; every display field is untrusted email
 * content and passes cleanUntrusted first.
 */
function formatThreadRow(
  thread: ThreadRow,
  accountLabels: Map<string, string>
): string {
  const subject = cleanUntrusted(thread.subject?.trim() || "(no subject)")
  const snippet = cleanUntrusted((thread.snippet ?? "").trim()).slice(
    0,
    MAX_SNIPPET_CHARS
  )
  const unread =
    thread.unread_count > 0 ? `, ${thread.unread_count} unread` : ""
  return [
    `- id: ${thread.id}`,
    `  subject: ${subject}`,
    `  participants: ${describeParticipants(thread.participants)}`,
    `  snippet: ${snippet}`,
    `  last message: ${formatDate(thread.last_message_at)}${unread}`,
    `  account: ${accountLabels.get(thread.account_id) ?? thread.account_id}`,
  ].join("\n")
}

/**
 * The read_thread payload: the thread's header plus its messages numbered
 * [0], [1], … (from/date/subject + `body_text ?? snippet`), capped at
 * MAX_READ_MESSAGES messages of MAX_BODY_CHARS each (design D3). Overflow
 * is stated, never silent.
 */
function formatThreadMessages(
  thread: ThreadRow,
  messages: MessageRow[]
): string {
  const shown = messages.slice(0, MAX_READ_MESSAGES)
  const omitted = messages.length - shown.length
  const blocks = shown.map((message, index) => {
    const body = cleanUntrusted(
      (message.body_text ?? message.snippet ?? "").trim()
    ).slice(0, MAX_BODY_CHARS)
    return [
      `[${index}] From: ${describeSender(message)}`,
      `Date: ${formatDate(message.date)}`,
      `Subject: ${cleanUntrusted(message.subject?.trim() || "(no subject)")}`,
      "",
      body,
    ].join("\n")
  })
  return [
    `Thread id: ${thread.id}`,
    `Subject: ${cleanUntrusted(thread.subject?.trim() || "(no subject)")}`,
    `Messages: ${messages.length}` +
      (omitted > 0 ? ` (showing the first ${shown.length})` : ""),
    "",
    blocks.join("\n\n"),
  ].join("\n")
}

/** What one tool execution produced: a fenced-ready payload plus the ids
 * it surfaced, or a reason for the `[TOOL_ERROR]` feedback. */
interface ToolOutcome {
  kind: "result" | "error"
  payload?: string
  surfacedThreadIds?: string[]
  reason?: string
}

/** Per-turn tool context: the active-account resolution (lazy, cached)
 * and the conversation's touched-thread membership test. */
interface ToolContext {
  getAccounts: () => Promise<{ ids: string[]; labels: Map<string, string> }>
  isKnownThread: (threadId: string) => boolean
}

/**
 * Execute one registered read-only tool (design D3). Argument validation
 * is manual schema-shaping: every rejection — unknown tool, wrong/empty
 * args, an unsurfaced threadId, an internal DB error — is a TOOL_ERROR
 * outcome, never a throw; the model is told and may retry or answer.
 */
async function executeTool(
  executor: SqlExecutor,
  call: AssistantToolCall,
  context: ToolContext
): Promise<ToolOutcome> {
  const { tool, args } = call
  if (!isAssistantToolName(tool)) {
    return {
      kind: "error",
      reason:
        `unknown tool "${tool}" — the available tools are ` +
        `${ASSISTANT_TOOLS.join(", ")}`,
    }
  }
  try {
    if (tool === "search") {
      const query = typeof args.query === "string" ? args.query.trim() : ""
      if (query === "") {
        return {
          kind: "error",
          reason:
            'the search tool needs a non-empty "query" string argument',
        }
      }
      const accounts = await context.getAccounts()
      const rows = await searchThreadsAcrossAccounts(
        executor,
        accounts.ids,
        query,
        { limit: SEARCH_RESULT_LIMIT }
      )
      if (rows.length === 0) {
        return {
          kind: "result",
          payload: "No threads matched the search.",
          surfacedThreadIds: [],
        }
      }
      return {
        kind: "result",
        payload: rows
          .map((row) => formatThreadRow(row, accounts.labels))
          .join("\n"),
        surfacedThreadIds: rows.map((row) => row.id),
      }
    }
    if (tool === "read_thread") {
      const threadId =
        typeof args.threadId === "string" ? args.threadId.trim() : ""
      if (threadId === "") {
        return {
          kind: "error",
          reason:
            'the read_thread tool needs a non-empty "threadId" string argument',
        }
      }
      if (!context.isKnownThread(threadId)) {
        return {
          kind: "error",
          reason:
            `unknown thread "${threadId}" — read_thread only accepts ids ` +
            "an earlier tool result returned in this conversation",
        }
      }
      const loaded = await getThreadWithMessages(executor, threadId)
      if (!loaded) {
        return {
          kind: "error",
          reason: `unknown thread "${threadId}" — it no longer exists`,
        }
      }
      return {
        kind: "result",
        payload: formatThreadMessages(loaded.thread, loaded.messages),
        surfacedThreadIds: [],
      }
    }
    // list_unread — the folder-digest gather shape: list threads across
    // the active accounts (the "all" preset: trash/spam excluded, the
    // same exclusions the search pipeline applies), keep unread_count >
    // 0, order last_message_at desc (id tiebreak), cap LIST_UNREAD_LIMIT.
    const accounts = await context.getAccounts()
    if (accounts.ids.length === 0) {
      // No active accounts: an empty list, never the unfiltered
      // "every account" reading listThreadsAcrossAccounts gives [].
      return {
        kind: "result",
        payload: "No unread threads.",
        surfacedThreadIds: [],
      }
    }
    const rows = await listThreadsAcrossAccounts(executor, {
      accountIds: accounts.ids,
      folder: { kind: "preset", preset: "all" },
    })
    const unread = rows
      .filter((thread) => thread.unread_count > 0)
      .sort(
        (a, b) =>
          (b.last_message_at ?? 0) - (a.last_message_at ?? 0) ||
          a.id.localeCompare(b.id)
      )
      .slice(0, LIST_UNREAD_LIMIT)
    if (unread.length === 0) {
      return {
        kind: "result",
        payload: "No unread threads.",
        surfacedThreadIds: [],
      }
    }
    return {
      kind: "result",
      payload: unread
        .map((row) => formatThreadRow(row, accounts.labels))
        .join("\n"),
      surfacedThreadIds: unread.map((row) => row.id),
    }
  } catch {
    // A tool's internal failure (db) degrades to tool-error feedback the
    // model may react to — never a throw at the user.
    return { kind: "error", reason: `the ${tool} lookup failed` }
  }
}

/** The turn input's caller-side conversation state (design D4): thread
 * ids earlier turns' tools surfaced, so read_thread keeps accepting them
 * across turns of the open conversation. */
export interface AssistantTurnOptions {
  touchedThreadIds?: string[]
}

/** One user turn's outcome: the answer, the threads the tools surfaced
 * (for the panel's source chips), the approximate turn cost, and the
 * tool rounds the loop ran. */
export interface AssistantTurnResult {
  answer: string
  /** Thread ids the tools surfaced during this turn (for source chips). */
  touchedThreadIds: string[]
  /** Approximate tokens for this turn (chars/4, sent + received). */
  approxTokens: number
  toolRounds: number
}

/**
 * Run one assistant user turn (tasks 2.2–2.4, design D2): loop the
 * envelope against the active provider — tool calls executed read-only
 * until the model answers or the MAX_TOOL_ROUNDS cap forces a final
 * "answer now" call. `history` carries the prior turns of the open
 * conversation (the caller accumulates it and the touched-thread set;
 * the result's touchedThreadIds is the union to feed back). Throws
 * `AiUnavailableError` / `AiProviderError` — never swallows them.
 *
 * Executor-first: production callers pass getExecutor(); tests pass the
 * node:sqlite test executor.
 */
export async function runAssistantTurn(
  executor: SqlExecutor,
  history: AiChatMessage[],
  userMessage: string,
  options?: AssistantTurnOptions
): Promise<AssistantTurnResult> {
  // One resolution for the whole turn (task 2.2 precedent): runtime.model
  // rides every call of the loop. Null = gate closed (AI off / no active
  // provider) — the fail-toward-off guard, matching the other surfaces.
  const runtime = await resolveSurfaceRuntime(executor, "assistant")
  if (!runtime) {
    throw new AiUnavailableError("not-configured")
  }
  const system = withOutputLanguage(
    buildSystemPrompt(),
    await getOutputLanguage(executor)
  )

  const messages: AiChatMessage[] = [
    ...history,
    { role: "user", content: userMessage },
  ]
  // The conversation's touched threads, in first-surfaced order: the ids
  // read_thread accepts and the source chips render (design D4).
  const touched: string[] = []
  const addTouched = (threadId: string) => {
    if (!touched.includes(threadId)) touched.push(threadId)
  }
  for (const threadId of options?.touchedThreadIds ?? []) addTouched(threadId)

  // Active accounts resolve once per turn, on the first tool that needs
  // them (a plain answer never pays for the query).
  let accounts: { ids: string[]; labels: Map<string, string> } | null = null
  const context: ToolContext = {
    getAccounts: async () => {
      if (!accounts) {
        const rows = await listActiveAccounts(executor)
        accounts = {
          ids: rows.map((account) => account.id),
          labels: new Map(
            rows.map((account) => [
              account.id,
              account.display_name?.trim() || account.email,
            ])
          ),
        }
      }
      return accounts
    },
    isKnownThread: (threadId) => touched.includes(threadId),
  }

  let approxTokens = 0
  let toolRounds = 0
  let forcedFinal = false

  while (true) {
    // Snapshot: each call's args record the exact messages it saw (the
    // array keeps growing across rounds).
    const sent = [...messages]
    const reply = await aiChat({
      system,
      messages: sent,
      maxTokens: MAX_REPLY_TOKENS,
      surface: "assistant",
      model: runtime.model,
    })
    // D4 cost basis: chars/4 over everything sent and received this
    // turn — the system prompt rides every call, each message content
    // counts on every call carrying it, every reply on receipt (a reply
    // sent back as assistant history therefore counts again there).
    approxTokens +=
      estimateTokens(system) +
      sent.reduce((sum, message) => sum + estimateTokens(message.content), 0) +
      estimateTokens(reply)

    if (forcedFinal) {
      // The cap's final call: its reply is the answer whatever it is —
      // the loop never runs further (design D2).
      return {
        answer: reply.trim(),
        touchedThreadIds: [...touched],
        approxTokens,
        toolRounds,
      }
    }

    const parsed = parseAssistantReply(reply)
    if (parsed.kind === "answer") {
      return {
        answer: parsed.text,
        touchedThreadIds: [...touched],
        approxTokens,
        toolRounds,
      }
    }

    if (toolRounds >= MAX_TOOL_ROUNDS) {
      // Cap reached: the requested round is NOT executed (and not
      // counted). Tell the model to answer from what it has; the next
      // reply ends the turn.
      messages.push({ role: "assistant", content: reply })
      messages.push({ role: "user", content: FINAL_ANSWER_INSTRUCTION })
      forcedFinal = true
      continue
    }
    // Every executed or rejected round consumes one, so malformed-call
    // retries are bounded by the same cap.
    toolRounds += 1

    messages.push({ role: "assistant", content: reply })
    const outcome = await executeTool(executor, parsed.call, context)
    if (outcome.kind === "error") {
      messages.push({
        role: "user",
        content: `[TOOL_ERROR] ${outcome.reason}`,
      })
      continue
    }
    for (const threadId of outcome.surfacedThreadIds ?? []) addTouched(threadId)
    // The payload is untrusted email content: fields were cleanUntrusted-ed
    // above and the whole block is fenced (fenceThread also strips any
    // markers the bodies forge).
    messages.push({
      role: "user",
      content: `[TOOL_RESULT name=${parsed.call.tool}]\n${fenceThread(
        outcome.payload ?? ""
      )}`,
    })
  }
}
