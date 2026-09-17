import type { SqlExecutor } from "../db/executor"
import { getAccount } from "../db/accounts"
import { bumpJunkToken, listJunkTokens } from "../db/junk-tokens"
import type { MessageRow } from "../db/messages"
import { getSetting, setSetting } from "../db/settings"
import { getJunkFilterEnabled } from "../settings/preferences"

/**
 * Local adaptive junk filter (task 18.10, design D19) — a self-implemented
 * naive-Bayes classifier over the `junk_tokens` count store (db/junk-tokens.ts,
 * migration v6), IMAP-only and trained EXCLUSIVELY by explicit user actions
 * (mark-spam / not-spam — the same thread-actions events the toolbar, context
 * menu and shortcuts already emit). Nothing heuristic ever writes counts: not
 * rules, not the auto-move itself, not this classifier's own verdicts (D19).
 *
 * Model (deterministic, no dependencies, testable to the digit):
 *
 * 1. TOKENIZE — lowercase, split on every non-alphanumeric character, drop
 *    tokens shorter than 3 characters, and cap the document at the first
 *    200 kept tokens (bounds the per-message cost of huge bodies; no
 *    stemming or stop-word list — the probability combination handles
 *    neutral words on its own and the model must stay explainable).
 * 2. SCORE each DISTINCT token (presence-based: a document gives each of
 *    its tokens one vote, however often the token repeats) with the
 *    token's spam share computed from the stored counts at classification
 *    time — counts are the only stored state:
 *        p(token) = clamp(spam_count / (spam_count + ham_count), 0.01, 0.99)
 *    Tokens never seen in training are skipped entirely (neutral — they
 *    neither vote spam nor ham); with NO known tokens the posterior is
 *    exactly 0.5.
 * 3. COMBINE the MAX_CLASSIFIED_TOKENS tokens whose p is farthest from
 *    0.5 (the classic Paul Graham 2002 "most interesting mail words"
 *    selection — keeps long neutral bodies from diluting the verdict) in
 *    log space for numeric stability:
 *        logP = Σ ln p_i,  logQ = Σ ln (1 − p_i)
 *        posterior = 1 / (1 + e^(logQ − logP))   ∈ [0.01, 0.99] per vote
 *
 * AUTO-MOVE GATE (spec: high confidence AND sufficient training): a
 * message is placed in the account's spam folder only when the posterior
 * reaches AUTO_MOVE_THRESHOLD (default 0.95) AND the account has been
 * trained on at least MIN_TRAINING_SPAM_EVENTS spam documents (default
 * 50). Below either bound mail is delivered normally — and the filter
 * never deletes anything; a mis-filed thread is one click from the inbox
 * via the "Not spam" affordance (mail-display's junk banner), which is
 * itself a training event.
 *
 * The thresholds are constants on purpose (the spec requires the behavior,
 * not a settings UI for the dials). GMAIL ACCOUNTS ARE EXEMPT: Google's
 * server-side filtering already files that mail, double-filtering would
 * fight Google's verdicts (D19), and gmail never trains — enforced by
 * junkFilterTrainingActive and loadJunkFilterConfig both refusing
 * non-IMAP accounts, and by the sync engines: only imap-sync builds a
 * config, so gmail-sync's hook calls structurally cannot classify.
 */

/** Auto-move only above this posterior (design D19 default: 0.95). */
export const JUNK_AUTO_MOVE_THRESHOLD = 0.95

/** Auto-move requires at least this many trained spam documents (design
 * D19 default: 50) — cold-start accounts never auto-junk. */
export const JUNK_MIN_TRAINING_SPAM_EVENTS = 50

/** Tokens kept per document (first N after the length filter — document
 * order is deterministic). */
const MAX_TOKENS_PER_DOCUMENT = 200

/** Tokens combined per classification, most interesting first (Graham's
 * "farthest from 0.5" selection). */
const MAX_CLASSIFIED_TOKENS = 50

/** Per-vote clamps (Graham 2002): a single token can never be certain. */
const MIN_TOKEN_PROBABILITY = 0.01
const MAX_TOKEN_PROBABILITY = 0.99

/** Minimum token length (characters) — drops fragments and most
 * single/double-letter noise. */
const MIN_TOKEN_LENGTH = 3

// ---------------------------------------------------------------------------
// Tokenizer + pure classifier core
// ---------------------------------------------------------------------------

/**
 * Lowercase, split on non-alphanumerics, drop <3-char tokens, cap at
 * MAX_TOKENS_PER_DOCUMENT in document order. Pure — the same text always
 * yields the same tokens.
 */
