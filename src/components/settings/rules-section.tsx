import { useCallback, useEffect, useState } from "react"
import {
  ChevronDown,
  ChevronUp,
  CirclePlus,
  Filter,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
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
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { getExecutor } from "@/services/db/executor"
import type { RuleAction, RuleActionType, RuleRow } from "@/services/rules"
import {
  createRule,
  deleteRule,
  listRules,
  parseActionsJson,
  updateRule,
} from "@/services/rules"
import { useActiveAccount } from "@/stores/account-store"

import { ApplyRuleDialog } from "./apply-rule-dialog"

/**
 * Settings "Rules" section (task 11.3, design D5): manages the per-account
 * mail rules of the ACTIVE account (the account-store selection — rules are
 * per-account rows, same scoping as the notifications section). Rows show
 * the criteria query (the raw search-operator string stored inside
 * criteria_json), one chip per parsed action, an enabled switch that
 * persists immediately, up/down ordering controls (a position swap via
 * updateRule on the two neighboring rows — listRules orders by position
 * ASC, and ingestion evaluates in that order), edit and delete (no confirm
 * — a rule is trivially re-created, matching the notifications section).
 *
 * The criteria "builder" is a QUERY INPUT on purpose (11.2's storage
 * comment): the same operator language the search box takes, so the parser
 * stays the single source of truth for the grammar. Helper text lists the
 * supported operators (services/search/parser.ts is the exact set) and the
 * combination semantics documented in rules/criteria.ts — same-operator
 * values OR, different operators AND.
 */

const CRITERIA_HELP =
  "Same language as the search box: from: to: subject: label: " +
  "has:attachment is:unread is:starred, plus plain words that must appear " +
  "in the subject or the snippet. Values of the same operator match either " +
  "value; different operators must all match."

const ACTION_TYPE_OPTIONS: { value: RuleActionType; label: string }[] = [
  { value: "archive", label: "Archive" },
  { value: "trash", label: "Trash" },
  { value: "mark_as_spam", label: "Mark as spam" },
  { value: "mark_read", label: "Mark read" },
  { value: "star", label: "Star" },
  { value: "add_labels", label: "Add labels" },
  { value: "move", label: "Move to folder (imap)" },
]

function actionChipLabel(action: RuleAction): string {
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
    case "move":
      return `Move: ${action.folder ?? ""}`
  }
}

/** Inverse of db.ts's storage wrapper: the raw query inside criteria_json
 * (a bare JSON string is tolerated, same as parseRuleCriteria). */
function queryFromCriteriaJson(criteriaJson: string): string {
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

/** "Newsletters, Receipts" → ["Newsletters", "Receipts"] — trimmed,
 * empties dropped. */
function splitLabels(input: string): string[] {
  return input
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
}

function RuleRowItem({
  rule,
  isFirst,
  isLast,
  onToggleEnabled,
  onMove,
  onEdit,
  onDelete,
}: {
  rule: RuleRow
  isFirst: boolean
  isLast: boolean
  onToggleEnabled: (rule: RuleRow, enabled: boolean) => void
  onMove: (rule: RuleRow, direction: -1 | 1) => void
  onEdit: (rule: RuleRow) => void
  onDelete: (rule: RuleRow) => void
}) {
  const name = rule.name
  return (
    <div
      data-testid="settings-rule-row"
      className="flex items-start gap-3 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {queryFromCriteriaJson(rule.criteria_json)}
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {parseActionsJson(rule.actions_json).map((action, index) => (
            <Badge
              key={`${action.type}-${index}`}
              variant="outline"
              className="font-normal"
            >
              {actionChipLabel(action)}
            </Badge>
          ))}
        </div>
      </div>
      <Switch
        size="sm"
        checked={rule.enabled === 1}
        onCheckedChange={(checked) => {
          onToggleEnabled(rule, checked)
        }}
        aria-label={`Toggle ${name}`}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${name} up`}
        disabled={isFirst}
        onClick={() => onMove(rule, -1)}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${name} down`}
        disabled={isLast}
        onClick={() => onMove(rule, 1)}
      >
        <ChevronDown />
      </Button>
      {/* Task 11.4 mount: one self-contained "Apply now" gate per row —
          trigger plus the count→confirm dialog. It toasts its own result
          and the rule row's data doesn't change, so there is nothing to
          refresh afterwards (no onDone wiring). */}
      <ApplyRuleDialog rule={rule} />
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Edit ${name}`}
        onClick={() => onEdit(rule)}
      >
        <Pencil />
        Edit
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Delete ${name}`}
        onClick={() => onDelete(rule)}
      >
        <Trash2 />
        Delete
      </Button>
    </div>
  )
}

