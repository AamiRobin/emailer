import { useState } from "react"
import { CirclePlus, KeyRound, Trash2, TriangleAlert } from "lucide-react"

import { AddAccountDialog } from "@/components/accounts/add-account-dialog"
import { ReauthDialog } from "@/components/accounts/reauth-dialog"
import { RemoveAccountDialog } from "@/components/accounts/remove-account-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { AccountInfo } from "@/stores/account-store"
import { useAccountStore } from "@/stores/account-store"

/**
 * Settings "Accounts" section (task 11.1, accounts capability): lists the
 * stored accounts (email, provider type, sign-in status, unread badge)
 * with the same management flows the account switcher hosts — Add Account
 * opens the shared chooser dialog, and each row offers Remove (confirm
 * dialog) plus Re-authenticate for accounts paused as auth-error. All
 * three dialogs are reused as-is from components/accounts; this section
 * only hosts them, exactly like the switcher does.
 */

function AccountRow({
  account,
  onRemove,
  onReauth,
}: {
  account: AccountInfo
  onRemove: (account: AccountInfo) => void
  onReauth: (account: AccountInfo) => void
}) {
  return (
    <div
      data-testid="settings-account-row"
      className="flex items-center gap-3 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {account.email}
        </p>
        <p className="text-xs text-muted-foreground">
          {account.displayName ?? "No display name"}
        </p>
      </div>
      {account.status === "auth-error" ? (
        <Badge variant="destructive">
          <TriangleAlert data-icon="inline-start" aria-hidden />
          Sign-in error
        </Badge>
      ) : (
        account.unreadCount > 0 && (
          <Badge
            variant="secondary"
            aria-label={`${account.unreadCount} unread`}
          >
            {account.unreadCount} unread
          </Badge>
        )
      )}
      <Badge variant="outline">
        {account.type === "gmail" ? "Gmail" : "IMAP"}
      </Badge>
      {account.status === "auth-error" && (
        <Button variant="ghost" size="sm" onClick={() => onReauth(account)}>
          <KeyRound />
          Re-authenticate
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={() => onRemove(account)}>
        <Trash2 />
        Remove
      </Button>
    </div>
  )
}

export function AccountsSection() {
  const accounts = useAccountStore((state) => state.accounts)
  const [addOpen, setAddOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<AccountInfo | null>(null)
  const [reauthTarget, setReauthTarget] = useState<AccountInfo | null>(null)

  return (
    <section aria-label="Accounts" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-foreground">Accounts</h2>
          <p className="text-sm text-muted-foreground">
            Accounts live on this machine; messages sync locally and work
            offline.
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <CirclePlus />
          Add Account
        </Button>
      </div>
      <Separator />
      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No accounts yet. Add one to start syncing mail.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              onRemove={setRemoveTarget}
              onReauth={setReauthTarget}
            />
          ))}
        </div>
      )}
      {/* Shared account dialogs (5.3–5.6), keyed by target like the
          switcher: every open remounts a fresh dialog instance. Keys are
          prefixed per dialog so two dialogs open on the same account never
          collide. */}
      <AddAccountDialog open={addOpen} onOpenChange={setAddOpen} />
      <ReauthDialog
        key={`reauth-${reauthTarget?.id ?? "closed"}`}
        account={reauthTarget}
        open={reauthTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReauthTarget(null)
        }}
      />
      <RemoveAccountDialog
        key={`remove-${removeTarget?.id ?? "closed"}`}
        account={removeTarget}
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null)
        }}
      />
    </section>
  )
}
