import { useState } from "react"
import { CirclePlus, KeyRound, Trash2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"

import { AddAccountDialog } from "@/components/accounts/add-account-dialog"
import { ReauthDialog } from "@/components/accounts/reauth-dialog"
import { RemoveAccountDialog } from "@/components/accounts/remove-account-dialog"
import {
  ALL_HISTORY_VALUE,
  historyWindowLabel,
} from "@/services/sync/history-window"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { ProviderIcon } from "@/components/providers/provider-icon"
import { providerBrandName } from "@/components/providers/provider-brands"
import { ProfilesEditor } from "@/components/settings/profiles-editor"
import { brandForAccount } from "@/services/account-flows"
import { getExecutor } from "@/services/db/executor"
import {
  setAccountReminderLeadMinutes,
  updateHistoryWindow,
} from "@/services/db/accounts"
import {
  enqueueHistoryBackfill,
} from "@/services/queue/operation"
import {
  HISTORY_WINDOWS,
  historyWindowBoundary,
  windowIsWider,
  type HistoryWindow,
  type HistoryWindowSetting,
} from "@/services/sync/history-window"
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
 *
 * Each row also carries the history-window pick (parity-round-3 task 3.1,
 * design D6) — the per-account FIRST-sync download boundary. Changing a
 * stored account's window persists immediately; WIDENING it additionally
 * offers the targeted backfill (task 3.3): on confirm, a
 * `history_backfill` op lands in the offline queue with the newly covered
 * range frozen, so the fetch survives restarts. Narrowing never deletes
 * anything — the boundary is download-only.
 *
 * Below the account list sits the Profiles editor (parity-round-2 task
 * 4.4, design D10): named local account groups with colors and per-account
 * overrides — a self-contained sub-section (./profiles-editor) so the
 * account rows above stay untouched.
 */

/** Select values are strings; "all" is the sentinel for the null setting. */
const WINDOW_ITEMS: Record<HistoryWindow | typeof ALL_HISTORY_VALUE, string> = {
  "1m": "1 month",
  "3m": "3 months",
  "6m": "6 months",
  "1y": "1 year",
  all: "All",
}

function settingToValue(window: HistoryWindowSetting): string {
  return window ?? ALL_HISTORY_VALUE
}

function valueToSetting(value: string): HistoryWindowSetting {
  return value === ALL_HISTORY_VALUE
    ? null
    : HISTORY_WINDOWS.includes(value as HistoryWindow)
      ? (value as HistoryWindow)
      : null
}

/** Meeting-reminder lead choices (parity-round-3 task 8.5, D5). */
const REMINDER_LEAD_ITEMS: Record<string, string> = {
  off: "Off",
  "5": "5 min before",
  "10": "10 min before",
  "15": "15 min before",
  "30": "30 min before",
}

function leadToValue(minutes: number | null | undefined): string {
  return typeof minutes === "number" && minutes > 0
    ? String(Math.floor(minutes)) in REMINDER_LEAD_ITEMS
      ? String(Math.floor(minutes))
      : "off"
    : "off"
}

/** A widening awaiting its backfill confirmation. */
interface BackfillPrompt {
  accountId: string
  accountEmail: string
  /** The row's window before the change (the narrower one). */
  previous: HistoryWindowSetting
  /** The user's wider pick. */
  next: HistoryWindowSetting
}

function AccountRow({
  account,
  onRemove,
  onReauth,
  onWindowChange,
  onLeadChange,
}: {
  account: AccountInfo
  onRemove: (account: AccountInfo) => void
  onReauth: (account: AccountInfo) => void
  onWindowChange: (
    account: AccountInfo,
    next: HistoryWindowSetting
  ) => Promise<void>
  onLeadChange: (account: AccountInfo, next: number | null) => Promise<void>
}) {
  const brand = brandForAccount(account.type, account.email)
  const [savingWindow, setSavingWindow] = useState(false)
  const [savingLead, setSavingLead] = useState(false)
  return (
    <div
      data-testid="settings-account-row"
      className="flex items-center gap-3 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ProviderIcon provider={brand} className="size-4" />
          <span className="truncate">{account.email}</span>
        </p>
        <p className="text-xs text-muted-foreground">
          {account.displayName ?? "No display name"}
        </p>
      </div>
      {/* First-sync download window (task 3.1, D6): compact per-row pick;
          the widening-backfill offer opens from the shared dialog below. */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">First sync</span>
        <Select
          items={WINDOW_ITEMS}
          value={settingToValue(account.historyWindow ?? null)}
          disabled={savingWindow}
          onValueChange={(next) => {
            if (typeof next !== "string") return
            const setting = valueToSetting(next)
            if (setting === account.historyWindow) return
            setSavingWindow(true)
            void onWindowChange(account, setting)
              .catch((error: unknown) => {
                console.warn(
                  `[accounts] history window change for ${account.id} failed`,
                  error
                )
              })
              .finally(() => setSavingWindow(false))
          }}
        >
          <SelectTrigger
            aria-label={`First sync download window for ${account.email}`}
            data-testid={`history-window-${account.id}`}
            className="w-28"
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(
              [...HISTORY_WINDOWS, ALL_HISTORY_VALUE] as (
                | HistoryWindow
                | typeof ALL_HISTORY_VALUE
              )[]
            ).map((item) => (
              <SelectItem key={item} value={item}>
                {WINDOW_ITEMS[item]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* Meeting-reminder lead (task 8.5, D5): per-account, default Off;
          the scheduler reads the row directly each pass. */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Reminders</span>
        <Select
          items={REMINDER_LEAD_ITEMS}
          value={leadToValue(account.reminderLeadMinutes)}
          disabled={savingLead}
          onValueChange={(next) => {
            if (typeof next !== "string") return
            const minutes = next === "off" ? null : Number(next)
            if (minutes === account.reminderLeadMinutes) return
            setSavingLead(true)
            void onLeadChange(account, minutes)
              .catch((error: unknown) => {
                console.warn(
                  `[accounts] reminder lead change for ${account.id} failed`,
                  error
                )
              })
              .finally(() => setSavingLead(false))
          }}
        >
          <SelectTrigger
            aria-label={`Meeting reminder lead for ${account.email}`}
            data-testid={`reminder-lead-${account.id}`}
            className="w-28"
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.keys(REMINDER_LEAD_ITEMS).map((item) => (
              <SelectItem key={item} value={item}>
                {REMINDER_LEAD_ITEMS[item]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
      {/* Brand name when the provider is known ("Outlook"), else the
          generic IMAP label. Gmail accounts always resolve to "Gmail". */}
      <Badge variant="outline">{providerBrandName(brand) ?? "IMAP"}</Badge>
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
  const [backfillPrompt, setBackfillPrompt] = useState<BackfillPrompt | null>(
    null
  )
  const [queuingBackfill, setQueuingBackfill] = useState(false)

  /**
   * Persist the row's new window, then offer the widening backfill
   * (task 3.3): the store reload makes the row show the saved value while
   * the confirm dialog is up — cancelling keeps the wider window but
   * skips the fetch (the boundary is download-only; nothing is deleted).
   */
  async function handleWindowChange(
    account: AccountInfo,
    next: HistoryWindowSetting
  ): Promise<void> {
    const executor = getExecutor()
    const previous = account.historyWindow ?? null
    await updateHistoryWindow(executor, account.id, next)
    await useAccountStore.getState().reload()
    if (windowIsWider(previous, next)) {
      setBackfillPrompt({
        accountId: account.id,
        accountEmail: account.email,
        previous,
        next,
      })
    }
  }

  /**
   * Persist the row's meeting-reminder lead (task 8.5, D5); null turns
   * reminders off. The scheduler picks the new value up on its next pass.
   */
  async function handleReminderLeadChange(
    account: AccountInfo,
    next: number | null
  ): Promise<void> {
    const executor = getExecutor()
    await setAccountReminderLeadMinutes(executor, account.id, next)
    await useAccountStore.getState().reload()
  }

  /**
   * Queue the targeted backfill with the newly covered range FROZEN
   * ([boundary(next), boundary(previous)), unix seconds). The old
   * boundary is always finite here — null (All) is the widest setting,
   * so a widening always starts from a bounded window. A null new
   * boundary (widening to All) is encoded as since 0 = the epoch, which
   * every driver reads as "down to the beginning of history".
   */
  async function handleBackfillConfirm(): Promise<void> {
    if (!backfillPrompt) return
    setQueuingBackfill(true)
    try {
      const now = Math.floor(Date.now() / 1000)
      await enqueueHistoryBackfill(getExecutor(), {
        accountId: backfillPrompt.accountId,
        since: historyWindowBoundary(backfillPrompt.next, now) ?? 0,
        until: historyWindowBoundary(backfillPrompt.previous, now),
      })
      setBackfillPrompt(null)
    } catch (error) {
      // The dialog stays open (the range choice is intact) and the user
      // learns the widening was NOT queued — a silent re-enabled button
      // would read as success.
      console.warn("[accounts] history backfill enqueue failed", error)
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not queue the download of older mail."
      )
    } finally {
      setQueuingBackfill(false)
    }
  }

  const rangeLabel = backfillPrompt
    ? `${historyWindowLabel(backfillPrompt.previous)} → ${historyWindowLabel(backfillPrompt.next)}`
    : ""

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
              onWindowChange={handleWindowChange}
              onLeadChange={handleReminderLeadChange}
            />
          ))}
        </div>
      )}
      {/* Profiles editor (parity-round-2 task 4.4): the named account
          groups with colors/overrides — self-contained sub-section. */}
      <Separator />
      <ProfilesEditor />
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
      {/* Widening backfill offer (task 3.3, D6). */}
      <Dialog
        open={backfillPrompt !== null}
        onOpenChange={(open) => {
          if (!queuingBackfill && !open) setBackfillPrompt(null)
        }}
      >
        {backfillPrompt && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Download the older mail too?</DialogTitle>
              <DialogDescription>
                The first-sync window for{" "}
                <span className="font-medium">
                  {backfillPrompt.accountEmail}
                </span>{" "}
                widened ({rangeLabel}). Messages that were skipped before can
                be fetched now — only the newly covered range is downloaded,
                online or at the next launch. Cancel to keep the wider window
                without downloading older mail.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setBackfillPrompt(null)}
                disabled={queuingBackfill}
              >
                Not now
              </Button>
              <Button
                onClick={() => {
                  void handleBackfillConfirm()
                }}
                disabled={queuingBackfill}
              >
                Download older mail
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </section>
  )
}
