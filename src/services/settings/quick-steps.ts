import type { SqlExecutor } from "@/services/db/executor"
import { getSetting, setSetting } from "@/services/db/settings"

/**
 * Quick steps (task 3.1, design D13): named chains of two or more actions
 * applied together to a thread or to every thread in a multi-selection.
 * Like splits (task 9.3), there is NO quick-steps table — quick steps are
 * local, account-agnostic config persisted as ONE JSON row in the
 * settings table under `organization.quickSteps`, following the splits
 * pattern: the row holds an array of QuickStep; `order` is the list order
 * (kept dense 0…n-1 on every write) and every mutation reads the whole
 * array and writes it back (one row, the service owns merging), so no
 * read-modify-write races within a user action matter.
 *
 * The chain shape is a spec guarantee: a quick step is "two or more
 * actions". create/update therefore REJECT fewer than two actions with a
 * typed error (rendered as a form error by the 3.2 dialogs, not an
 * exception), and the validating reader drops stored entries that no
 * longer carry two valid actions (hand-edited or older-build rows must
 * never crash the manager UI — the splits doctrine).
 *
 * Account-agnostic action parameters: quick steps run against mixed
 * selections, so account-scoped parameters are stored as NAMES resolved
 * against EACH thread's own account at run time (see
 * src/services/quick-steps/executor.ts) — `label` matches a label row's
 * name (or gmail label id) per account, `folderPath` matches the account's
 * imap folder path. A stored per-account row id would pin the action to
 * one account and break the spec's account-agnostic requirement.
 *
 * Names are unique among quick steps (case-insensitive) — the runner and
 * the manage UI address steps by id, but duplicate names would make the
 * palette/menu entries unselectable. Violations come back as a typed
 * result, not an exception.
 *
 * Per-step keyboard shortcut (task 3.2, design D13 — deliberately NOT in
 * the fixed src/constants/shortcuts.ts registry, whose editor/conflict
 * system is for fixed bindings): an optional `shortcut` holding ONE plain
 * digit "1"…"9" (no modifiers — the step runs against the current
 * selection or active thread, exactly like the context-menu entry, so a
 * bare key is the whole binding; documented in the manage UI). Kept on
 * the QuickStep row itself, sanitized on read (anything but a single
 * digit 1–9 is dropped), and unique among steps — a collision is REJECTED
 * with a typed "shortcut-taken" (the manage UI also disables taken
 * digits); last-wins would silently rebind another step's key.
 */

export const QUICK_STEPS_SETTING_KEY = "organization.quickSteps"

/**
 * The closed snooze preset vocabulary, mirroring the ids SnoozePreset
 * carries in email-actions/snooze.ts (getSnoozePresets). Stored in the
 * action, resolved to a concrete wake-up time at RUN time (presets are
 * relative to "now" — "tomorrow 8:00" is computed when the step runs).
 */
export const SNOOZE_PRESET_IDS = [
  "later_today",
  "tomorrow",
  "next_week",
] as const

export type QuickStepSnoozePresetId = (typeof SNOOZE_PRESET_IDS)[number]

/**
 * The nine-action chain vocabulary (mail-organization spec, task 3.1):
 * archive, add label, remove label, star, mark read/unread, mark done,
 * trash, move to folder, snooze with a preset. Stored verbatim in the
 * JSON row; unknown kinds/params are dropped on read by
 * isQuickStepAction.
 */
export type QuickStepAction =
  | { kind: "archive" }
  | { kind: "add_label"; label: string }
  | { kind: "remove_label"; label: string }
  | { kind: "star" }
  | { kind: "mark_read"; read: boolean }
  | { kind: "mark_done" }
  | { kind: "trash" }
  | { kind: "move_to_folder"; folderPath: string }
  | { kind: "snooze"; presetId: QuickStepSnoozePresetId }

/**
 * One named chain; `order` is the position in the manage list. `shortcut`
 * (task 3.2) is the optional plain-digit run key "1"…"9" — absent when
 * unset.
 */
export interface QuickStep {
  id: string
  name: string
  actions: QuickStepAction[]
  order: number
  shortcut?: string
}

/** Result of the validating mutations (create/update). */
export type QuickStepResult =
  | { ok: true; step: QuickStep }
  | {
      ok: false
      error:
        | "name-required"
        | "name-taken"
        | "min-two-actions"
        | "not-found"
        | "shortcut-invalid"
        | "shortcut-taken"
    }

/** The per-step shortcut vocabulary (task 3.2): plain digits 1–9, no
 * modifiers — kept simple by design (see the module comment). */
export const QUICK_STEP_SHORTCUTS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]

/** Whether a stored/entered shortcut is a usable plain digit 1–9. */
export function isValidQuickStepShortcut(
  value: unknown
): value is string {
  return typeof value === "string" && QUICK_STEP_SHORTCUTS.includes(value)
}

