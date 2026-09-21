import { useMemo, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  CirclePlus,
  EllipsisVertical,
  EyeOff,
  Eye,
  Inbox,
  Settings2,
  Trash2,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Category } from "@/services/categorization/classify"
import type { SplitConfig } from "@/services/settings/splits"
import { useAccountStore } from "@/stores/account-store"
import {
  refreshThreadList,
  useThreadListStore,
} from "@/stores/thread-list-store"
import { useUiStore } from "@/stores/ui-store"
import { CategoryBackfillStatus } from "./category-backfill-status"
import {
  CATEGORIES,
  CATEGORY_LABELS,
  categorizeExistingMail,
  enterCategory,
  leaveCategory,
  notifyCategoryMailChanged,
  registerCategoryListRefresh,
  setCategoryTabsEnabled,
  useCategoriesEnabled,
  useCategoryCounts,
} from "./use-categories"
import {
  createSplitWithToast,
  deleteSplitById,
  enterSplit,
  leaveSplit,
  moveSplitById,
  setSplitHiddenById,
  useSplitCounts,
  useSplits,
} from "./use-splits"

/**
 * The mailbox tab bar: the category tabs (task 3.5, mailbox-ui spec
 * "Category tab presentation") followed by the splits tabs (task 9.3,
 * same spec "Split inbox tabs") — one row, categories ordered FIRST per
 * the spec, Primary visually default while no category scope is active.
 * A category tab shows its display name and its UNREAD count (the spec's
 * "unread counts per category"; the total rides in the tooltip), and
 * clicking enters that category's list scope (ui-store setListScope,
 * design D4 — the exact split-tab sequence via use-categories.ts);
 * clicking the active tab again leaves it. The row is hideable through
 * `organization.categoriesEnabled` (default off — the bar then shows only
 * the user's split tabs), the trailing category menu offers "Categorize
 * existing mail…" (launches the backfill) and "Hide category tabs", and
 * the backfill's progress surface (CategoryBackfillStatus) renders under
 * the row while a job is in flight. Split tabs are unchanged by all of
 * this — see their original docstring below.
 *
 * The splits half (task 9.3, mailbox-ui spec "Split inbox tabs"): one tab
 * per visible split, each showing the split's name and its thread count
 * (countThreadsForQuery — the exact search pipeline, see useSplitCounts
 * for liveness); clicking enters the split's list scope, clicking the
 * active tab again leaves it. Each tab carries a menu (move left/right,
 * hide, delete); the trailing "+" opens the create dialog (name, operator
 * query, optional account pin) and a manage dialog that lists hidden
 * splits for unhide/delete. Splits are local config — deleting one never
 * touches mail.
 */

// Category tab wiring (task 3.5): this module owns the thread-list store
// connection the settings-safe use-categories module plugs into (the
// design D11 lazy-load guard keeps crypto/pgp-transform out of the
// settings graph, so use-categories must not import the list store
// statically). Registered once at import: scope flips and the backfill's
// done-summary refresh the list through here, and every list reload (the
// post-action refresh) tells the counts hook to re-read its grouped
// COUNT.
registerCategoryListRefresh(refreshThreadList)
useThreadListStore.subscribe((state, previous) => {
  if (state.threads !== previous.threads) notifyCategoryMailChanged()
})

/**
 * One category tab (task 3.5): display name + UNREAD count badge (the
 * spec's "unread counts per category"; the total lives in the tooltip),
 * split-tab styling. Active is the scoped category — Primary when NO
 * category scope is active (the spec's "Primary SHALL be the default
 * tab"). Clicking enters the category's list scope; clicking the active
 * tab again leaves it (the split-tab contract).
 */
