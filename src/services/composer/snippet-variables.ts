import { format } from "date-fns"

/**
 * Snippet `{{variable}}` substitution (task 2.3, design D11): a pure,
 * storage-free pass over snippet text performed at insertion time
 * (snippet-insert.ts). Design D11 is deliberate that this is a
 * substitution LAYER only — snippets stay plain text in the database and
 * nothing here touches storage. Ids resolvable from the compose context
 * fill automatically; ids without a value are reported back (unique, in
 * first-appearance order) so the caller can prompt ONCE per id and re-run
 * the substitution with the answers. Pure and React-free so the rules are
 * unit-testable without a component tree.
 */

/**
 * One registry row (task 2.4, design D11): the id plus the copy the UI
 * renders about it — the dialog label, a one-line description for the
 * Settings → Snippets legend, and an example of the resolved value.
 */
export interface SnippetVariableMeta {
  id: string
  label: string
  description: string
  example: string
}

/**
 * The variable registry with its per-variable UI metadata (task 2.4,
 * design D11) — the ONE source of truth for the id list: the picker hint,
 * the Settings → Snippets "Template variables" legend and the prompt
 * dialog labels all render from these rows, and the substitution switch
 * below resolves exactly these ids. Anything outside this list is a
 * user-invented id: it can never resolve from context and always lands in
 * the prompt list.
 */
export const SNIPPET_VARIABLES = [
  {
    id: "first_name",
    label: "First name",
    description:
      "The recipient's first name, from the display name or derived from the email local-part (jane.doe@… → Jane).",
    example: "Jane",
  },
  {
    id: "last_name",
    label: "Last name",
    description:
      "The recipient's last name — only when their name has one; a single-word name prompts instead of guessing.",
    example: "Doe",
  },
  {
    id: "full_name",
    label: "Full name",
    description:
      "The recipient's full name, as typed or rebuilt from the email local-part.",
    example: "Jane Doe",
  },
  {
    id: "email",
    label: "Recipient email",
    description:
      "The first To recipient's address, exactly as typed in the draft.",
    example: "jane.doe@acme.com",
  },
  {
    id: "my_name",
    label: "Your name",
    description: "The composing account's display name.",
    example: "Alex Chen",
  },
  {
    id: "my_email",
    label: "Your email address",
    description: "The composing account's email address.",
    example: "alex@chen.dev",
  },
  {
    id: "date",
    label: "Today's date",
    description: "Today, resolved at insertion time, in the long date format.",
    example: "Friday, September 18th, 2026",
  },
] as const

export type SnippetVariableId = (typeof SNIPPET_VARIABLES)[number]["id"]

/** Registry ids in display order — derived, so SNIPPET_VARIABLES stays
 * the only place the list is written. */
export const SNIPPET_VARIABLE_IDS: readonly SnippetVariableId[] =
  SNIPPET_VARIABLES.map((variable) => variable.id)

/** Human labels for registry ids — the prompt dialog labels its inputs
 * with these (user-invented ids fall back to their raw text). Derived
 * from SNIPPET_VARIABLES for the same single-source reason. */
export const SNIPPET_VARIABLE_LABELS: Record<SnippetVariableId, string> =
  Object.fromEntries(
    SNIPPET_VARIABLES.map((variable) => [variable.id, variable.label])
  ) as Record<SnippetVariableId, string>

/**
 * The compose context variables resolve against. Everything is optional:
 * an absent value simply leaves its variables to be prompted rather than
 * silently inserting an empty string (spec: variables without a known
 * value prompt). `recipient` is the draft's first To-recipient exactly as
 * typed (composer-store keeps raw input — no normalization, display names
 * may be absent); `today` is injectable so tests can pin the date.
 */
export interface SnippetVariableContext {
  recipient?: { name?: string; email: string } | null
  myName?: string | null
  myEmail?: string | null
  today?: Date
}

/**
 * Values the prompt dialog collected, keyed by variable id as it appears
 * inside the braces (already whitespace-trimmed). An answer that is
 * present and non-blank overrides every other resolution for its id and
 * applies to ALL occurrences (spec: one prompt, applied everywhere); a
 * blank answer counts as "not answered" and keeps the placeholder literal
 * so the user can still fill it in the draft by hand.
 */
export type SnippetVariableAnswers = Readonly<Record<string, string>>

/**
 * A person's name split the two ways the registry needs it. `last` is null
 * for a single-token name — the heuristic never invents a surname, so
 * `{{last_name}}` stays promptable instead of guessing.
 */
interface PersonName {
  first: string
  last: string | null
  full: string
}

