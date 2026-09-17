import type { SqlExecutor } from "./executor"

/**
 * Per-sender / per-label notification rules (task 8.1, design D16): CRUD
 * over the `notification_rules` table plus the resolution helper the sync
 * engines apply to every newly inserted message beside the existing mute
 * gate. Rules only gate the new-mail ANNOUNCEMENT (the engine summary's
 * newMessages count, which the scheduler forwards to notifyNewMail) —
 * suppressed messages are still stored, stay unread, keep their
 * thread-level unread dots and keep counting toward the OS badge total
 * (getTotalUnreadCount is deliberately rule-blind; the badge/disagreement
 * trade-off is accepted per D16 and explained in the settings copy).
 *
 * Resolution semantics, evaluated per message over ALL of the account's
 * rules:
 * - a rule matches when match_type is "sender" and the value equals the
 *   message's From address (case-insensitive), or match_type is "label"
 *   and the value equals one of the message's label names exactly (case-
 *   insensitive) or one of their trailing "/segment" leaves — the same
 *   convention the search label: operator uses (query-builder.ts);
 * - no matching rule → "notify" (the plain account behavior);
 * - any matching "never" rule → "suppress" — among competing matches
 *   "never" dominates "always" (the conservative reading: one explicit
 *   opt-out wins, so e.g. a label-wide opt-out beats a sender opt-in);
 * - only "always" rules match → "notify". With no global default to
 *   override, "always" is intentionally inert at this seam: it can never
 *   force a count (mute stays stronger — a muted thread is never
 *   announced), it documents the VIP intent and matters once a broader
 *   "never" would otherwise also match.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

export type NotificationRuleMatchType = "sender" | "label"
export type NotificationRuleAction = "always" | "never"

export interface NotificationRuleRow {
  id: string
  account_id: string
  match_type: NotificationRuleMatchType
  match_value: string
  action: NotificationRuleAction
  created_at: number
}

/** "notify" = count the message as new; "suppress" = store it silently. */
export type NotificationDecision = "notify" | "suppress"

/** The account's rules, oldest first (creation order, id breaks ties). */
export async function listNotificationRules(
  executor: SqlExecutor,
  accountId: string
): Promise<NotificationRuleRow[]> {
  return executor.select<NotificationRuleRow>(
    `SELECT * FROM notification_rules
     WHERE account_id = $1
     ORDER BY created_at ASC, id ASC`,
    [accountId]
  )
}

/**
 * Insert a rule with a fresh UUID; returns the generated id. The table's
 * UNIQUE(account_id, match_type, match_value) constraint rejects exact
 * duplicates — the settings UI surfaces that as a form error.
 */
export async function addNotificationRule(
  executor: SqlExecutor,
  input: {
    accountId: string
    matchType: NotificationRuleMatchType
    matchValue: string
    action: NotificationRuleAction
  }
): Promise<string> {
  const id = crypto.randomUUID()
  await executor.execute(
    `INSERT INTO notification_rules (id, account_id, match_type, match_value, action)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, input.accountId, input.matchType, input.matchValue, input.action]
  )
  return id
}

/** Delete a rule (no-op when the id is unknown; account deletion cascades). */
export async function removeNotificationRule(
  executor: SqlExecutor,
  ruleId: string
): Promise<void> {
  await executor.execute("DELETE FROM notification_rules WHERE id = $1", [
    ruleId,
  ])
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Sender match: the whole address, case-insensitive. */
function matchesSender(ruleValue: string, senderAddress: string): boolean {
  return ruleValue.toLowerCase() === senderAddress.toLowerCase()
}

/**
 * Label match, mirroring the search label: operator (query-builder.ts):
 * the value matches a label name exactly (case-insensitive) or as its
 * trailing "/segment" — "Receipts" matches "Receipts" and "Finance/
 * Receipts", but not "Receipts/2024".
 */
function matchesLabel(ruleValue: string, labelName: string): boolean {
  const value = ruleValue.toLowerCase()
  const name = labelName.toLowerCase()
  return name === value || name.endsWith(`/${value}`)
}

/**
 * Resolve the notification decision for one message. Pure so the sync
 * engines can load the account's rules ONCE per pass (listNotificationRules)
 * and apply them per message without extra queries. Sender rules need the
 * From address, label rules the message's label NAMES (gmail: resolved
 * through the labels table; imap: the folder path — the folder label's
 * name); a message without either simply never matches.
 */
export function resolveNotificationDecision(
  rules: readonly NotificationRuleRow[],
  senderAddress: string | null | undefined,
  labelNames: readonly string[] | null
): NotificationDecision {
  for (const rule of rules) {
    if (rule.action !== "never") continue
    const hit =
      rule.match_type === "sender"
        ? senderAddress != null &&
          matchesSender(rule.match_value, senderAddress)
        : (labelNames?.some((name) => matchesLabel(rule.match_value, name)) ??
          false)
    // Conservative dominance: any explicit opt-out settles it, whatever
    // order the rules come in. An "always" match alone changes nothing —
    // without it the outcome is the default "notify" anyway.
    if (hit) return "suppress"
  }
  return "notify"
}