/** Reader-side shortcut sanitizer: an invalid stored value (hand-edited
 * row, older build) is dropped, never thrown. */
function sanitizeShortcut(value: unknown): string | undefined {
  return isValidQuickStepShortcut(value) ? value : undefined
}

/**
 * Structural guard for one stored action — a hand-edited row with an
 * unknown kind or a missing/mistyped parameter is dropped, never thrown.
 */
function isQuickStepAction(value: unknown): value is QuickStepAction {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  switch (entry.kind) {
    case "archive":
    case "star":
    case "mark_done":
    case "trash":
      return true
    case "add_label":
    case "remove_label":
      return typeof entry.label === "string" && entry.label !== ""
    case "mark_read":
      return typeof entry.read === "boolean"
    case "move_to_folder":
      return typeof entry.folderPath === "string" && entry.folderPath !== ""
    case "snooze":
      return (
        typeof entry.presetId === "string" &&
        (SNOOZE_PRESET_IDS as readonly string[]).includes(entry.presetId)
      )
    default:
      return false
  }
}

/** Valid stored actions only (internal to the reader). */
function sanitizeActions(value: unknown): QuickStepAction[] {
  if (!Array.isArray(value)) return []
  return value.filter(isQuickStepAction)
}

/** Shape guard for a stored entry (id/name/order/actions-array); the
 * actions themselves are sanitized afterwards. */
function isQuickStepShape(value: unknown): value is QuickStep {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.order === "number" &&
    Number.isFinite(entry.order) &&
    Array.isArray(entry.actions)
  )
}

/** All quick steps in list order. Corrupt stored shapes are dropped, and
 * an entry whose valid actions fall below two no longer satisfies the
 * chain shape and is dropped with them; a missing or unparseable row
 * means "no quick steps yet". */
export async function listQuickSteps(
  executor: SqlExecutor
): Promise<QuickStep[]> {
  const stored = await getSetting<unknown>(
    executor,
    QUICK_STEPS_SETTING_KEY,
    []
  )
  if (!Array.isArray(stored)) return []
  return stored
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isQuickStepShape(entry))
    .map(({ entry, index }) => ({
      step: {
        ...entry,
        actions: sanitizeActions(entry.actions),
        shortcut: sanitizeShortcut(entry.shortcut),
      },
      index,
    }))
    .filter(({ step }) => step.actions.length >= 2)
    .sort((a, b) => a.step.order - b.step.order || a.index - b.index)
    .map(({ step }) => step)
}

/** Persist the whole array with dense orders (internal). */
async function persistQuickSteps(
  executor: SqlExecutor,
  steps: QuickStep[]
): Promise<void> {
  await setSetting(
    executor,
    QUICK_STEPS_SETTING_KEY,
    steps.map((step, order) => ({ ...step, order }))
  )
}

/** Shared validation for the name-bearing mutations: trimmed non-empty
 * name, unique among ALL steps (case-insensitive, excluding `exceptId`),
 * the two-action chain minimum, and the optional shortcut (a plain digit
 * 1–9, unique among the other steps — a collision is rejected, not
 * silently rebound). Returns the failing error or null. `shortcut` is
 * only validated when the caller passes it (`null` clears, `undefined`
 * leaves it unchanged, mirroring name/actions). */
async function validateInput(
  executor: SqlExecutor,
  input: {
    name?: string
    actions?: QuickStepAction[]
    shortcut?: string | null
  },
  exceptId?: string
): Promise<
  "name-required" | "name-taken" | "min-two-actions" | "shortcut-invalid" | "shortcut-taken" | null
> {
  if (input.actions !== undefined && input.actions.length < 2) {
    return "min-two-actions"
  }
  if (input.shortcut !== undefined && input.shortcut !== null) {
    if (!isValidQuickStepShortcut(input.shortcut)) return "shortcut-invalid"
    const steps = await listQuickSteps(executor)
    const taken = steps.some(
      (step) =>
        step.id !== exceptId && step.shortcut === input.shortcut
    )
    if (taken) return "shortcut-taken"
  }
  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) return "name-required"
    const steps = await listQuickSteps(executor)
    const taken = steps.some(
      (step) =>
        step.id !== exceptId && step.name.toLowerCase() === name.toLowerCase()
    )
    if (taken) return "name-taken"
  }
  return null
}

/**
 * Create a quick step appended at the end of the list. Enforces the
 * spec's chain shape at create: at least TWO actions (the spec reads as a
 * shape guarantee, so this is a hard typed error, not a warning). The
 * name is trimmed, required, and unique among all steps; the optional
 * shortcut must be a free digit 1–9 (task 3.2 — "shortcut-taken" on a
 * collision, "shortcut-invalid" for anything but a plain digit).
 */
