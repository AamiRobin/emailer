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
// The condition-operator vocabulary (parity-round-2 task 2.5) joins the
// barrel: the rule-assist prompt composes from it, beside the action
// vocabulary it already reads from here.
export { RULE_CONDITION_OPERATORS } from "./criteria"
export {
  applyRuleActions,
  parseActionsJson,
  RULE_ACTION_TYPES,
  SUPPRESSES_NOTIFICATION,
  type RuleAction,
  type RuleActionType,
} from "./actions"
// The category vocabulary the set_category action names (task 3.4) —
// re-exported so the rules UI (dialog select, action chips) reads it from
// the rules module it belongs to.
export { CATEGORIES, type Category } from "../categorization/classify"
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
