import type { SqlExecutor } from "../db/executor"
import type { Category } from "../categorization/classify"
import { CATEGORIES } from "../categorization/classify"
import type { LabelRow } from "../db/labels"
import { findLabelByImapFolder } from "../db/labels"
import { getAccount } from "../db/accounts"
import { getThreadWithMessages } from "../db/threads"
import {
  applyLabelsToThread,
  archiveThread,
  markSpam,
  moveThreadToFolder,
  setThreadRead,
  setThreadStarred,
  trashThread,
} from "../email-actions/thread-actions"
import { buildMessageRefs } from "../email-actions/message-refs"
import { enqueueMove } from "../queue/operation"

/**
 * Rule actions (task 11.2, design D5): the JSON action list compiled onto
 * the EXISTING queue op kinds by going through the SAME thread-actions
 * service functions the toolbar/shortcuts call — each one applies the
 * local SQLite effect FIRST and enqueues the server mutation SECOND (D10),
 * so offline queue replay comes free and a rule behaves exactly like the
 * user having performed the action on the thread.
 *
 * Action vocabulary (spec: archive, add label, star, mark read, trash,
 * mark-as-spam, move-to-folder for IMAP, plus the task 3.4 category
 * action for mail-organization "Automatic categorization"):
 * - archive / trash / mark_read / star — thread-level, both providers.
 * - mark_as_spam — the same spam placement the toolbar's spam action takes
 *   (markSpam): gmail adds the SPAM label and queues `add_labels ["SPAM"]`;
 *   imap moves the messages to the spam-role folder and queues `move`
 *   (throws MissingSpecialFolderError when the account has no spam-role
 *   folder — the ingestion hook isolates the failure per rule).
 * - add_labels — `labels` are label NAMES (as the rules UI shows them);
 *   resolved to local label rows at application time (name or gmail label
 *   id, case-insensitive). Unknown names are skipped with a warning (the
 *   rest of the rule still applies). Like the labels UI, this is a gmail
 *   action: applyLabelsToThread is a no-op on imap (labels are folders
 *   there — a rule that wants to file imap mail uses move).
 * - remove_labels — the same name resolution and gmail-only surface as
 *   add_labels, applied through applyLabelsToThread's removal path (local
 *   membership rewrite + queued `remove_labels` op). It never suppresses
 *   the announcement — unlabeled mail is still new mail.
 * - move — `folder` is the full IMAP folder path. Gmail accounts have no
 *   folders, so move on gmail is skipped with a warning (spec scopes the
 *   action to IMAP). The local move goes through thread-actions'
 *   moveThreadToFolder (exported for this caller — the same branch a user
 *   action takes); when the account has no matching local folder row the
 *   local move is skipped but the `move` op is still queued, mirroring the
 *   archive/trash degradation in thread-actions (the server applies by
 *   path; the local copy catches up at the next sync).
 * - set_category — `category` names one of the five inbox categories
 *   (task 3.4, design D4). NOT a delivery action: categorization is a
 *   separate consumer of the ingestion hook, not something applyRuleActions
 *   performs. The executor below SKIPS it explicitly (it never appears in
 *   the applied list and never suppresses the announcement); the value is
 *   consumed by runIngestionRules, which stamps the named category on the
 *   event for the categorization pass (rules/ingestion.ts →
 *   categorization/ingestion.ts). "Apply now" (task 11.4) drives the same
 *   executor, so the action deliberately no-ops there too — a category
 *   rule reaches existing mail only through the task 3.4 backfill's
 *   deterministic engine, not through action replay.
 *
 * A rule acts on the new MESSAGE'S THREAD (Gmail filter semantics): the
 * whole conversation moves/stars/reads with the message, exactly as when
 * a user acts on the thread.
 */

export type RuleActionType =
  | "archive"
  | "trash"
  | "mark_read"
  | "star"
  | "add_labels"
  | "remove_labels"
  | "move"
  | "mark_as_spam"
  | "set_category"