export async function createQuickStep(
  executor: SqlExecutor,
  input: {
    name: string
    actions: QuickStepAction[]
    shortcut?: string | null
  }
): Promise<QuickStepResult> {
  const error = await validateInput(executor, input)
  if (error) return { ok: false, error }
  const steps = await listQuickSteps(executor)
  const step: QuickStep = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    actions: input.actions,
    order: steps.length,
    ...(input.shortcut ? { shortcut: input.shortcut } : {}),
  }
  await persistQuickSteps(executor, [...steps, step])
  return { ok: true, step }
}

/**
 * Edit a quick step in place: rename and/or replace the chain. The same
 * rules as createQuickStep apply (trimmed unique name, two-action
 * minimum) excluding the step itself; omitting a field leaves it
 * unchanged. An unknown id is a typed "not-found".
 */
/**
 * Edit a quick step in place: rename and/or replace the chain and/or set
 * the shortcut. The same rules as createQuickStep apply (trimmed unique
 * name, two-action minimum, digit shortcut unique among the OTHER steps)
 * excluding the step itself; omitting a field leaves it unchanged, and
 * `shortcut: null` clears it. An unknown id is a typed "not-found".
 */
export async function updateQuickStep(
  executor: SqlExecutor,
  stepId: string,
  input: {
    name?: string
    actions?: QuickStepAction[]
    shortcut?: string | null
  }
): Promise<QuickStepResult> {
  const steps = await listQuickSteps(executor)
  const target = steps.find((step) => step.id === stepId)
  if (!target) return { ok: false, error: "not-found" }
  const error = await validateInput(executor, input, stepId)
  if (error) return { ok: false, error }
  const next = steps.map((step) =>
    step.id === stepId
      ? {
          ...step,
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.actions !== undefined ? { actions: input.actions } : {}),
          ...(input.shortcut !== undefined
            ? // null clears the shortcut; the key drops from the stored
              // JSON (undefined fields are not serialized).
              { shortcut: input.shortcut ?? undefined }
            : {}),
        }
      : step
  )
  await persistQuickSteps(executor, next)
  const updated = next.find((step) => step.id === stepId)
  return updated
    ? { ok: true, step: updated }
    : { ok: false, error: "not-found" }
}

/** Delete a quick step (no-op when the id is unknown). Mail is untouched —
 * a quick step is a recipe, not stored state on threads. */
export async function deleteQuickStep(
  executor: SqlExecutor,
  stepId: string
): Promise<void> {
  const steps = await listQuickSteps(executor)
  await persistQuickSteps(
    executor,
    steps.filter((step) => step.id !== stepId)
  )
}

/**
 * Reorder the list: `orderedIds` gives the desired order (a prefix of it
 * is enough — steps it does not mention keep their relative order after
 * the mentioned ones, so an up/down move passes two ids and nothing is
 * lost). Positions are rewritten dense in one write.
 */
export async function reorderQuickSteps(
  executor: SqlExecutor,
  orderedIds: readonly string[]
): Promise<void> {
  const steps = await listQuickSteps(executor)
  const byId = new Map(steps.map((step) => [step.id, step]))
  const mentioned = new Set<string>()
  const next: QuickStep[] = []
  for (const id of orderedIds) {
    const step = byId.get(id)
    if (step && !mentioned.has(id)) {
      next.push(step)
      mentioned.add(id)
    }
  }
  for (const step of steps) {
    if (!mentioned.has(step.id)) next.push(step)
  }
  await persistQuickSteps(executor, next)
}

// ---- One-time destructive confirmation (spec: "confirms once") ----

/**
 * Settings key backing the one-time trash confirmation (spec: "a
 * destructive step (trash) SHALL require confirmation the first time it
 * runs"). A boolean row, default false — the flag is deliberately NOT
 * per-step: after the user confirms any trash-running step once, every
 * later run (any step) is confirmation-free.
 */
export const QUICK_STEP_TRASH_CONFIRMED_KEY =
  "organization.quickStepTrashConfirmed"

/**
 * Whether the next destructive quick-step run still needs the one-time
 * confirmation: true until markDestructiveConfirmed has been called. A
 * corrupt non-boolean row counts as unconfirmed (ask again — safe
 * default).
 */
export async function shouldConfirmDestructive(
  executor: SqlExecutor
): Promise<boolean> {
  const value = await getSetting<boolean>(
    executor,
    QUICK_STEP_TRASH_CONFIRMED_KEY,
    false
  )
  return !(typeof value === "boolean" ? value : false)
}

/** Remember the user's one-time confirmation of destructive quick steps. */
export async function markDestructiveConfirmed(
  executor: SqlExecutor
): Promise<void> {
  await setSetting(executor, QUICK_STEP_TRASH_CONFIRMED_KEY, true)
}

/**
 * Whether a step contains the destructive action (trash) — the 3.2 run
 * affordances consult this (with shouldConfirmDestructive) to decide
 * whether to ask before running.
 */
export function stepIncludesTrash(step: QuickStep): boolean {
  return step.actions.some((action) => action.kind === "trash")
}
