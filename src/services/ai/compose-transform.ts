import type { SqlExecutor } from "../db/executor"
import { getExecutor } from "../db/executor"
import { aiChat } from "./client"
import { cleanUntrusted, withOutputLanguage } from "./prompt"
import { getOutputLanguage } from "./settings"

/**
 * Compose text transform service (task 4.6, ai-assistance spec "Compose
 * text transform", design D1): improve / shorten / formalize over draft
 * text the user explicitly ran the transform on. The prompt shaping lives
 * here (design D1: TS orchestrates prompts, Rust transports) — the USER
 * text is the message content verbatim, so exactly the selected/drafted
 * span leaves the machine, never the surrounding draft. The system prompt
 * carries the per-mode instruction plus quote-instruction hygiene: the
 * model must return ONLY the transformed text (no preamble, no wrapper
 * quotes), because the result is spliced back into the draft as-is.
 *
 * No result caching (task 4.3 service deliberately not wired here): a
 * transform is one-shot against a live draft selection — the same text
 * rarely transforms twice, and the surrounding draft context changes
 * between runs, so reuse value is low and the pending-replacement flow
 * regenerates on retry anyway. The consent gate and provider rate limits
 * are enforced by `aiChat` itself.
 */

/** The three transform modes (spec: improve, shorten, formalize). */
export type ComposeTransformMode = "improve" | "shorten" | "formalize"

export const COMPOSE_TRANSFORM_MODES: readonly ComposeTransformMode[] = [
  "improve",
  "shorten",
  "formalize",
]

export function isComposeTransformMode(
  value: unknown
): value is ComposeTransformMode {
  return COMPOSE_TRANSFORM_MODES.some((mode) => mode === value)
}

/**
 * Quote-instruction hygiene shared by every mode: the reply is spliced
 * verbatim into the draft, so any preamble, explanation or wrapper quote
 * would leak into the email. Output formatting stays plain text (blank
 * lines between paragraphs) — the composer converts it to HTML.
 */
const OUTPUT_CONTRACT =
  "Return ONLY the transformed text itself: no preamble, no explanations, " +
  "no notes, and do not wrap it in quotation marks. Separate paragraphs " +
  "with blank lines."

/** The per-mode system prompts (concise; the user text is the message). */
const TRANSFORM_SYSTEM_PROMPTS: Record<ComposeTransformMode, string> = {
  improve:
    "You are an email writing assistant. Improve the email text you are " +
    "given: fix grammar, spelling, clarity and flow while keeping the " +
    "meaning, tone and language. " +
    OUTPUT_CONTRACT,
  shorten:
    "You are an email writing assistant. Condense the email text you are " +
    "given: keep every essential point but cut filler and repetition — " +
    "aim for roughly half the length — while keeping the meaning and " +
    "language. " +
    OUTPUT_CONTRACT,
  formalize:
    "You are an email writing assistant. Rewrite the email text you are " +
    "given in a formal, professional tone, keeping the meaning and all " +
    "information. " +
    OUTPUT_CONTRACT,
}

export interface TransformDraftTextArgs {
  /** The draft text to transform (the selection, or the whole body). */
  text: string
  mode: ComposeTransformMode
  /**
   * Executor override (task 2.6): the output-language read rides the same
   * db seam as every other AI surface. Production callers omit it
   * (getExecutor()); tests pass the node:sqlite test executor — or omit
   * it and the language read degrades to unset (fail toward "infer from
   * the input"), never throwing.
   */
  executor?: SqlExecutor
}

/**
 * Run one compose transform against the active provider. Pure pass-through
 * of the shared client's gating and errors: `AiUnavailableError` (AI not
 * configured / this surface disabled — the UI hides the affordance for
 * those) and `AiProviderError` (network/status/parse/rate_limited/config —
 * the UI shows it inline with Retry) propagate unchanged. Resolves with
 * the trimmed transformed plain text.
 */
export async function transformDraftText({
  text,
  mode,
  executor,
}: TransformDraftTextArgs): Promise<string> {
  // Task 2.6: the configured output language appends to the per-mode
  // prompt; unavailable db (plain vite) reads as unset — the model then
  // infers the language from the transformed text itself.
  let language: string | null = null
  try {
    language = await getOutputLanguage(executor ?? getExecutor())
  } catch {
    // No executor — stay unset.
  }
  const content = await aiChat({
    surface: "composeTransform",
    system: withOutputLanguage(TRANSFORM_SYSTEM_PROMPTS[mode], language),
    // The drafted/selected text can quote other people's mail (a reply
    // draft): strip invisible smuggle-before-prompt characters from the
    // untrusted span before it enters the prompt.
    messages: [{ role: "user", content: cleanUntrusted(text) }],
    // Email-scale output budget: enough for a full-length formal rewrite
    // of a long body without letting a runaway answer inflate the draft.
    maxTokens: 2048,
  })
  return content.trim()
}
