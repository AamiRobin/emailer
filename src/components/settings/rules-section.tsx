import { useCallback, useEffect, useState } from "react"
import {
  ChevronDown,
  ChevronUp,
  Filter,
  Pencil,
  Sparkles,
  Trash2,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { getExecutor } from "@/services/db/executor"
import type { RuleAssistCandidate } from "@/services/ai/rule-assist"
import { isAiConfigured, isSurfaceEnabled } from "@/services/ai/settings"
import type { RuleRow } from "@/services/rules"
import {
  deleteRule,
  listRules,
  parseActionsJson,
  updateRule,
} from "@/services/rules"
import { useActiveAccount } from "@/stores/account-store"

import { ApplyRuleDialog } from "./apply-rule-dialog"
import { DescribeRuleDialog } from "./describe-rule-dialog"
import {
  RuleDialog,
  type RuleDialogTarget,
} from "@/components/rules/rule-dialog"
import {
  actionChipLabel,
  queryFromCriteriaJson,
} from "@/components/rules/rule-actions-ui"

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
 * The add/edit form itself lives in components/rules/rule-dialog.tsx —
 * extracted so the search row's "create filter with this search" affordance
 * mounts the same dialog.
 */

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

export function RulesSection() {
  const account = useActiveAccount()
  const [rules, setRules] = useState<RuleRow[]>([])
  const [dialog, setDialog] = useState<RuleDialogTarget | null>(null)
  // Task 2.5: the "Describe a rule…" affordance's state — the dialog's
  // open flag, its availability probe (AI configured + ruleAssist surface
  // on; fail-toward-hidden like every AI affordance), and the validated
  // candidate awaiting the editor's explicit confirm.
  const [describeOpen, setDescribeOpen] = useState(false)
  const [describeAvailable, setDescribeAvailable] = useState(false)
  const [candidate, setCandidate] = useState<RuleAssistCandidate | null>(null)

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

  // Task 2.5: the describe affordance renders ONLY when AI is configured
  // AND the ruleAssist surface is enabled — the same best-effort probe
  // and fail-toward-hidden posture as the reading pane's AI affordances.
  useEffect(() => {
    let cancelled = false
    try {
      const executor = getExecutor()
      void (async () => {
        try {
          const [configured, surface] = await Promise.all([
            isAiConfigured(executor),
            isSurfaceEnabled(executor, "ruleAssist"),
          ])
          if (!cancelled) setDescribeAvailable(configured && surface)
        } catch {
          if (!cancelled) setDescribeAvailable(false)
        }
      })()
    } catch {
      // No executor — hidden.
    }
    return () => {
      cancelled = true
    }
  }, [])

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
        <div className="flex shrink-0 items-center gap-2">
          {/* Task 2.5: the natural-language entry point, beside the manual
              flow. Visible only when AI can serve it (probe above); opens
              the describe dialog, whose valid candidates continue in the
              SAME RuleDialog editor below — creation stays the editor's
              explicit save, exactly like the manual flow. */}
          {account && describeAvailable && (
            <Button
              size="sm"
              variant="outline"
              data-testid="describe-rule-open"
              onClick={() => setDescribeOpen(true)}
            >
              <Sparkles />
              Describe a rule…
            </Button>
          )}
          <Button
            size="sm"
            disabled={!account}
            onClick={() => setDialog({ mode: "add" })}
          >
            <Filter />
            Add Rule
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Rules run top to bottom on each new message, before the new-mail
        notification: archive, trash, spam, move, and mark-read rules keep the
        message out of the announcement. Criteria use the search-box operators —
        including negation (a leading -), sizes (larger:/smaller:) and dates
        (before:/after:).
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
      {/* Task 2.5: the describe dialog. A derived candidate opens the SAME
          RuleDialog editor in add mode, prefilled with the translated
          name/query/actions (its own key so the prefill initializes);
          creation happens ONLY on the editor's explicit save, and a
          cancel writes nothing. */}
      {account && (
        <DescribeRuleDialog
          open={describeOpen}
          onOpenChange={(open) => {
            if (!open) setDescribeOpen(false)
          }}
          onDerived={(derived) => {
            setCandidate(derived)
            setDescribeOpen(false)
          }}
        />
      )}
      {candidate && account && (
        <RuleDialog
          key={`describe-${candidate.name}-${candidate.criteriaQuery}`}
          accountId={account.id}
          target={{ mode: "add" }}
          initialName={candidate.name}
          initialCriteria={candidate.criteriaQuery}
          initialActions={candidate.actions}
          onOpenChange={(open) => {
            if (!open) setCandidate(null)
          }}
          onSaved={() => {
            setCandidate(null)
            reload()
          }}
        />
      )}
    </section>
  )
}
