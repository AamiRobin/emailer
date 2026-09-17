import { useState } from "react"
import { Filter } from "lucide-react"

import { RuleDialog } from "@/components/rules/rule-dialog"
import { Button } from "@/components/ui/button"
import { useActiveAccount } from "@/stores/account-store"

/**
 * "Create filter with this search" affordance (mail-organization spec,
 * Rules for automatic actions): mounted by the search field next to the
 * save-search actions, visible exactly while a search view with a
 * non-empty query is active AND an account is active (rules are
 * per-account rows). Clicking opens the shared rule dialog with the
 * query as typed prefilled as the rule's criteria, targeting the ACTIVE
 * account — the same criteria language runs both the search and the rule,
 * so the prefill reads back exactly what the user searched.
 */
export function CreateFilterButton({ query }: { query: string }) {
  const account = useActiveAccount()
  const [open, setOpen] = useState(false)
  if (!account) return null
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Create filter with this search"
        title="Create filter with this search"
        data-testid="create-filter-button"
        onClick={() => setOpen(true)}
      >
        <Filter />
      </Button>
      {/* Remounted on every open so the form starts fresh. Nothing in the
          search view depends on the saved rule, so there is no onSaved
          wiring beyond closing (same reasoning as ApplyRuleDialog). */}
      {open && (
        <RuleDialog
          key="create-filter"
          accountId={account.id}
          target={{ mode: "add" }}
          initialCriteria={query}
          onOpenChange={setOpen}
          onSaved={() => {}}
        />
      )}
    </>
  )
}