/** The closed action vocabulary parseActionsJson accepts. */
export const RULE_ACTION_TYPES: readonly RuleActionType[] = [
  "archive",
  "trash",
  "mark_read",
  "star",
  "add_labels",
  "remove_labels",
  "move",
  "mark_as_spam",
  "set_category",
]

export interface RuleAction {
  type: RuleActionType
  /** add_labels / remove_labels: names (or gmail label ids) resolved at apply time. */
  labels?: string[]
  /** move: full destination folder path (imap accounts). */
  folder?: string
  /** set_category: the inbox category the rule names (task 3.4, design D4). */
  category?: Category
}

/**
 * Actions whose local effect rules a new message away from the new-mail
 * count (design D5: "ruled-away mail never notifies"): the mail left the
 * inbox (archive/trash/move/mark_as_spam) or is no longer unread
 * (mark_read). Additive actions (add_labels, star) keep the message
 * counted.
 */
export const SUPPRESSES_NOTIFICATION: readonly RuleActionType[] = [
  "archive",
  "trash",
  "move",
  "mark_read",
  "mark_as_spam",
]

/**
 * Parse a stored actions_json value. Tolerant: corrupt JSON yields [],
 * entries with an unknown type or an add_labels/move payload of the wrong
 * shape are skipped with a warning — one bad rule must never break the
 * sync pass, and an empty action list simply never matches anything.
 */
export function parseActionsJson(actionsJson: string): RuleAction[] {
  let stored: unknown
  try {
    stored = JSON.parse(actionsJson)
  } catch (error) {
    console.warn(
      "[rules] actions_json is not valid JSON; actions skipped",
      error
    )
    return []
  }
  if (!Array.isArray(stored)) {
    console.warn("[rules] actions_json must be an array; actions skipped")
    return []
  }
  const actions: RuleAction[] = []
  for (const entry of stored) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { type?: unknown }).type !== "string"
    ) {
      console.warn("[rules] action entry without a type; skipped")
      continue
    }
    const type = (entry as { type: string }).type as RuleActionType
    if (!RULE_ACTION_TYPES.includes(type)) {
      console.warn(`[rules] unknown rule action type "${type}"; skipped`)
      continue
    }
    if (type === "add_labels" || type === "remove_labels") {
      const labels = (entry as { labels?: unknown }).labels
      if (
        !Array.isArray(labels) ||
        !labels.every((name) => typeof name === "string")
      ) {
        console.warn(`[rules] ${type} action without string labels; skipped`)
        continue
      }
      actions.push({ type, labels: labels as string[] })
      continue
    }
    if (type === "move") {
      const folder = (entry as { folder?: unknown }).folder
      if (typeof folder !== "string" || folder === "") {
        console.warn("[rules] move action without a folder path; skipped")
        continue
      }
      actions.push({ type, folder })
      continue
    }
    if (type === "set_category") {
      const category = (entry as { category?: unknown }).category
      if (
        typeof category !== "string" ||
        !CATEGORIES.includes(category as Category)
      ) {
        console.warn(
          "[rules] set_category action without a known category; skipped"
        )
        continue
      }
      actions.push({ type, category: category as Category })
      continue
    }
    actions.push({ type })
  }
  return actions
}

/**
 * Apply a rule's actions to one thread, in listed order, through the
 * thread-actions service (local effect + queue op per action). Returns the
 * action types that actually applied; failures throw to the caller (the
 * ingestion hook isolates them per rule).
 */