export function tokenizeJunkText(text: string): string[] {
  const lowered = text.toLowerCase()
  const tokens: string[] = []
  // One regex pass: runs of [a-z0-9] are tokens, everything else splits.
  const matches = lowered.match(/[a-z0-9]+/g) ?? []
  for (const token of matches) {
    if (token.length < MIN_TOKEN_LENGTH) continue
    tokens.push(token)
    if (tokens.length >= MAX_TOKENS_PER_DOCUMENT) break
  }
  return tokens
}

/**
 * One account's trained state, preloaded once per pass (the same shape
 * the engines hand the ingestion hook as the rules/schedules/blocklist
 * config — never queried per message). Built ONLY by loadJunkFilterConfig,
 * which refuses non-IMAP accounts: the gmail exemption (D19) is enforced
 * at the single point configs are made.
 */
export interface JunkFilterConfig {
  /** token → its trained counters (the account's whole junk_tokens set). */
  tokens: Map<string, { spamCount: number; hamCount: number }>
  /** Trained document counts (the training-sample gate's input). */
  spamDocuments: number
  hamDocuments: number
}

/**
 * The classification of one message: its posterior plus the inputs the
 * auto-move gate needs — the hook stamps this on the outcome and the
 * filing step re-checks the gate before moving anything.
 */
export interface JunkVerdict {
  posterior: number
  spamDocuments: number
}

/**
 * The pure classifier (see the model comment): posterior ∈ [0, 1], exactly
 * 0.5 when the store knows none of the document's tokens. Deterministic
 * end to end — same config + text always yields the same number.
 */
export function classifyJunkTokens(
  tokens: string[],
  config: JunkFilterConfig
): number {
  const distinct = new Set(tokens)
  const scored: { p: number; distance: number; token: string }[] = []
  for (const token of distinct) {
    const counts = config.tokens.get(token)
    if (!counts) continue // unknown token: neutral, contributes nothing
    const total = counts.spamCount + counts.hamCount
    if (total <= 0) continue // unreachable via training, guarded anyway
    const raw = counts.spamCount / total
    const p = Math.min(
      MAX_TOKEN_PROBABILITY,
      Math.max(MIN_TOKEN_PROBABILITY, raw)
    )
    scored.push({ p, distance: Math.abs(p - 0.5), token })
  }
  if (scored.length === 0) return 0.5
  // Most interesting first; lexicographic tiebreak keeps the selection
  // deterministic across engines (stable sort alone is not a contract).
  scored.sort((a, b) => b.distance - a.distance || (a.token < b.token ? -1 : 1))
  let logSpam = 0
  let logHam = 0
  for (const { p } of scored.slice(0, MAX_CLASSIFIED_TOKENS)) {
    logSpam += Math.log(p)
    logHam += Math.log(1 - p)
  }
  // posterior = Πp / (Πp + Π(1−p)) — computed as the logistic of the log
  // odds so long token lists never underflow.
  return 1 / (1 + Math.exp(logHam - logSpam))
}

/**
 * Full classification of one message's text (subject + body): tokenize,
 * score against the preloaded config. Pure given its inputs.
 */
export function classifyJunkText(
  subject: string | null,
  bodyText: string | null,
  config: JunkFilterConfig
): number {
  const text = `${subject ?? ""}\n${bodyText ?? ""}`
  return classifyJunkTokens(tokenizeJunkText(text), config)
}

/**
 * The auto-move gate (D19): high posterior AND a sufficient training
 * sample. Below either bound the message is delivered normally; there is
 * no auto-delete anywhere — the strongest outcome is spam placement.
 */
export function shouldAutoMove(
  posterior: number,
  spamDocuments: number,
  thresholds: {
    posteriorThreshold?: number
    minSpamDocuments?: number
  } = {}
): boolean {
  return (
    posterior >= (thresholds.posteriorThreshold ?? JUNK_AUTO_MOVE_THRESHOLD) &&
    spamDocuments >=
      (thresholds.minSpamDocuments ?? JUNK_MIN_TRAINING_SPAM_EVENTS)
  )
}

// ---------------------------------------------------------------------------
// Config loading (the engines' once-per-pass preload)
// ---------------------------------------------------------------------------

/**
 * The D19 guard + preload in one call: IMAP account with the per-account
 * toggle on, holding the account's whole token store and its trained
 * document counts. Returns null — meaning "the filter is inert for this
 * account" — when the account is missing, NOT imap (gmail is exempt:
 * server-side filtering already exists), the toggle is off (the default),
 * or the store read fails (fail toward off). The sync engines call this
 * once per pass and hand the config to the ingestion hook; nothing
 * classifies without one.
 */
