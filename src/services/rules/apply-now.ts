import type { SqlExecutor } from "../db/executor"
import { buildThreadSearchSql } from "../search/query-builder"
import { applyRuleActions, parseActionsJson } from "./actions"
import { parseRuleCriteria } from "./criteria"
import type { RuleRow } from "./db"

/**
 * "Apply now" (task 11.4, design D5): run an existing rule over the mail
 * ALREADY STORED, on demand, instead of waiting for new arrivals.
 *
 * Matching substrate — THREAD level, via the search SQL compiler. A rule's
 * criteria are the search-box language, and the project's compiled matcher
 * for stored mail is buildThreadSearchSql (search/query-builder.ts), the
 * same pipeline the search box and the split counts run. So "apply now"
 * finds the THREADS of the account matching the criteria with
 * parseRuleCriteria → buildThreadSearchSql, then applies the rule's
 * actions to each matched thread through applyRuleActions (rules/actions.ts)
 * — the exact path the ingestion hook takes, so every action is local-first
 * + queue op (D10) and server replay comes free. This is the deliberate
 * thread-level reading of D5's "the same compiled matcher": rules act on
 * threads (all actions are thread actions), and per-message criteria
 * semantics (rules/criteria.ts) exist only at ingestion where a single
 * fresh message is in hand.
 *
 * The confirmation gate is the mitigation for the D5 risk note (a bad
 * criterion + apply-now over 50k messages): the caller FIRST shows
 * countMatchingThreads' number and requires the user to confirm; only then
 * does it call applyRuleNow — and even that call must pass
 * `confirmed: true` literally, so the destructive path cannot be reached
 * by accident (see RuleNotConfirmedError). The built query carries NO
 * limit: the count the user confirms is the total, and the apply acts on
 * the full match set — bounded by the human in the loop, not by a page
 * size.
 *
 * applyRuleNow re-counts at apply time (state may have drifted between the
 * dialog's count and the click) and reports what it actually did:
 * `matched` is the apply-time match size, `applied` the threads where at
 * least one action took effect.
 */

/** Thrown by applyRuleNow when `confirmed: true` was not passed. Nothing
 * is matched, nothing applied — the caller skipped the confirmation gate. */
export class RuleNotConfirmedError extends Error {
  constructor(ruleId: string) {
    super(
      `apply-now for rule ${ruleId} refused: the caller must pass ` +
        "confirmed: true after showing the matched-count summary"
    )
    this.name = "RuleNotConfirmedError"
  }
}

/** What applyRuleNow reports back (the dialog's result summary). */
export interface ApplyRuleNowResult {
  /** Threads matching the criteria at APPLY time (the re-count — may be
   * lower than the count the confirmation dialog showed). */
  matched: number
  /** Matched threads where at least one action actually applied. A rule
   * whose actions all no-op (e.g. add_labels with only unknown names)
   * reports 0; per-thread failures (warned and skipped, below) don't count. */
  applied: number
}

/**
 * Count the account's threads matching a rule's criteria_json — the number
 * the confirmation dialog shows. Unusable criteria (parseRuleCriteria →
 * null) count 0: a criteria-less rule matches nothing, at ingestion and
 * here alike.
 */
export async function countMatchingThreads(
  executor: SqlExecutor,
  accountId: string,
  criteriaJson: string
): Promise<number> {
  const parsed = parseRuleCriteria(criteriaJson)
  if (!parsed) return 0
  const { sql, params } = buildThreadSearchSql(accountId, parsed, {
    countOnly: true,
  })
  const rows = await executor.select<{ count: number }>(sql, params)
  return rows[0]?.count ?? 0
}

/**
 * Apply a rule's actions to every thread of the account matching its
 * criteria. REFUSES to run unless `options.confirmed` is literally true —
 * the caller (the Apply-now dialog) shows countMatchingThreads' summary
 * and collects the user's confirmation first. The match set is recomputed
 * here (the full, unlimited query): whatever changed since the dialog is
 * reflected in the returned `matched`.
 *
 * Actions apply per matched thread through applyRuleActions (same as
 * ingestion). A thread whose apply throws — deleted mid-run by a competing
 * sync, missing provider refs, a broken action — is warned and SKIPPED, not
 * fatal: one bad thread must not abort the run (mirrors the ingestion
 * hook's per-rule isolation), and the earlier threads stay durably applied
 * (thread-actions is local-first).
 */
export async function applyRuleNow(
  executor: SqlExecutor,
  accountId: string,
  rule: RuleRow,
  options: { confirmed: boolean }
): Promise<ApplyRuleNowResult> {
  if (options?.confirmed !== true) {
    throw new RuleNotConfirmedError(rule.id)
  }
  const parsed = parseRuleCriteria(rule.criteria_json)
  if (!parsed) return { matched: 0, applied: 0 }
  const actions = parseActionsJson(rule.actions_json)

  // No limit option: the apply acts on the whole match set (see the module
  // comment) — the human confirmation is the bound, not a page size.
  const { sql, params } = buildThreadSearchSql(accountId, parsed)
  const matchedRows = await executor.select<{ id: string }>(sql, params)

  let applied = 0
  for (const row of matchedRows) {
    try {
      const appliedActions = await applyRuleActions(
        executor,
        accountId,
        row.id,
        actions
      )
      if (appliedActions.length > 0) applied += 1
    } catch (error) {
      console.warn(
        `[rules] apply-now: rule "${rule.name}" (${rule.id}) failed on ` +
          `thread ${row.id}; thread skipped, run continues`,
        error
      )
    }
  }
  return { matched: matchedRows.length, applied }
}
