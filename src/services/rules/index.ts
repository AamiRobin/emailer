/**
 * Local mail rules (task 11, design D5): criteria reuse the search parser's
 * operator language, actions compile onto the existing queue op kinds via
 * the thread-actions service, and the ingestion hook (ingestion.ts) runs
 * enabled rules per newly inserted message in deterministic order BEFORE
 * the sync engines finalize their new-mail notification count.
 */

export {
  listRules,
  listEnabledRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  type RuleRow,
} from "./db"
export { parseRuleCriteria, messageMatchesCriteria } from "./criteria"
export {
  applyRuleActions,
  parseActionsJson,
  RULE_ACTION_TYPES,
  SUPPRESSES_NOTIFICATION,
  type RuleAction,
  type RuleActionType,
} from "./actions"
export {
  runIngestionRules,
  applyBlockedSenderFiling,
  ingestionEventFromInput,
  type IngestionEvent,
  type IngestionRuleOutcome,
} from "./ingestion"
export {
  countMatchingThreads,
  applyRuleNow,
  RuleNotConfirmedError,
  type ApplyRuleNowResult,
} from "./apply-now"