export async function loadJunkFilterConfig(
  executor: SqlExecutor,
  accountId: string
): Promise<JunkFilterConfig | null> {
  const account = await getAccount(executor, accountId)
  if (!account || account.type !== "imap") return null
  if (!(await getJunkFilterEnabled(executor, accountId))) return null
  const [rows, training] = await Promise.all([
    listJunkTokens(executor, accountId),
    readTrainingSample(executor, accountId),
  ])
  const tokens = new Map<string, { spamCount: number; hamCount: number }>()
  for (const row of rows) {
    tokens.set(row.token, {
      spamCount: row.spam_count,
      hamCount: row.ham_count,
    })
  }
  return {
    tokens,
    spamDocuments: training.spamDocuments,
    hamDocuments: training.hamDocuments,
  }
}

/**
 * Whether explicit user mark-spam/not-spam actions should TRAIN this
 * account (the thread-actions hook points' guard): IMAP + opt-in only —
 * gmail never trains (D19), with the toggle off nothing trains either, so
 * the disabled state leaves no residue.
 */
export async function junkFilterTrainingActive(
  executor: SqlExecutor,
  accountId: string
): Promise<boolean> {
  const account = await getAccount(executor, accountId)
  if (!account || account.type !== "imap") return false
  return getJunkFilterEnabled(executor, accountId)
}

// ---------------------------------------------------------------------------
// Training (explicit user actions only — see the module comment)
// ---------------------------------------------------------------------------

/** Settings key holding one account's trained document counts — the
 * training-sample gate's counter (`mail.junkFilterTraining:<accountId>`,
 * JSON; the same per-account namespacing the other per-account settings
 * use). Lives beside the token counts so the gate reads in one round
 * trip, and so training stays counter-only, exactly like the tokens. */
function trainingSampleSettingKey(accountId: string): string {
  return `mail.junkFilterTraining:${accountId}`
}

interface JunkTrainingSample {
  spamDocuments: number
  hamDocuments: number
}

const EMPTY_TRAINING_SAMPLE: JunkTrainingSample = {
  spamDocuments: 0,
  hamDocuments: 0,
}

/** The stored document counts; corrupt rows read as empty (never throw). */
async function readTrainingSample(
  executor: SqlExecutor,
  accountId: string
): Promise<JunkTrainingSample> {
  const stored = await getSetting<unknown>(
    executor,
    trainingSampleSettingKey(accountId),
    EMPTY_TRAINING_SAMPLE
  )
  if (typeof stored !== "object" || stored === null)
    return EMPTY_TRAINING_SAMPLE
  const candidate = stored as {
    spamDocuments?: unknown
    hamDocuments?: unknown
  }
  return {
    spamDocuments:
      typeof candidate.spamDocuments === "number" ? candidate.spamDocuments : 0,
    hamDocuments:
      typeof candidate.hamDocuments === "number" ? candidate.hamDocuments : 0,
  }
}

/**
 * Train one document (a message's text) as spam (true) or ham (false):
 * each distinct token's counter +1 (presence-based — a repeated word is
 * one vote per document, matching the classifier's reading) and the
 * account's document counter +1. Repeat training of similar mail simply
 * accumulates confidence — that IS the "rising confidence" spec behavior.
 */
export async function trainJunkDocument(
  executor: SqlExecutor,
  accountId: string,
  text: string,
  spam: boolean
): Promise<void> {
  const tokens = new Set(tokenizeJunkText(text))
  for (const token of tokens) {
    await bumpJunkToken(executor, accountId, token, spam)
  }
  const training = await readTrainingSample(executor, accountId)
  const next: JunkTrainingSample = spam
    ? { ...training, spamDocuments: training.spamDocuments + 1 }
    : { ...training, hamDocuments: training.hamDocuments + 1 }
  await setSetting(executor, trainingSampleSettingKey(accountId), next)
}

/**
 * Train from a thread's messages — the shape the mark-spam / not-spam
 * hooks need (the D10 local mutation already loaded them). Text per
 * message is subject + body_text (the spec's "keep it simple" source);
 * messages with no text at all still count as documents (the user acted
 * on them) but contribute no tokens. One bump transaction per message;
 * callers isolate failures.
 */
export async function trainJunkFromMessages(
  executor: SqlExecutor,
  accountId: string,
  messages: ReadonlyArray<Pick<MessageRow, "subject" | "body_text">>,
  spam: boolean
): Promise<void> {
  for (const message of messages) {
    const text = `${message.subject ?? ""}\n${message.body_text ?? ""}`
    await trainJunkDocument(executor, accountId, text, spam)
  }
}
