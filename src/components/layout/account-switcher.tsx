import { useState } from "react"
import { CirclePlus, KeyRound, TriangleAlert } from "lucide-react"

import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { AccountInfo } from "@/stores/account-store"
import { selectActiveAccount, useAccountStore } from "@/stores/account-store"
import { ReauthDialog } from "@/components/accounts/reauth-dialog"
import { ProviderIcon } from "@/components/providers/provider-icon"
import { brandForAccount } from "@/services/account-flows"

interface AccountSwitcherProps {
  isCollapsed: boolean
  /** Opens the add-account dialog (hosted by the mail shell). */
  onAddAccount?: () => void
}

/** Sentinel SelectItem value for the "Add account" entry. */
const ADD_ACCOUNT_VALUE = "add-account"

/**
 * Sentinel value prefix for the per-account "Re-authenticate…" entry
 * (task 5.5). Choosing it never switches the account — onValueChange
 * routes the parsed id to the re-auth dialog instead, exactly like the
 * "Add account" sentinel. Removal is not offered here; it lives in
 * Settings → Accounts.
 */
const REAUTH_ACTION_PREFIX = "action:reauth:"

/** Two-letter initials from the display name (or email local part). */
function initialsOf(account: AccountInfo): string {
  const name = (account.displayName ?? account.email).trim()
  const parts = name.split(/\s+/).slice(0, 2)
  const initials = parts.map((part) => part.charAt(0).toUpperCase()).join("")
  return initials || "?"
}

function AccountAvatar({
  account,
  size = "default",
}: {
  account: AccountInfo
  size?: "default" | "sm"
}) {
  // Known provider → brand glyph in the circle; unknown/custom domains
  // keep the initials (or "?") fallback.
  const brand = brandForAccount(account.type, account.email)
  return (
    <Avatar size={size} className="shrink-0">
      <AvatarFallback className="text-xs">
        {brand ? (
          <ProviderIcon
            provider={brand}
            className={size === "sm" ? "size-3.5" : "size-4"}
          />
        ) : (
          initialsOf(account)
        )}
      </AvatarFallback>
    </Avatar>
  )
}

/** Provider glyph before the email in dropdown rows; none when unknown. */
function AccountRowIcon({ account }: { account: AccountInfo }) {
  const brand = brandForAccount(account.type, account.email)
  if (!brand) return null
  return <ProviderIcon provider={brand} className="size-3.5 shrink-0" />
}

/**
 * Sidebar account switcher, driven by the account store (zustand +
 * SQLite-backed, see src/stores/account-store.ts). Selecting an account is
 * an instant local switch — the store update is the whole operation, the
 * is_active persistence happens in the background. Ported visual design
 * from the tweakcn mail example (components/examples/mail), on base-nova
 * primitives.
 *
 * The per-account "Re-authenticate…" entry (task 5.5) follows paused
 * accounts in the dropdown as a sentinel-valued item: it opens the
 * re-auth dialog; the warning glyph is the indicator, the entry is its
 * action. Account removal is intentionally not offered here — it lives
 * in Settings → Accounts. The dialog lives in components/accounts and
 * is hosted here.
 */
export function AccountSwitcher({
  isCollapsed,
  onAddAccount,
}: AccountSwitcherProps) {
  const accounts = useAccountStore((state) => state.accounts)
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const setActive = useAccountStore((state) => state.setActive)
  const activeAccount = useAccountStore(selectActiveAccount)
  const [reauthTarget, setReauthTarget] = useState<AccountInfo | null>(null)

  function findAccount(value: string): AccountInfo | null {
    return accounts.find((account) => account.id === value) ?? null
  }

  return (
    <>
      <Select
        value={activeAccountId}
        onValueChange={(nextId) => {
          if (typeof nextId !== "string") return
          if (nextId === ADD_ACCOUNT_VALUE) {
            onAddAccount?.()
            return
          }
          if (nextId.startsWith(REAUTH_ACTION_PREFIX)) {
            setReauthTarget(
              findAccount(nextId.slice(REAUTH_ACTION_PREFIX.length))
            )
            return
          }
          if (nextId !== "no-accounts") {
            void setActive(nextId)
          }
        }}
      >
        {isCollapsed && activeAccount ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <SelectTrigger
                  className="flex h-9 w-9 shrink-0 items-center justify-center p-0 [&>svg]:hidden"
                  aria-label="Select account"
                >
                  <AccountAvatar account={activeAccount} />
                </SelectTrigger>
              }
            />
            <TooltipContent side="right">{activeAccount.email}</TooltipContent>
          </Tooltip>
        ) : (
          <SelectTrigger
            className={cn(
              "flex w-full items-center gap-2 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 [&>span]:line-clamp-1 [&>span]:flex [&>span]:w-full [&>span]:items-center [&>span]:gap-1 [&>span]:truncate",
              isCollapsed &&
                "h-9 w-9 shrink-0 justify-center p-0 [&>span]:w-auto [&>svg]:hidden"
            )}
            aria-label="Select account"
          >
            <SelectValue placeholder={isCollapsed ? "" : "No accounts"}>
              {activeAccount && (
                <>
                  <AccountAvatar account={activeAccount} size="sm" />
                  <span
                    className={cn("ml-2 truncate", isCollapsed && "hidden")}
                  >
                    {activeAccount.displayName ?? activeAccount.email}
                  </span>
                </>
              )}
            </SelectValue>
          </SelectTrigger>
        )}
        <SelectContent>
          <SelectGroup>
            {accounts.length === 0 ? (
              <SelectItem
                value="no-accounts"
                disabled
                className="text-muted-foreground"
              >
                No accounts
              </SelectItem>
            ) : (
              accounts.flatMap((account) => [
                <SelectItem key={account.id} value={account.id}>
                  <div className="flex w-full items-center gap-2">
                    <AccountRowIcon account={account} />
                    <span className="truncate">{account.email}</span>
                    {account.status === "auth-error" && (
                      <TriangleAlert
                        role="img"
                        aria-label="Account sign-in error"
                        className="size-3.5 shrink-0 text-destructive"
                      />
                    )}
                    {account.unreadCount > 0 && (
                      <span className="ml-auto rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
                        {account.unreadCount}
                      </span>
                    )}
                  </div>
                </SelectItem>,
                account.status === "auth-error" && (
                  <SelectItem
                    key={`reauth-${account.id}`}
                    value={`${REAUTH_ACTION_PREFIX}${account.id}`}
                    className="text-muted-foreground"
                  >
                    <div className="flex items-center gap-2">
                      <KeyRound className="size-3.5 shrink-0" aria-hidden />
                      Re-authenticate…
                    </div>
                  </SelectItem>
                ),
              ])
            )}
            <SelectItem
              value={ADD_ACCOUNT_VALUE}
              className="text-muted-foreground"
            >
              <div className="flex items-center gap-2">
                <CirclePlus className="size-3.5 shrink-0" aria-hidden />
                Add account…
              </div>
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      {/* Keyed by target: every open remounts a fresh dialog (inputs,
          errors and in-flight flags start clean without reset effects). */}
      <ReauthDialog
        key={reauthTarget?.id ?? "reauth-closed"}
        account={reauthTarget}
        open={reauthTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setReauthTarget(null)
          }
        }}
      />
    </>
  )
}
