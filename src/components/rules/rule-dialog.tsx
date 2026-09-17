import { useState } from "react"
import { CirclePlus, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { getExecutor } from "@/services/db/executor"
import type { RuleAction, RuleActionType, RuleRow } from "@/services/rules"
import { createRule, parseActionsJson, updateRule } from "@/services/rules"

import {
  ACTION_TYPE_OPTIONS,
  CRITERIA_HELP,
  queryFromCriteriaJson,
} from "./rule-actions-ui"
import {
  composeCriteriaQuery,
  criteriaFieldsFromQuery,
  emptyCriteriaFields,
  type CriteriaFields,
} from "./rule-criteria"

/**
 * The add/edit rule dialog, shared by the Settings rules section and the
 * search row's "create filter with this search" affordance. Criteria are
 * a Gmail-style FORM (design D10): labeled rows compose into the same
 * query language the search box takes (services/search/parser.ts is the
 * single source of truth — the form is a compiler on top of it), stored
 * unchanged in criteria_json. The raw query input remains behind the
 * "Advanced query" checkbox, and a query the form can't represent
 * (labels, is: flags, negated operators, multiple bounds) opens in
 * advanced mode with it verbatim. See the rules-section module comment
 * for the row semantics.
 */

/** "Newsletters, Receipts" → ["Newsletters", "Receipts"] — trimmed,
 * empties dropped. */
function splitLabels(input: string): string[] {
  return input
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
}

/** One action row in the dialog's local draft state — the type-specific
 * payloads (labels, folder) ride along as raw strings, split/trimmed only
 * at save time. */
interface ActionDraft {
  key: string
  type: RuleActionType
  labels: string
  folder: string
}

let draftKeySequence = 0

function nextDraftKey(): string {
  draftKeySequence += 1
  return `action-${draftKeySequence}`
}

function newActionDraft(type: RuleActionType = "archive"): ActionDraft {
  return { key: nextDraftKey(), type, labels: "", folder: "" }
}

function draftsFromActions(actions: RuleAction[]): ActionDraft[] {
  if (actions.length === 0) return [newActionDraft()]
  return actions.map((action) => ({
    key: nextDraftKey(),
    type: action.type,
    labels: (action.labels ?? []).join(", "),
    folder: action.folder ?? "",
  }))
}

export type RuleDialogTarget = { mode: "add" } | { mode: "edit"; rule: RuleRow }

/** The dialog's initial criteria state: a query that maps onto the form
 * prefills the labeled rows; anything else (or nothing) is handled by the
 * caller — an unrepresentable query opens in advanced mode verbatim. */
function initialCriteriaState(rawQuery: string): {
  fields: CriteriaFields
  criteria: string
  advanced: boolean
} {
  if (rawQuery.trim() === "") {
    return { fields: emptyCriteriaFields(), criteria: "", advanced: false }
  }
  const { fields, unrepresentable } = criteriaFieldsFromQuery(rawQuery)
  return {
    fields,
    criteria: rawQuery,
    advanced: unrepresentable,
  }
}

export function RuleDialog({
  accountId,
  target,
  initialCriteria = "",
  onOpenChange,
  onSaved,
}: {
  accountId: string
  target: RuleDialogTarget
  /** Criteria the form starts from in add mode — the search row prefills
   * it with the active query; Settings adds with it empty. */
  initialCriteria?: string
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const editing = target.mode === "edit" ? target.rule : null
  const [name, setName] = useState(editing?.name ?? "")
  const initial = initialCriteriaState(
    editing ? queryFromCriteriaJson(editing.criteria_json) : initialCriteria
  )
  const [fields, setFields] = useState<CriteriaFields>(initial.fields)
  const [criteria, setCriteria] = useState(initial.criteria)
  const [advanced, setAdvanced] = useState(initial.advanced)
  const [drafts, setDrafts] = useState<ActionDraft[]>(() =>
    draftsFromActions(editing ? parseActionsJson(editing.actions_json) : [])
  )
  const [enabled, setEnabled] = useState(editing ? editing.enabled === 1 : true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const criteriaQuery = advanced
    ? criteria.trim()
    : composeCriteriaQuery(fields)
  const labelActionsFilled = drafts.every(
    (draft) =>
      (draft.type !== "add_labels" && draft.type !== "remove_labels") ||
      splitLabels(draft.labels).length > 0
  )
  const moveFoldersFilled = drafts.every(
    (draft) => draft.type !== "move" || draft.folder.trim() !== ""
  )
  const canSave =
    name.trim() !== "" &&
    criteriaQuery !== null &&
    criteriaQuery !== "" &&
    drafts.length > 0 &&
    labelActionsFilled &&
    moveFoldersFilled &&
    !saving

  function updateDraft(key: string, patch: Partial<ActionDraft>): void {
    setDrafts((current) =>
      current.map((draft) =>
        draft.key === key ? { ...draft, ...patch } : draft
      )
    )
  }

  function removeDraft(key: string): void {
    setDrafts((current) => current.filter((draft) => draft.key !== key))
  }

  function updateFields(patch: Partial<CriteriaFields>): void {
    setFields((current) => ({ ...current, ...patch }))
  }

  /** form → advanced carries the composed query; advanced → form maps what
   * it can (unmappable tokens would be lost, so unmappable queries are the
   * mode the dialog already opened in and the checkbox is how the user
   * got here in the first place). */
  function toggleAdvanced(next: boolean): void {
    if (next) {
      setCriteria(composeCriteriaQuery(fields) ?? "")
    } else {
      setFields(criteriaFieldsFromQuery(criteria).fields)
    }
    setAdvanced(next)
  }

  async function handleSave(): Promise<void> {
    if (!canSave || criteriaQuery === null) return
    setSaving(true)
    setErrorMessage(null)
    const actions: RuleAction[] = drafts.map((draft) => {
      if (draft.type === "add_labels" || draft.type === "remove_labels") {
        return { type: draft.type, labels: splitLabels(draft.labels) }
      }
      if (draft.type === "move") {
        return { type: draft.type, folder: draft.folder.trim() }
      }
      return { type: draft.type }
    })
    try {
      const executor = getExecutor()
      if (editing) {
        await updateRule(executor, editing.id, {
          name: name.trim(),
          criteriaQuery,
          actions,
          enabled,
        })
        toast.success(`Rule “${name.trim()}” updated`)
      } else {
        await createRule(executor, {
          accountId,
          name: name.trim(),
          criteriaQuery,
          actions,
          enabled,
        })
        toast.success(`Rule “${name.trim()}” created`)
      }
      onSaved()
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not save the rule."
      )
      setSaving(false)
    }
  }

  const criteriaRows = (
    <>
      <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
        <Label htmlFor="crit-from">From</Label>
        <Input
          id="crit-from"
          value={fields.from}
          onChange={(event) => updateFields({ from: event.target.value })}
          placeholder="e.g. news@x.com"
        />
      </div>
      <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
        <Label htmlFor="crit-to">To</Label>
        <Input
          id="crit-to"
          value={fields.to}
          onChange={(event) => updateFields({ to: event.target.value })}
          placeholder="e.g. me@x.com"
        />
      </div>
      <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
        <Label htmlFor="crit-subject">Subject</Label>
        <Input
          id="crit-subject"
          value={fields.subject}
          onChange={(event) => updateFields({ subject: event.target.value })}
          placeholder="e.g. digest"
        />
      </div>
      <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
        <Label htmlFor="crit-has-words">Has the words</Label>
        <Input
          id="crit-has-words"
          value={fields.hasWords}
          onChange={(event) => updateFields({ hasWords: event.target.value })}
          placeholder="e.g. invoice total"
        />
      </div>
      <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
        <Label htmlFor="crit-doesnt-have">Doesn't have</Label>
        <Input
          id="crit-doesnt-have"
          value={fields.doesntHave}
          onChange={(event) => updateFields({ doesntHave: event.target.value })}
          placeholder="e.g. unsubscribe"
        />
      </div>
      <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
        <Label htmlFor="crit-size-value">Size</Label>
        <div className="flex items-center gap-2">
          <Select
            value={fields.sizeDirection}
            onValueChange={(value) =>
              updateFields({
                sizeDirection: value === "smaller" ? "smaller" : "larger",
              })
            }
          >
            <SelectTrigger aria-label="Size comparison" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="larger">greater than</SelectItem>
              <SelectItem value="smaller">less than</SelectItem>
            </SelectContent>
          </Select>
          <Input
            id="crit-size-value"
            type="number"
            min="0"
            value={fields.sizeValue}
            onChange={(event) =>
              updateFields({ sizeValue: event.target.value })
            }
            className="w-24"
            aria-label="Size value"
          />
          <Select
            value={fields.sizeUnit}
            onValueChange={(value) =>
              updateFields({ sizeUnit: value === "kb" ? "kb" : "mb" })
            }
          >
            <SelectTrigger aria-label="Size unit" className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mb">MB</SelectItem>
              <SelectItem value="kb">KB</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
        <Label htmlFor="crit-date-value">Arrived</Label>
        <div className="flex items-center gap-2">
          <Select
            value={fields.dateDirection}
            onValueChange={(value) =>
              updateFields({
                dateDirection: value === "after" ? "after" : "before",
              })
            }
          >
            <SelectTrigger aria-label="Date direction" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="before">before</SelectItem>
              <SelectItem value="after">after</SelectItem>
            </SelectContent>
          </Select>
          <Input
            id="crit-date-value"
            type="date"
            value={fields.dateValue}
            onChange={(event) =>
              updateFields({ dateValue: event.target.value })
            }
            aria-label="Date"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="crit-has-attachment"
          checked={fields.hasAttachment}
          onCheckedChange={(checked) => {
            updateFields({ hasAttachment: checked === true })
          }}
        />
        <Label htmlFor="crit-has-attachment">Has attachment</Label>
      </div>
    </>
  )

  return (
    <Dialog open onOpenChange={onOpenChange}>
      {/* wider than the sm:max-w-sm default: the Gmail-style criteria rows
          (label column + size/date control clusters) overflow a 24rem
          dialog, clipping the right-hand controls. */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Rule" : "Add Rule"}</DialogTitle>
          <DialogDescription>
            Rules run on each new message this account receives, top to bottom.
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
            <Label htmlFor="rule-name">Name</Label>
            <Input
              id="rule-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. File newsletters"
              autoFocus
            />
          </div>
          <div className="grid gap-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="rule-advanced"
                checked={advanced}
                onCheckedChange={(checked) => {
                  toggleAdvanced(checked === true)
                }}
              />
              <Label htmlFor="rule-advanced">Advanced query</Label>
            </div>
            {advanced ? (
              <div className="grid gap-2">
                <Label htmlFor="rule-criteria">When a message matches</Label>
                <Input
                  id="rule-criteria"
                  value={criteria}
                  onChange={(event) => setCriteria(event.target.value)}
                  placeholder="e.g. from:news@x.com subject:digest"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">{CRITERIA_HELP}</p>
              </div>
            ) : (
              criteriaRows
            )}
          </div>
          <div className="grid gap-2">
            <Label>Then</Label>
            {drafts.map((draft, index) => (
              <div key={draft.key} className="flex items-start gap-2">
                <Select
                  value={draft.type}
                  onValueChange={(value) =>
                    updateDraft(draft.key, {
                      type: String(value) as RuleActionType,
                    })
                  }
                >
                  <SelectTrigger
                    aria-label={`Action ${index + 1} type`}
                    className="w-44 shrink-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACTION_TYPE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(draft.type === "add_labels" ||
                  draft.type === "remove_labels") && (
                  <Input
                    aria-label={`Action ${index + 1} labels`}
                    value={draft.labels}
                    onChange={(event) =>
                      updateDraft(draft.key, { labels: event.target.value })
                    }
                    placeholder="Label names, comma-separated"
                  />
                )}
                {draft.type === "move" && (
                  <Input
                    aria-label={`Action ${index + 1} folder`}
                    value={draft.folder}
                    onChange={(event) =>
                      updateDraft(draft.key, { folder: event.target.value })
                    }
                    placeholder="Folder path, e.g. Archive/2024"
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove action ${index + 1}`}
                  onClick={() => removeDraft(draft.key)}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setDrafts((current) => [...current, newActionDraft()])
                }
              >
                <CirclePlus />
                Add Action
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="rule-enabled"
              checked={enabled}
              onCheckedChange={(checked) => {
                setEnabled(checked === true)
              }}
            />
            <Label htmlFor="rule-enabled">Enabled</Label>
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
              {editing ? "Save Changes" : "Create Rule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