export async function applyRuleActions(
  executor: SqlExecutor,
  accountId: string,
  threadId: string,
  actions: readonly RuleAction[]
): Promise<RuleActionType[]> {
  const applied: RuleActionType[] = []
  for (const action of actions) {
    switch (action.type) {
      case "archive":
        await archiveThread(executor, accountId, threadId)
        applied.push("archive")
        break
      case "trash":
        await trashThread(executor, accountId, threadId)
        applied.push("trash")
        break
      case "mark_as_spam":
        // The same spam placement the user action takes (gmail SPAM label,
        // imap junk-folder move) — local effect + queue op in one call.
        await markSpam(executor, accountId, threadId)
        applied.push("mark_as_spam")
        break
      case "mark_read":
        await setThreadRead(executor, accountId, threadId, true)
        applied.push("mark_read")
        break
      case "star":
        await setThreadStarred(executor, accountId, threadId, true)
        applied.push("star")
        break
      case "add_labels": {
        const labelIds = await resolveLabelIds(
          executor,
          accountId,
          action.labels ?? [],
          "add_labels"
        )
        if (labelIds.length === 0) break
        await applyLabelsToThread(executor, accountId, threadId, labelIds, true)
        applied.push("add_labels")
        break
      }
      case "remove_labels": {
        const labelIds = await resolveLabelIds(
          executor,
          accountId,
          action.labels ?? [],
          "remove_labels"
        )
        if (labelIds.length === 0) break
        await applyLabelsToThread(
          executor,
          accountId,
          threadId,
          labelIds,
          false
        )
        applied.push("remove_labels")
        break
      }
      case "move":
        if (await applyMove(executor, accountId, threadId, action.folder)) {
          applied.push("move")
        }
        break
      case "set_category":
        // Explicitly ignored at DELIVERY time (task 3.4): categorization is
        // the categorization pass's consumer, not a delivery action — the
        // category was already stamped onto the event by runIngestionRules
        // before this executor ran (see the module comment). It must never
        // land in `applied` (it would wrongly suppress or report).
        break
    }
  }
  return applied
}

/**
 * Resolve rule label names to the app's internal label ids (what
 * thread_labels rows and applyLabelsToThread carry). A name matches a
 * label row's name case-insensitively or its raw gmail label id; unknown
 * names are warned and skipped rather than failing the rule.
 */
async function resolveLabelIds(
  executor: SqlExecutor,
  accountId: string,
  names: readonly string[],
  actionType: "add_labels" | "remove_labels"
): Promise<string[]> {
  if (names.length === 0) return []
  const rows = await executor.select<LabelRow>(
    "SELECT * FROM labels WHERE account_id = $1",
    [accountId]
  )
  const ids = new Set<string>()
  for (const name of names) {
    const needle = name.toLowerCase()
    const hit = rows.find(
      (row) =>
        row.name.toLowerCase() === needle ||
        row.gmail_label_id?.toLowerCase() === needle
    )
    if (hit) {
      ids.add(hit.id)
    } else {
      console.warn(
        `[rules] ${actionType}: no label named "${name}" on account ${accountId}; skipped`
      )
    }
  }
  return [...ids]
}

/**
 * The imap move action: local folder move via the thread-actions branch,
 * plus the `move` queue op. Returns false when the action did not apply
 * (gmail account — warned; nothing to move). Unknown local folder paths
 * still enqueue the op (see the module comment).
 */
async function applyMove(
  executor: SqlExecutor,
  accountId: string,
  threadId: string,
  folder: string | undefined
): Promise<boolean> {
  if (!folder) return false
  const account = await getAccount(executor, accountId)
  if (!account || account.type !== "imap") {
    console.warn(
      `[rules] move action on non-imap account ${accountId}; skipped`
    )
    return false
  }
  const loaded = await getThreadWithMessages(executor, threadId)
  if (!loaded) return false
  const destination = await findLabelByImapFolder(executor, accountId, folder)
  if (destination) {
    // Local-first (D10), like every thread action: local move, then the op.
    await moveThreadToFolder(executor, threadId, loaded.messages, destination)
    await enqueueMove(
      executor,
      accountId,
      buildMessageRefs("imap", loaded.messages),
      folder
    )
    return true
  }
  // Unknown local folder: still queue the server-side move (the provider
  // applies by path at replay); the local copy catches up at the next sync
  // — the same degradation thread-actions applies for archive/trash.
  console.warn(
    `[rules] move: no local folder "${folder}" on account ${accountId}; ` +
      "queued the server-side move only"
  )
  await enqueueMove(
    executor,
    accountId,
    buildMessageRefs("imap", loaded.messages),
    folder
  )
  return true
}
