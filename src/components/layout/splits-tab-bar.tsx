import { useMemo, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  CirclePlus,
  EllipsisVertical,
  EyeOff,
  Eye,
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
import type { SplitConfig } from "@/services/settings/splits"
import { useAccountStore } from "@/stores/account-store"
import { useUiStore } from "@/stores/ui-store"
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
 * The splits tab bar (task 9.3, mailbox-ui spec "Split inbox tabs"): one
 * tab per visible split, mounted above the thread list. A tab shows the
 * split's name and its thread count (countThreadsForQuery — the exact
 * search pipeline, see useSplitCounts for liveness); clicking enters the
 * split's list scope (ui-store setListScope, design D4), clicking the
 * active tab again leaves it. Each tab carries a menu (move left/right,
 * hide, delete); the trailing "+" opens the create dialog (name, operator
 * query, optional account pin) and a manage dialog that lists hidden
 * splits for unhide/delete. Splits are local config — deleting one never
 * touches mail.
 */

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
  const visible = useMemo(
    () => splits.filter((split) => !split.hidden),
    [splits]
  )
  const hidden = useMemo(() => splits.filter((split) => split.hidden), [splits])
  const counts = useSplitCounts(visible)
  const [dialog, setDialog] = useState<"create" | "manage" | null>(null)

  return (
    <>
      <div
        role="tablist"
        aria-label="Splits"
        data-testid="splits-tab-bar"
        className="flex items-center gap-0.5 border-b px-2 pb-1"
      >
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
