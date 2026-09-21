import { useCallback, useEffect, useState } from "react"
import {
  ChevronDown,
  ChevronUp,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { getExecutor } from "@/services/db/executor"
import {
  createQuickStep,
  deleteQuickStep,
  listQuickSteps,
  QUICK_STEP_SHORTCUTS,
  reorderQuickSteps,
  SNOOZE_PRESET_IDS,
  updateQuickStep,
  type QuickStep,
  type QuickStepAction,
  type QuickStepResult,
  type QuickStepSnoozePresetId,
} from "@/services/settings/quick-steps"

/**
 * Settings "Quick steps" section (task 3.2, design D13): manages the
 * account-agnostic action chains stored under `organization.quickSteps`
 * (task 3.1's service — this section is the only writer). Rows show the
 * name, one chip per action in chain order, the optional digit shortcut,
 * up/down ordering controls (a neighbor swap through
 * reorderQuickSteps), edit and delete (no confirm — a quick step is a
 * recipe, trivially re-created, matching the rules section).
 *
 * The add/edit dialog holds the chain builder: actions are added IN
 * ORDER (order matters — the spec's "actions that remove mail from the
 * inbox execute in order", e.g. add-label before archive), each row
 * carrying a kind select plus the per-kind field (label NAME — resolved
 * per account at run time, folder path, snooze preset, read/unread).
 * The spec's chain shape (two or more actions) is enforced by the
 * service and mirrored here: Save stays disabled below two actions.
 * Shortcuts are plain digits 1–9 (see quick-steps.ts for why not the
 * fixed binding registry); digits taken by other steps are disabled in
 * the picker, and a collision that slips through is rejected by the
 * service ("shortcut-taken") and surfaced as a form error.
 */

type DialogTarget = { mode: "add" } | { mode: "edit"; step: QuickStep }

/** Human labels for the snooze preset ids (the run-time presets carry
 * the same names; here they are static builder copy). */
const SNOOZE_PRESET_LABELS: Record<QuickStepSnoozePresetId, string> = {
  later_today: "Later today",
  tomorrow: "Tomorrow",
  next_week: "Next week",
}

/** The builder's kind vocabulary: mark_read splits into read/unread (a
 * "Mark unread" entry is friendlier than a toggle field). */
type BuilderKind =
  | "archive"
  | "add_label"
  | "remove_label"
  | "star"
  | "mark_read"
  | "mark_unread"
  | "mark_done"
  | "trash"
  | "move_to_folder"
  | "snooze"

const BUILDER_KIND_LABELS: Record<BuilderKind, string> = {
  archive: "Archive",
  add_label: "Add label",
  remove_label: "Remove label",
  star: "Star",
  mark_read: "Mark read",
  mark_unread: "Mark unread",
  mark_done: "Mark done",
  trash: "Move to Trash",
  move_to_folder: "Move to folder",
  snooze: "Snooze",
}

function builderKindOf(action: QuickStepAction): BuilderKind {
  if (action.kind === "mark_read") return action.read ? "mark_read" : "mark_unread"
  return action.kind
}

function defaultActionFor(kind: BuilderKind): QuickStepAction {
  switch (kind) {
    case "add_label":
    case "remove_label":
      return { kind, label: "" }
    case "move_to_folder":
      return { kind, folderPath: "" }
    case "snooze":
      return { kind, presetId: "tomorrow" }
    case "mark_read":
      return { kind, read: true }
    case "mark_unread":
      return { kind: "mark_read", read: false }
    default:
      return { kind }
  }
}

/** One-line chip text for an action (row display; the builder shows the
 * fields instead). */
function quickStepActionChip(action: QuickStepAction): string {
  switch (action.kind) {
    case "archive":
      return "Archive"
    case "star":
      return "Star"
    case "mark_done":
      return "Mark done"
    case "trash":
      return "Move to Trash"
    case "mark_read":
      return action.read ? "Mark read" : "Mark unread"
    case "add_label":
      return `+ Label “${action.label}”`
    case "remove_label":
      return `− Label “${action.label}”`
    case "move_to_folder":
      return `→ ${action.folderPath}`
    case "snooze":
      return `Snooze · ${SNOOZE_PRESET_LABELS[action.presetId]}`
  }
}

/** Typed mutation errors → dialog copy (the service owns the rules; the
 * dialog only renders them). */
const RESULT_ERRORS: Record<
  Exclude<QuickStepResult, { ok: true }>["error"],
  string
> = {
  "name-required": "Give the quick step a name.",
  "name-taken": "A quick step with this name already exists.",
  "min-two-actions": "A quick step needs at least two actions.",
  "not-found": "This quick step no longer exists.",
  "shortcut-invalid": "Shortcuts are the digits 1–9.",
  "shortcut-taken": "That digit is already assigned to another quick step.",
}

function QuickStepDialog({
  target,
  steps,
  onOpenChange,
  onSaved,
}: {
  target: DialogTarget
  /** Every step in the list — the shortcut picker disables digits taken
   * by steps OTHER than the one being edited. */
  steps: QuickStep[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const editing = target.mode === "edit" ? target.step : null
  const [name, setName] = useState(editing?.name ?? "")
  const [actions, setActions] = useState<QuickStepAction[]>(
    editing?.actions ?? []
  )
  const [shortcut, setShortcut] = useState<string>(editing?.shortcut ?? "")
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // The "Add action" picker is remounted after each append so its value
  // resets — picking the same kind twice in a row must keep working.
  const [addKey, setAddKey] = useState(0)

  // Other steps' shortcuts — disabled in the picker so a collision is
  // unpickable (the service still rejects one that slips through).
  const takenShortcuts = new Map(
    steps
      .filter((step) => step.id !== editing?.id && step.shortcut)
      .map((step) => [step.shortcut!, step.name])
  )

  const paramsComplete = actions.every((action) => {
    if (action.kind === "add_label" || action.kind === "remove_label") {
      return action.label.trim() !== ""
    }
    if (action.kind === "move_to_folder") return action.folderPath.trim() !== ""
    return true
  })
  const canSave =
    name.trim() !== "" && actions.length >= 2 && paramsComplete && !saving

  function patchAction(index: number, next: QuickStepAction): void {
    setActions((previous) =>
      previous.map((action, i) => (i === index ? next : action))
    )
  }

  function moveAction(index: number, direction: -1 | 1): void {
    setActions((previous) => {
      const neighbor = index + direction
      if (neighbor < 0 || neighbor >= previous.length) return previous
      const next = [...previous]
      const [moved] = next.splice(index, 1)
      if (moved) next.splice(neighbor, 0, moved)
      return next
    })
  }

  async function handleSave(): Promise<void> {
    if (!canSave) return
    setSaving(true)
    setErrorMessage(null)
    try {
      const executor = getExecutor()
      const result = editing
        ? await updateQuickStep(executor, editing.id, {
            name: name.trim(),
            actions,
            shortcut: shortcut === "" ? null : shortcut,
          })
        : await createQuickStep(executor, {
            name: name.trim(),
            actions,
            shortcut: shortcut === "" ? null : shortcut,
          })
      if (!result.ok) {
        setErrorMessage(RESULT_ERRORS[result.error])
        setSaving(false)
        return
      }
      onSaved()
      onOpenChange(false)
    } catch (error) {
      console.warn("[settings] failed to save quick step", error)
      setErrorMessage("Could not save the quick step.")
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit Quick Step" : "Add Quick Step"}
          </DialogTitle>
          <DialogDescription>
            Two or more actions applied together, in order, to a thread or
            the whole selection — from the context menu, the command
            palette, or its keyboard digit.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSave()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="quick-step-name">Name</Label>
            <Input
              id="quick-step-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Cleanup"
              autoFocus
            />
          </div>
          <div className="grid gap-2" data-testid="quick-step-action-builder">
            <Label>Actions (run in order)</Label>
            {actions.map((action, index) => {
              const kind = builderKindOf(action)
              return (
                <div
                  key={index}
                  data-testid={`quick-step-action-row-${index}`}
                  className="flex flex-col gap-2 rounded-lg border p-2"
                >
                  <div className="flex items-center gap-1">
                    <Select
                      value={kind}
                      onValueChange={(value) => {
                        patchAction(index, defaultActionFor(value as BuilderKind))
                      }}
                    >
                      <SelectTrigger
                        className="min-w-36 flex-1"
                        aria-label={`Action ${index + 1} type`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(BUILDER_KIND_LABELS) as BuilderKind[]).map(
                          (candidate) => (
                            <SelectItem key={candidate} value={candidate}>
                              {BUILDER_KIND_LABELS[candidate]}
                            </SelectItem>
                          )
                        )}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Move action ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => moveAction(index, -1)}
                    >
                      <ChevronUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Move action ${index + 1} down`}
                      disabled={index === actions.length - 1}
                      onClick={() => moveAction(index, 1)}
                    >
                      <ChevronDown />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove action ${index + 1}`}
                      onClick={() =>
                        setActions((previous) =>
                          previous.filter((_, i) => i !== index)
                        )
                      }
                    >
                      <X />
                    </Button>
                  </div>
                  {(action.kind === "add_label" ||
                    action.kind === "remove_label") && (
                    <Input
                      value={action.label}
                      onChange={(event) =>
                        patchAction(index, { ...action, label: event.target.value })
                      }
                      placeholder="Label name"
                      aria-label={`Action ${index + 1} label name`}
                    />
                  )}
                  {action.kind === "move_to_folder" && (
                    <Input
                      value={action.folderPath}
                      onChange={(event) =>
                        patchAction(index, {
                          ...action,
                          folderPath: event.target.value,
                        })
                      }
                      placeholder="Folder path"
                      aria-label={`Action ${index + 1} folder path`}
                      className="font-mono"
                    />
                  )}
                  {action.kind === "snooze" && (
                    <Select
                      value={action.presetId}
                      onValueChange={(value) => {
                        patchAction(index, {
                          ...action,
                          presetId: value as QuickStepSnoozePresetId,
                        })
                      }}
                    >
                      <SelectTrigger
                        aria-label={`Action ${index + 1} snooze preset`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SNOOZE_PRESET_IDS.map((presetId) => (
                          <SelectItem key={presetId} value={presetId}>
                            {SNOOZE_PRESET_LABELS[presetId]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )
            })}
            <Select
              key={addKey}
              onValueChange={(value) => {
                setActions((previous) => [
                  ...previous,
                  defaultActionFor(value as BuilderKind),
                ])
                setAddKey((key) => key + 1)
              }}
            >
              <SelectTrigger aria-label="Add action" className="w-full">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Plus className="size-4" aria-hidden />
                  Add action…
                </span>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(BUILDER_KIND_LABELS) as BuilderKind[]).map(
                  (candidate) => (
                    <SelectItem key={candidate} value={candidate}>
                      {BUILDER_KIND_LABELS[candidate]}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
            {actions.length < 2 && (
              <p className="text-xs text-muted-foreground">
                A quick step needs at least two actions.
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="quick-step-shortcut">Keyboard shortcut</Label>
            <Select
              value={shortcut === "" ? "none" : shortcut}
              onValueChange={(value) => {
                setShortcut(value === "none" || value === null ? "" : value)
              }}
            >
              <SelectTrigger id="quick-step-shortcut" className="w-40">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {QUICK_STEP_SHORTCUTS.map((digit) => {
                  const owner = takenShortcuts.get(digit)
                  return (
                    <SelectItem key={digit} value={digit} disabled={!!owner}>
                      {digit}
                      {owner ? ` — used by “${owner}”` : ""}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Press the digit outside a text field to run this step on the
              current selection (or the open thread).
            </p>
          </div>
          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving && (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              )}
              {editing ? "Save Changes" : "Create Quick Step"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function QuickStepRowItem({
  step,
  isFirst,
  isLast,
  onMove,
  onEdit,
  onDelete,
}: {
  step: QuickStep
  isFirst: boolean
  isLast: boolean
  onMove: (step: QuickStep, direction: -1 | 1) => void
  onEdit: (step: QuickStep) => void
  onDelete: (step: QuickStep) => void
}) {
  return (
    <div
      data-testid="settings-quick-step-row"
      className="flex items-start gap-3 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">
            {step.name}
          </p>
          {step.shortcut && (
            <kbd
              data-testid={`quick-step-shortcut-${step.shortcut}`}
              className="inline-flex min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-foreground"
            >
              {step.shortcut}
            </kbd>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {step.actions.map((action, index) => (
            <Badge
              key={`${action.kind}-${index}`}
              variant="outline"
              className="font-normal"
            >
              {quickStepActionChip(action)}
            </Badge>
          ))}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${step.name} up`}
        disabled={isFirst}
        onClick={() => onMove(step, -1)}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${step.name} down`}
        disabled={isLast}
        onClick={() => onMove(step, 1)}
      >
        <ChevronDown />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Edit ${step.name}`}
        onClick={() => onEdit(step)}
      >
        <Pencil />
        Edit
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Delete ${step.name}`}
        onClick={() => onDelete(step)}
      >
        <Trash2 />
        Delete
      </Button>
    </div>
  )
}

export function QuickStepsSection() {
  const [steps, setSteps] = useState<QuickStep[]>([])
  const [dialog, setDialog] = useState<DialogTarget | null>(null)

  const reload = useCallback(() => {
    try {
      void listQuickSteps(getExecutor())
        .then(setSteps)
        .catch((error) => {
          console.warn("[settings] failed to load quick steps", error)
        })
    } catch (error) {
      console.warn("[settings] failed to load quick steps", error)
    }
  }, [])

  // The shell only mounts settings after bootstrap(), so the executor is
  // available (same assumption as the other sections).
  useEffect(reload, [reload])

  /** Neighbor swap (the rules-section pattern) through the service's
   * partial reorder: two ids, everything else keeps its relative slot. */
  async function handleMove(step: QuickStep, direction: -1 | 1): Promise<void> {
    const index = steps.findIndex((candidate) => candidate.id === step.id)
    const neighborIndex = index + direction
    if (index === -1 || neighborIndex < 0 || neighborIndex >= steps.length) {
      return
    }
    const neighbor = steps[neighborIndex]!
    try {
      await reorderQuickSteps(
        getExecutor(),
        direction === -1
          ? [step.id, neighbor.id]
          : [neighbor.id, step.id]
      )
      reload()
    } catch (error) {
      console.warn("[settings] failed to reorder quick steps", error)
    }
  }

  async function handleDelete(step: QuickStep): Promise<void> {
    try {
      await deleteQuickStep(getExecutor(), step.id)
      reload()
    } catch (error) {
      console.warn("[settings] failed to delete quick step", error)
    }
  }

  return (
    <section aria-label="Quick steps" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Quick steps
          </h2>
          <p className="text-sm text-muted-foreground">
            Two or more actions, applied together to a thread or the whole
            selection — for every account.
          </p>
        </div>
        <Button size="sm" onClick={() => setDialog({ mode: "add" })}>
          <ListChecks />
          Add Quick Step
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Actions run in order (label before archive, so the label lands
        first). Label names resolve against each thread&apos;s own account
        at run time. Steps appear in the thread context menu, the command
        palette, and — when given a digit — on that key.
      </p>
      <Separator />
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No quick steps yet. Add one to run a chain of actions in one go.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {steps.map((step, index) => (
            <QuickStepRowItem
              key={step.id}
              step={step}
              isFirst={index === 0}
              isLast={index === steps.length - 1}
              onMove={(target, direction) => {
                void handleMove(target, direction)
              }}
              onEdit={(target) => setDialog({ mode: "edit", step: target })}
              onDelete={(target) => {
                void handleDelete(target)
              }}
            />
          ))}
        </div>
      )}
      {/* Remounted on every open so the form always starts fresh. */}
      {dialog && (
        <QuickStepDialog
          key={dialog.mode === "edit" ? `edit-${dialog.step.id}` : "add"}
          target={dialog}
          steps={steps}
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
          onSaved={reload}
        />
      )}
    </section>
  )
}
