import type { SqlExecutor } from "../db/executor"
import { getAccount } from "../db/accounts"
import type { AccountType } from "../email/types"
import type { LabelRow } from "../db/labels"
import { findLabelByImapFolder } from "../db/labels"
import type { ThreadRow } from "../db/threads"
import { getThreadWithMessages } from "../db/threads"
import { buildMessageRefs } from "../email-actions/message-refs"
import { getSnoozePresets, snoozeThread } from "../email-actions/snooze"
import {
  applyLabelsToThread,
  archiveThread,
  moveThreadToFolder,
  setThreadRead,
  setThreadStarred,
  trashThread,
} from "../email-actions/thread-actions"
import { markThreadDone } from "../email-actions/thread-states"
import { enqueueMove } from "../queue/operation"
import type {
  QuickStep,
  QuickStepAction,
  QuickStepSnoozePresetId,
} from "../settings/quick-steps"

/**
 * The quick-step executor (task 3.1): applies one stored chain to a
 * thread or to every thread in a multi-selection by going through the
 * SAME email-actions service functions the toolbar/shortcuts call (D10:
 * local mutation first, queue op second) — a quick step is exactly the
 * user having performed each action in order.
 *
 * Determinism over parallelism: both loops (threads and actions) are
 * sequential — thread 1's whole chain finishes before thread 2 starts,
 * and a thread's action N finishes before N+1. Ordering is part of the
 * spec ("actions that remove mail from the inbox execute in order" —
 * e.g. add-label must land before the archive that takes the thread out
 * of the inbox), and sequential application makes a partial run
 * trivially reasonable-about: earlier threads are durably applied, like
 * bulkApply's fail-fast loop.
 *
 * Account resolution (spec: "actions apply per thread's account where
 * account-scoped"): every thread row carries account_id, so the executor
 * reads it per thread and passes it to the account-scoped email-actions;
 * the account-agnostic local states (mark done, snooze) never need it.
 * Name-based parameters (`label`, `folderPath`) are resolved against EACH
 * thread's own account here — see settings/quick-steps.ts for why they
 * are stored as names, not row ids.
 *
 * Failure semantics: a skipped action (nothing to do on this account —
 * an unknown label name, move-to-folder on gmail, an unavailable snooze
 * preset) is recorded and the chain CONTINUES; a failed action (a thrown
 * error) is recorded and the thread's chain STOPS (later actions were
 * authored on top of earlier state), while the remaining threads still
 * run. Nothing rethrows — the per-thread per-action result summary is
 * the contract.
 */

/** How one action ended for one thread. */
export type QuickStepActionStatus = "applied" | "skipped" | "failed"

/** One action's outcome on one thread. */
export interface QuickStepActionOutcome {
  action: QuickStepAction
  status: QuickStepActionStatus
  /** Why the action skipped or failed (rendered by the 3.2 run toast). */
  detail?: string
}

/** One thread's chain outcome. */
export interface QuickStepThreadResult {
  threadId: string
  /** The account resolved from the thread row; null when the thread id
   * is unknown (every action then reports "skipped: thread not found"). */
  accountId: string | null
  /** In chain order; a failed action is the last entry for the thread. */
  outcomes: QuickStepActionOutcome[]
}

/** The full run summary, one entry per input thread, input order. */
export interface QuickStepRunResult {
  results: QuickStepThreadResult[]
}

/** Injectable seams for deterministic runs (tests; the defaults are the
 * production behavior). */
export interface QuickStepRunDeps {
  /**
   * Resolve a stored snooze preset id to a wake-up time (unix seconds).
   * Defaults to getSnoozePresets() computed at run time (presets are
   * relative to "now"); returning null marks the action skipped — e.g.
   * "later today" is not offered past 6 PM.
   */
  resolveSnoozePreset?: (presetId: QuickStepSnoozePresetId) => number | null
}

function defaultResolveSnoozePreset(
  presetId: QuickStepSnoozePresetId
): number | null {
  return (
    getSnoozePresets().presets.find((preset) => preset.id === presetId)
      ?.until ?? null
  )
}

/**
 * Run a quick step against a selection: every action, in chain order, on
 * every thread. Sequential and deterministic (see the module comment).
 * The destructive first-run confirmation is NOT enforced here — the 3.2
 * run affordances consult shouldConfirmDestructive/stepIncludesTrash
 * before calling this, so the service layer stays dialog-free.
 */
export async function runQuickStep(
  executor: SqlExecutor,
  step: QuickStep,
  threadIds: readonly string[],
  deps: QuickStepRunDeps = {}
): Promise<QuickStepRunResult> {
  const results: QuickStepThreadResult[] = []
  for (const threadId of threadIds) {
    results.push(await runForThread(executor, step, threadId, deps))
  }
  return { results }
}