function personNameFromTokens(tokens: string[]): PersonName | null {
  if (tokens.length === 0) return null
  return {
    first: tokens[0],
    last: tokens.length > 1 ? tokens[tokens.length - 1] : null,
    full: tokens.join(" "),
  }
}

/** Display names are used as typed (trimmed, split on whitespace). */
function personNameFromDisplayName(name: string): PersonName | null {
  return personNameFromTokens(name.trim().split(/\s+/).filter(Boolean))
}

/**
 * Heuristic (task 2.3): recipients are raw typed input, so a chip with no
 * display name still yields person variables from the email local-part —
 * "jane.doe@x.com" → first "Jane", last "Doe", full "Jane Doe". The
 * plus-tag of a plus-address is stripped first, the rest splits on the
 * usual ./_/- separators, and tokens are capitalized (an email's casing is
 * not meaningful, unlike a typed display name's).
 */
function personNameFromEmail(email: string): PersonName | null {
  const atIndex = email.lastIndexOf("@")
  const localPart = (atIndex === -1 ? email : email.slice(0, atIndex))
    .replace(/\+.*$/, "")
    .trim()
  const tokens = localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map(
      (token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
    )
  return personNameFromTokens(tokens)
}

/** Resolve one registry id from the context; null = no known value (the
 * id joins the prompt list). */
function resolveVariable(
  id: string,
  context: SnippetVariableContext
): string | null {
  // Recipient person variables: a typed display name wins; the email
  // local-part heuristic covers the (common) name-less chip.
  const personName = context.recipient
    ? (personNameFromDisplayName(context.recipient.name ?? "") ??
      personNameFromEmail(context.recipient.email))
    : null
  switch (id) {
    case "first_name":
      return personName?.first ?? null
    case "last_name":
      return personName?.last ?? null
    case "full_name":
      return personName?.full ?? null
    case "email":
      return context.recipient?.email.trim() || null
    case "my_name":
      return context.myName?.trim() || null
    case "my_email":
      return context.myEmail?.trim() || null
    // Human-format today (date-fns long local date, e.g. "Friday,
    // September 18th, 2026"). Resolved per insertion, so a draft held
    // overnight picks the date up on the next snippet insertion.
    case "date":
      return format(context.today ?? new Date(), "PPPP")
    default:
      return null
  }
}

/**
 * One `{{id}}` placeholder. Optional whitespace inside the braces is
 * tolerated (`{{ first_name }}` ≡ `{{first_name}}`) because snippet bodies
 * are hand-typed; the captured id is brace-free. A `{{` with no matching
 * `}}` never matches and passes through verbatim.
 */
const VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g

/**
 * Unique `{{id}}` ids appearing in a snippet body, in first-appearance
 * order (task 2.4, design D11): the picker uses this to annotate entries
 * whose body uses variables. Purely lexical — ids are NOT checked against
 * the registry here, so user-invented ids count too, exactly as they
 * would at substitution time.
 */
export function snippetVariableIdsInBody(body: string): string[] {
  const ids = new Set<string>()
  for (const match of body.matchAll(VARIABLE_PATTERN)) ids.add(match[1])
  return [...ids]
}

export interface SnippetSubstitution {
  /** The substituted text; unresolved placeholders are left literal. */
  text: string
  /** Unique ids that had no value, in first-appearance order — one entry
   * per id no matter how often it occurs (spec: prompt once). */
  unknownVariables: string[]
}

/**
 * Replace every `{{id}}` placeholder in a snippet body: prompt answers
 * first (applied to all occurrences), then registry variables from the
 * compose context. Anything unresolved stays literal `{{id}}` in the text
 * and is reported in `unknownVariables`. Single pass — a substituted VALUE
 * is never rescanned, so answers containing `{{...}}` insert verbatim.
 */
export function substituteSnippetVariables(
  body: string,
  context: SnippetVariableContext,
  answers: SnippetVariableAnswers = {}
): SnippetSubstitution {
  const unknown = new Set<string>()
  const text = body.replace(VARIABLE_PATTERN, (placeholder, id: string) => {
    const answer = answers[id]
    if (answer !== undefined && answer.trim() !== "") return answer
    const resolved = resolveVariable(id, context)
    if (resolved !== null) return resolved
    unknown.add(id)
    // Left literal on purpose: the caller prompts and re-runs the
    // substitution with the answers (menu path), or the placeholder stays
    // editable text (keyboard path — see snippet-insert.ts).
    return placeholder
  })
  return { text, unknownVariables: [...unknown] }
}