/** One action row in the builder's local draft state — the type-specific
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

type DialogTarget = { mode: "add" } | { mode: "edit"; rule: RuleRow }

function RuleDialog({
  accountId,
  target,
  onOpenChange,
  onSaved,
}: {
  accountId: string
  target: DialogTarget
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const editing = target.mode === "edit" ? target.rule : null
  const [name, setName] = useState(editing?.name ?? "")
  const [criteria, setCriteria] = useState(
    editing ? queryFromCriteriaJson(editing.criteria_json) : ""
  )
  const [drafts, setDrafts] = useState<ActionDraft[]>(() =>
    draftsFromActions(editing ? parseActionsJson(editing.actions_json) : [])
  )
  const [enabled, setEnabled] = useState(editing ? editing.enabled === 1 : true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const labelActionsFilled = drafts.every(
    (draft) =>
      draft.type !== "add_labels" || splitLabels(draft.labels).length > 0
  )
  const moveFoldersFilled = drafts.every(
    (draft) => draft.type !== "move" || draft.folder.trim() !== ""
  )
  const canSave =
    name.trim() !== "" &&
    criteria.trim() !== "" &&
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

  async function handleSave(): Promise<void> {
    if (!canSave) return
    setSaving(true)
    setErrorMessage(null)
    const actions: RuleAction[] = drafts.map((draft) => {
      if (draft.type === "add_labels") {
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
          criteriaQuery: criteria.trim(),
          actions,
          enabled,
        })
        toast.success(`Rule “${name.trim()}” updated`)
      } else {
        await createRule(executor, {
          accountId,
          name: name.trim(),
          criteriaQuery: criteria.trim(),
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

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
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
                {draft.type === "add_labels" && (
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

export function RulesSection() {
  const account = useActiveAccount()
  const [rules, setRules] = useState<RuleRow[]>([])
  const [dialog, setDialog] = useState<DialogTarget | null>(null)

  const reload = useCallback(() => {
    // Without an active account there is nothing to load — the render
    // below shows the no-account state, so the stale list stays hidden.
    if (!account) return
    try {
      void listRules(getExecutor(), account.id)
        .then(setRules)
        .catch((error) => {
          console.warn("[settings] failed to load rules", error)
        })
    } catch (error) {
      console.warn("[settings] failed to load rules", error)
    }
  }, [account])

  // The shell only mounts settings after bootstrap(), so the executor is
  // available (same assumption as the other sections).
  useEffect(reload, [reload])

  async function handleToggleEnabled(
    rule: RuleRow,
    enabled: boolean
  ): Promise<void> {
    try {
      await updateRule(getExecutor(), rule.id, { enabled })
      reload()
    } catch (error) {
      console.warn("[settings] failed to update rule", error)
    }
  }

  /** Ordering is the ingestion evaluation order (listRules sorts by
   * position ASC): moving swaps `position` with the neighboring row via
   * two updateRule calls, then re-reads. Equal positions (never written by
   * this UI, but possible in hand-edited data) are renumbered by list index
   * so the swap still takes effect. */
  async function handleMove(rule: RuleRow, direction: -1 | 1): Promise<void> {
    const index = rules.findIndex((candidate) => candidate.id === rule.id)
    const neighborIndex = index + direction
    if (index === -1 || neighborIndex < 0 || neighborIndex >= rules.length) {
      return
    }
    const neighbor = rules[neighborIndex]!
    try {
      if (neighbor.position === rule.position) {
        await updateRule(getExecutor(), rule.id, {
          position: neighborIndex,
        })
        await updateRule(getExecutor(), neighbor.id, { position: index })
      } else {
        await updateRule(getExecutor(), rule.id, {
          position: neighbor.position,
        })
        await updateRule(getExecutor(), neighbor.id, {
          position: rule.position,
        })
      }
      reload()
    } catch (error) {
      console.warn("[settings] failed to reorder rules", error)
    }
  }

  async function handleDelete(rule: RuleRow): Promise<void> {
    try {
      await deleteRule(getExecutor(), rule.id)
      reload()
    } catch (error) {
      console.warn("[settings] failed to delete rule", error)
    }
  }

  return (
    <section aria-label="Rules" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-foreground">Rules</h2>
          <p className="text-sm text-muted-foreground">
            {account
              ? `Automatically file new mail for ${account.email}.`
              : "Automatically file new mail as it arrives."}
          </p>
        </div>
        <Button
          size="sm"
          disabled={!account}
          onClick={() => setDialog({ mode: "add" })}
        >
          <Filter />
          Add Rule
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Rules run top to bottom on each new message, before the new-mail
        notification: archive, trash, spam, move, and mark-read rules keep the
        message out of the announcement. Criteria use the search-box operators.
      </p>
      <Separator />
      {!account ? (
        <p className="text-sm text-muted-foreground">
          Add an account to manage its rules.
        </p>
      ) : rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No rules yet. New mail arrives untouched.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {rules.map((rule, index) => (
            <RuleRowItem
              key={rule.id}
              rule={rule}
              isFirst={index === 0}
              isLast={index === rules.length - 1}
              onToggleEnabled={(target, enabled) => {
                void handleToggleEnabled(target, enabled)
              }}
              onMove={(target, direction) => {
                void handleMove(target, direction)
              }}
              onEdit={(target) => setDialog({ mode: "edit", rule: target })}
              onDelete={(target) => {
                void handleDelete(target)
              }}
            />
          ))}
        </div>
      )}
      {/* Remounted on every open so the form always starts fresh. */}
      {dialog && account && (
        <RuleDialog
          key={dialog.mode === "edit" ? `edit-${dialog.rule.id}` : "add"}
          accountId={account.id}
          target={dialog}
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
          onSaved={reload}
        />
      )}
    </section>
  )
}