/** One thread's whole chain, sequential, stopping at the first failure. */
async function runForThread(
  executor: SqlExecutor,
  step: QuickStep,
  threadId: string,
  deps: QuickStepRunDeps
): Promise<QuickStepThreadResult> {
  const rows = await executor.select<Pick<ThreadRow, "account_id">>(
    "SELECT account_id FROM threads WHERE id = $1",
    [threadId]
  )
  const accountId = rows[0]?.account_id ?? null
  if (!accountId) {
    // One bad id in a selection must not abort the run: every action is
    // recorded skipped and the remaining threads proceed.
    return {
      threadId,
      accountId: null,
      outcomes: step.actions.map((action) => ({
        action,
        status: "skipped",
        detail: "thread not found",
      })),
    }
  }
  const account = await getAccount(executor, accountId)
  if (!account) {
    return {
      threadId,
      accountId,
      outcomes: step.actions.map((action) => ({
        action,
        status: "skipped",
        detail: "account not found",
      })),
    }
  }
  const outcomes: QuickStepActionOutcome[] = []
  for (const action of step.actions) {
    const outcome = await applyAction(
      executor,
      accountId,
      account.type,
      threadId,
      action,
      deps
    )
    outcomes.push(outcome)
    if (outcome.status === "failed") break
  }
  return { threadId, accountId, outcomes }
}

function applied(action: QuickStepAction): QuickStepActionOutcome {
  return { action, status: "applied" }
}

function skipped(
  action: QuickStepAction,
  detail: string
): QuickStepActionOutcome {
  return { action, status: "skipped", detail }
}

/** Dispatch one action through the email-actions service. Never throws:
 * failures become "failed" outcomes (see the module comment). */
async function applyAction(
  executor: SqlExecutor,
  accountId: string,
  accountType: AccountType,
  threadId: string,
  action: QuickStepAction,
  deps: QuickStepRunDeps
): Promise<QuickStepActionOutcome> {
  try {
    switch (action.kind) {
      case "archive":
        await archiveThread(executor, accountId, threadId)
        return applied(action)
      case "trash":
        await trashThread(executor, accountId, threadId)
        return applied(action)
      case "star":
        await setThreadStarred(executor, accountId, threadId, true)
        return applied(action)
      case "mark_read":
        await setThreadRead(executor, accountId, threadId, action.read)
        return applied(action)
      case "mark_done":
        // Account-agnostic local state — no account scoping anywhere.
        await markThreadDone(executor, threadId)
        return applied(action)
      case "snooze": {
        // Account-agnostic local state; the preset id becomes a concrete
        // wake-up time at run time.
        const until = (deps.resolveSnoozePreset ?? defaultResolveSnoozePreset)(
          action.presetId
        )
        if (until === null) {
          return skipped(
            action,
            `snooze preset "${action.presetId}" is not currently offered`
          )
        }
        await snoozeThread(executor, threadId, until)
        return applied(action)
      }
      case "add_label":
      case "remove_label": {
        // Labels are gmail-scoped in this app (imap labels are folders);
        // resolved against THIS thread's account from the stored name.
        if (accountType !== "gmail") {
          return skipped(action, "labels apply to gmail accounts only")
        }
        const labelIds = await resolveLabelIds(
          executor,
          accountId,
          action.label
        )
        if (labelIds.length === 0) {
          return skipped(action, `no label "${action.label}" on this account`)
        }
        await applyLabelsToThread(
          executor,
          accountId,
          threadId,
          labelIds,
          action.kind === "add_label"
        )
        return applied(action)
      }
      case "move_to_folder":
        return applyMove(executor, accountId, accountType, threadId, action)
    }
  } catch (error) {
    return {
      action,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * The imap move action (rules/actions.ts applyMove's shape, reported
 * instead of warned): local folder move via thread-actions'
 * moveThreadToFolder (the same branch a user move takes), then the
 * `move` queue op. Gmail has no folders — skipped there. A folder path
 * with no local row still enqueues the server-side move by path (the
 * same degradation thread-actions applies for archive/trash).
 */
async function applyMove(
  executor: SqlExecutor,
  accountId: string,
  accountType: AccountType,
  threadId: string,
  action: Extract<QuickStepAction, { kind: "move_to_folder" }>
): Promise<QuickStepActionOutcome> {
  if (accountType === "gmail") {
    return skipped(action, "move to folder applies to folder-based accounts only")
  }
  const loaded = await getThreadWithMessages(executor, threadId)
  if (!loaded) {
    return skipped(action, "thread not found")
  }
  const destination = await findLabelByImapFolder(
    executor,
    accountId,
    action.folderPath
  )
  if (destination) {
    // Local-first (D10), like every thread action: local move, then the op.
    await moveThreadToFolder(executor, threadId, loaded.messages, destination)
  }
  await enqueueMove(
    executor,
    accountId,
    buildMessageRefs("imap", loaded.messages),
    action.folderPath
  )
  return applied(action)
}

/**
 * Resolve a stored label reference to the app's internal label ids on
 * ONE account — by name (case-insensitive) or raw gmail label id, the
 * same resolution rules/actions.ts applies for rule label actions.
 */
async function resolveLabelIds(
  executor: SqlExecutor,
  accountId: string,
  label: string
): Promise<string[]> {
  const rows = await executor.select<LabelRow>(
    "SELECT * FROM labels WHERE account_id = $1",
    [accountId]
  )
  const needle = label.toLowerCase()
  return rows
    .filter(
      (row) =>
        row.name.toLowerCase() === needle ||
        row.gmail_label_id?.toLowerCase() === needle
    )
    .map((row) => row.id)
}