function CategoryTab({
  category,
  active,
  unread,
  total,
}: {
  category: Category
  active: boolean
  unread: number
  total: number
}) {
  const label = CATEGORY_LABELS[category]
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid="category-tab"
      data-category={category}
      title={`${label} — ${total} ${total === 1 ? "thread" : "threads"}`}
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-md py-1 ps-2.5 pe-2 text-sm",
        active ? "bg-muted text-foreground" : "hover:bg-accent/50"
      )}
      onClick={() => {
        if (active) {
          void leaveCategory()
        } else {
          void enterCategory(category)
        }
      }}
    >
      <span className="max-w-40 truncate">{label}</span>
      <span
        data-testid="category-tab-count"
        className={cn(
          "rounded-full px-1.5 text-xs font-medium text-muted-foreground tabular-nums",
          active ? "bg-background" : "bg-muted"
        )}
      >
        {unread}
      </span>
    </button>
  )
}

/**
 * The category row's trailing menu (task 3.5): the on-demand
 * back-categorization launch (mail-organization spec "the user enables
 * categories and chooses to categorize existing mail" — the progress is
 * the status row under the bar) and the row's hide affordance (the same
 * `organization.categoriesEnabled` flag the settings section owns;
 * disabling returns the bar to splits-only and leaves the list alone).
 */
function CategoryTabsMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Category options"
            title="Category options"
          >
            <EllipsisVertical />
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={() => void categorizeExistingMail()}>
          <Inbox aria-hidden />
          Categorize existing mail…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void setCategoryTabsEnabled(false)}>
          <EyeOff aria-hidden />
          Hide category tabs
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SplitTabMenu({ split }: { split: SplitConfig }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Options for split ${split.name}`}
            className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
          >
            <EllipsisVertical className="size-3.5 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuItem
          onClick={() => {
            void moveSplitById(split.id, -1)
          }}
        >
          <ArrowLeft aria-hidden />
          Move left
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            void moveSplitById(split.id, 1)
          }}
        >
          <ArrowRight aria-hidden />
          Move right
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            void setSplitHiddenById(split.id, true)
          }}
        >
          <EyeOff aria-hidden />
          Hide
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => {
            void deleteSplitById(split.id)
          }}
        >
          <Trash2 aria-hidden />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SplitTab({
  split,
  active,
  count,
}: {
  split: SplitConfig
  active: boolean
  count: number
}) {
  return (
    <div
      data-split-tab={split.name}
      data-active={active ? "true" : "false"}
      className={cn(
        "flex min-w-0 items-center rounded-md",
        active ? "bg-muted text-foreground" : "hover:bg-accent/50"
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title={`${split.name} — ${split.query}`}
        data-testid="split-tab"
        className="flex min-w-0 items-center gap-1.5 py-1 ps-2.5 text-sm"
        onClick={() => {
          if (active) {
            void leaveSplit()
          } else {
            void enterSplit(split)
          }
        }}
      >
        <span className="max-w-40 truncate">{split.name}</span>
        <span
          data-testid="split-tab-count"
          className={cn(
            "rounded-full px-1.5 text-xs font-medium text-muted-foreground tabular-nums",
            active ? "bg-background" : "bg-muted"
          )}
        >
          {count}
        </span>
      </button>
      <SplitTabMenu split={split} />
    </div>
  )
}

/**
 * The create dialog ("+" → New split…): name (required, unique —
 * duplicates render a form error, the snippets-section pattern), the
 * operator query as free text, and an optional account pin (spec: splits
 * are "per-account or unified at the user's choice").
 */
function CreateSplitDialog({
  initialQuery = "",
  onOpenChange,
}: {
  initialQuery?: string
  onOpenChange: (open: boolean) => void
}) {
  const accounts = useAccountStore((state) => state.accounts)
  const activeAccounts = useMemo(
    () => accounts.filter((account) => account.status === "active"),
    [accounts]
  )
  const [name, setName] = useState("")
  const [query, setQuery] = useState(initialQuery)
  const [accountId, setAccountId] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(): Promise<void> {
    if (!name.trim() || saving) return
    setSaving(true)
    setError(null)
    const outcome = await createSplitWithToast({
      name,
      query,
      accountId: accountId || null,
    })
    if (outcome.ok) {
      onOpenChange(false)
      return
    }
    setSaving(false)
    setError(
      outcome.error === "name-taken"
        ? `A split named “${name.trim()}” already exists.`
        : "Could not create the split."
    )
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New split</DialogTitle>
          <DialogDescription>
            A split is a named operator query shown as a tab above the inbox.
            The same language as the search field.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSubmit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="split-name">Name</Label>
            <Input
              id="split-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Unread from boss"
              autoFocus
              disabled={saving}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="split-query">Query</Label>
            <Input
              id="split-query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="e.g. is:unread from:boss@work.com"
              disabled={saving}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="split-account">Account</Label>
            <Select
              value={accountId}
              onValueChange={(value) => setAccountId(String(value))}
            >
              <SelectTrigger id="split-account" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">All accounts</SelectItem>
                {activeAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
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
            <Button type="submit" disabled={saving || !name.trim()}>
              Create split
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The manage dialog ("+" → Manage splits…): lists the HIDDEN splits with
 * Unhide (back to the bar, original slot kept) and Delete (gone for
 * good). Visible splits are managed on their tabs' own menus.
 */
function ManageSplitsDialog({
  hiddenSplits,
  onOpenChange,
}: {
  hiddenSplits: SplitConfig[]
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage splits</DialogTitle>
          <DialogDescription>
            Hidden splits stay configured but drop out of the tab bar.
          </DialogDescription>
        </DialogHeader>
        {hiddenSplits.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hidden splits.</p>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {hiddenSplits.map((split) => (
              <div
                key={split.id}
                data-testid="hidden-split-row"
                className="flex items-center gap-2 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{split.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {split.query}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Unhide split ${split.name}`}
                  onClick={() => {
                    void setSplitHiddenById(split.id, false)
                  }}
                >
                  <Eye aria-hidden />
                  Unhide
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete split ${split.name}`}
                  onClick={() => {
                    void deleteSplitById(split.id)
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SplitsTabBar() {
  const splits = useSplits()
  const listScope = useUiStore((state) => state.listScope)
  const categoriesEnabled = useCategoriesEnabled()
  const categoryCounts = useCategoryCounts()
  const visible = useMemo(
    () => splits.filter((split) => !split.hidden),
    [splits]
  )
  const hidden = useMemo(() => splits.filter((split) => split.hidden), [splits])
  const counts = useSplitCounts(visible)
  const [dialog, setDialog] = useState<"create" | "manage" | null>(null)
  // The scoped category, or null while the bar shows the default state
  // (Primary tab active, underlying view list untouched).
  const activeCategory =
    listScope?.kind === "category" ? listScope.category : null

  return (
    <>
      <div
        role="tablist"
        aria-label="Mailbox tabs"
        data-testid="splits-tab-bar"
        className="flex items-center gap-0.5 border-b px-2 pb-1"
      >
        {/* Category tabs (task 3.5): ordered FIRST, before the splits, per
            the spec — rendered only while the row is enabled. */}
        {categoriesEnabled && (
          <>
            {CATEGORIES.map((category) => (
              <CategoryTab
                key={category}
                category={category}
                active={
                  activeCategory === null
                    ? category === "primary"
                    : activeCategory === category
                }
                unread={categoryCounts[category]?.unread ?? 0}
                total={categoryCounts[category]?.total ?? 0}
              />
            ))}
            <CategoryTabsMenu />
          </>
        )}
        {visible.map((split) => {
          const active =
            listScope?.kind === "split" && listScope.name === split.name
          return (
            <SplitTab
              key={split.id}
              split={split}
              active={active}
              count={counts[split.id] ?? 0}
            />
          )
        })}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Split options"
                title="New split"
              >
                <CirclePlus />
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => setDialog("create")}>
              <CirclePlus aria-hidden />
              New split…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setDialog("manage")}>
              <Settings2 aria-hidden />
              Manage splits…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* Backfill progress (task 3.5): a status line under the tab row
          while the categorization job runs; renders nothing otherwise. */}
      {categoriesEnabled && <CategoryBackfillStatus />}
      {/* Remounted on every open so the forms always start fresh. */}
      {dialog === "create" && (
        <CreateSplitDialog
          key="create"
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
        />
      )}
      {dialog === "manage" && (
        <ManageSplitsDialog
          key="manage"
          hiddenSplits={hidden}
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
        />
      )}
    </>
  )
}
