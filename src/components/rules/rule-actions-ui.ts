import type { Category, RuleAction, RuleActionType } from "@/services/rules"

/**
 * Non-component pieces of the rule dialog, split out so the dialog file
 * stays a components-only module (react-refresh). The criteria help text
 * and the action vocabulary mirror services/search/parser.ts (the exact
 * operator set) and services/rules/actions.ts (the closed action union).
 */

export const CRITERIA_HELP =
  "Same language as the search box: from: to: subject: label: " +
  "has:attachment is:unread is:starred larger: smaller: before: after:, " +
  "a leading - negates (e.g. -from:boss@x.com), plus plain words that must " +
  "appear in the subject or the snippet. Values of the same operator match " +
  "either value; different operators must all match."

export const ACTION_TYPE_OPTIONS: { value: RuleActionType; label: string }[] = [
  { value: "archive", label: "Archive" },
  { value: "trash", label: "Trash" },
  { value: "mark_as_spam", label: "Mark as spam" },
  { value: "mark_read", label: "Mark read" },
  { value: "star", label: "Star" },
  { value: "add_labels", label: "Add labels" },
  { value: "remove_labels", label: "Remove labels" },
  { value: "move", label: "Move to folder (imap)" },
  // Task 3.4 (design D4): names a category for the categorization pass —
  // no delivery effect (the executor ignores it; no announcement change).
  { value: "set_category", label: "Set category" },
]

/** Category values as the UI shows them (the storage values are
 * lowercase; the tabs are titled with the capitalized forms). */
export const CATEGORY_LABELS: Record<Category, string> = {
  primary: "Primary",
  updates: "Updates",
  promotions: "Promotions",
  social: "Social",
  newsletters: "Newsletters",
}

export function actionChipLabel(action: RuleAction): string {
  switch (action.type) {
    case "archive":
      return "Archive"
    case "trash":
      return "Trash"
    case "mark_as_spam":
      return "Mark as spam"
    case "mark_read":
      return "Mark read"
    case "star":
      return "Star"
    case "add_labels":
      return `Label: ${(action.labels ?? []).join(", ")}`
    case "remove_labels":
      return `Remove: ${(action.labels ?? []).join(", ")}`
    case "move":
      return `Move: ${action.folder ?? ""}`
    case "set_category":
      return `Category: ${CATEGORY_LABELS[action.category ?? "primary"]}`
  }
}

/** Inverse of db.ts's storage wrapper: the raw query inside criteria_json
 * (a bare JSON string is tolerated, same as parseRuleCriteria). */
export function queryFromCriteriaJson(criteriaJson: string): string {
  try {
    const stored: unknown = JSON.parse(criteriaJson)
    if (typeof stored === "string") return stored
    if (typeof stored === "object" && stored !== null) {
      const query = (stored as { query?: unknown }).query
      if (typeof query === "string") return query
    }
  } catch {
    // Corrupt criteria render as an empty query — edit re-saves it fixed.
  }
  return ""
}
