/**
 * Authentication-Results parsing, TypeScript side (task 2.1, design D10).
 *
 * Design D10 assumed BOTH ingestion paths would parse Authentication-
 * Results in Rust. The shipped architecture differs for Gmail: Gmail REST
 * is called TypeScript-side (plugin-http), so its headers never transit
 * Rust. To honor the design's intent — parse ONCE at ingestion, never at
 * display time — the Gmail path parses here with the SAME compact storage
 * format and the SAME worst-wins consolidation rule as the Rust parser
 * (src-tauri/src/imap/auth_results.rs). Keep the two grammars in sync.
 *
 * Storage format (messages.auth_results): ONE compact string over all of
 * the message's Authentication-Results headers —
 *
 *   spf=pass;dkim=fail;dmarc=none
 *
 * - only the three mechanisms, lowercase, fixed order spf → dkim → dmarc,
 *   `;`-separated without spaces;
 * - a mechanism no header evaluated is omitted;
 * - no headers (or no parseable evaluations) → null, the spec's
 *   "no headers → no badge";
 * - consolidation across multiple headers: WORST OBSERVED VALUE WINS per
 *   mechanism, severity fail > softfail/quasi (softfail, neutral,
 *   temperror, permerror, policy) > pass > none (ties keep the first
 *   observation) — a later hop downgrading an earlier pass to a fail must
 *   not be lost.
 */

/** The three tracked mechanisms in fixed storage order. */
const MECHANISMS = ["spf", "dkim", "dmarc"] as const

/** RFC 8601 result token → (stored token, severity). Higher severity =
 * worse. Unknown/extension tokens carry no trustworthy verdict and fold
 * into `none` rather than fabricating a state — mirrors classify() in the
 * Rust parser. */
function classify(result: string): { token: string; severity: number } {
  switch (result.toLowerCase()) {
    case "pass":
      return { token: "pass", severity: 1 }
    case "fail":
      return { token: "fail", severity: 3 }
    case "softfail":
    case "neutral":
    case "temperror":
    case "permerror":
    case "policy":
      return { token: result.toLowerCase(), severity: 2 }
    default:
      return { token: "none", severity: 0 }
  }
}

/**
 * Consolidate every Authentication-Results header value of one message
 * (in header order) into the compact verdict string; null when no header
 * evaluated any of the three mechanisms.
 */
export function parseAuthResults(
  headerValues: (string | undefined)[]
): string | undefined {
  // Per-mechanism worst-so-far, indexed alongside MECHANISMS.
  const worst = new Map<string, { token: string; severity: number }>()
  let sawAuthHeader = false

  for (const value of headerValues) {
    if (value === undefined) continue
    sawAuthHeader = true
    // Tolerant split: `;`-separated properties, folding whitespace, the
    // authserv-id prefix, per-method properties (smtp.mailfrom=,
    // header.d=, header.from=) and "(comments)" all fall away because only
    // exact spf=/dkim=/dmarc= tokens are recognized.
    for (const token of value.split(/[;\s]+/)) {
      const equals = token.indexOf("=")
      if (equals <= 0) continue
      const method = token.slice(0, equals).toLowerCase()
      if (!(MECHANISMS as readonly string[]).includes(method)) continue
      const outcome = classify(token.slice(equals + 1))
      const incumbent = worst.get(method)
      // Strictly-worse replaces; ties keep the first observation.
      if (!incumbent || outcome.severity > incumbent.severity) {
        worst.set(method, outcome)
      }
    }
  }

  if (!sawAuthHeader || worst.size === 0) return undefined
  return MECHANISMS.filter((mechanism) => worst.has(mechanism))
    .map((mechanism) => `${mechanism}=${worst.get(mechanism)!.token}`)
    .join(";")
}

// ---------------------------------------------------------------------------
// Stored-string accessor (task 2.2, design D10) — the display side
// ---------------------------------------------------------------------------

/** The tri-state verdict the badge renders per mechanism. */
export type AuthVerdict = "pass" | "fail" | "none"

/** A mechanism may be absent (no header evaluated it) — only the
 * mechanisms present in the stored string appear as keys. */
export type StoredAuthResults = Partial<Record<Mechanism, AuthVerdict>>

type Mechanism = (typeof MECHANISMS)[number]

/** Stored result token → display verdict. The ingestion parsers store the
 * full RFC 8601 token set, but the badge is tri-state: `pass` and `fail`
 * map through; the quasi-fail family (softfail, neutral, temperror,
 * permerror, policy) and the unknown-token `none` carry no trustworthy
 * verdict and all render as the neutral `none` state — consistent with
 * classify() folding them above. */
const DISPLAY_VERDICTS: Record<string, AuthVerdict> = {
  pass: "pass",
  fail: "fail",
  softfail: "none",
  neutral: "none",
  temperror: "none",
  permerror: "none",
  policy: "none",
  none: "none",
}

/**
 * Parse the STORED messages.auth_results string (the inverse of
 * parseAuthResults' output shape) for display. This is the single accessor
 * the UI reads the column through, so one module owns the storage format.
 *
 * Returns null for null/empty/unparseable input (no usable mechanism
 * verdict — the spec's "no data → no badge"), else a map holding ONLY the
 * mechanisms present, in fixed storage order. Tolerates whitespace and
 * keeps the first observation of a duplicated mechanism (our writers never
 * emit one; tolerance keeps a hand-edited row from crashing the pane).
 */
export function parseStoredAuthResults(
  stored: string | null | undefined
): StoredAuthResults | null {
  if (!stored) return null
  const parsed: StoredAuthResults = {}
  let count = 0
  for (const segment of stored.split(/[;\s]+/)) {
    const equals = segment.indexOf("=")
    if (equals <= 0) continue
    const method = segment.slice(0, equals).toLowerCase()
    if (!(MECHANISMS as readonly string[]).includes(method)) continue
    if (parsed[method as Mechanism] !== undefined) continue
    const verdict = DISPLAY_VERDICTS[segment.slice(equals + 1).toLowerCase()]
    if (!verdict) continue
    parsed[method as Mechanism] = verdict
    count += 1
  }
  return count > 0 ? parsed : null
}
