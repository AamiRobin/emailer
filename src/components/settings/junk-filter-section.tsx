import { useEffect, useRef, useState } from "react"

import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { getExecutor } from "@/services/db/executor"
import {
  getJunkFilterEnabled,
  setJunkFilterEnabledPreference,
} from "@/services/settings/preferences"
import { useActiveAccount } from "@/stores/account-store"

/**
 * Settings "Junk filter" section (task 18.10, mail-security "Local
 * adaptive junk filtering", design D19): the per-account opt-in for the
 * local naive-Bayes junk filter — IMAP accounts only (Gmail is exempt:
 * Google's server-side filtering already files that mail, and
 * double-filtering would fight its verdicts). OFF by default; the copy
 * states what enabling means (auto-move at high confidence after enough
 * training, "Not spam" always one click away, never auto-deleted) so the
 * decision is informed.
 *
 * Everything else about the feature needs no settings surface: the
 * thresholds are constants (security/junk-filter.ts), the token store
 * trains itself from the user's own mark-spam/not-spam actions, and the
 * correction affordance lives on the classified mail (mail-display's
 * junk banner).
 *
 * Persistence follows the pgp/reading-section pattern: the flag loads
 * once per account from the settings table, a toggle change writes
 * immediately (optimistic, reverted on failure), and the switch is
 * disabled (with the reason) for non-IMAP accounts rather than hidden —
 * the exemption should be visible, not a mystery.
 */
export function JunkFilterSection() {
  const account = useActiveAccount()
  const isImap = account?.type === "imap"
  /** The account the flag was last read/written for — scoping the
   * boolean to its account means an account switch renders the (correct)
   * unloaded toggle until the new account's flag resolves, instead of
   * flashing the previous account's value (the pgp-section pattern). */
  const [enabledForAccountId, setEnabledForAccountId] = useState<string | null>(
    null
  )
  // Set as soon as the user toggles: the async initial load must never
  // clobber a change with a stale DB read.
  const dirtyRef = useRef(false)
  const enabled = account !== null && enabledForAccountId === account.id

  useEffect(() => {
    if (!account) return
    dirtyRef.current = false
    let cancelled = false
    try {
      void getJunkFilterEnabled(getExecutor(), account.id)
        .then((value) => {
          if (!cancelled && !dirtyRef.current) {
            setEnabledForAccountId(value ? account.id : null)
          }
        })
        .catch(() => {})
    } catch (error) {
      console.warn("[settings] failed to load the junk-filter toggle", error)
    }
    return () => {
      cancelled = true
    }
  }, [account])

  async function changeEnabled(next: boolean): Promise<void> {
    if (!account) return
    const previous = enabledForAccountId
    dirtyRef.current = true
    setEnabledForAccountId(next ? account.id : null)
    try {
      await setJunkFilterEnabledPreference(getExecutor(), account.id, next)
    } catch (error) {
      setEnabledForAccountId(previous)
      console.warn("[settings] failed to persist the junk-filter toggle", error)
    }
  }

  return (
    <section aria-label="Junk filter" className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Junk filter</h2>
        <p className="text-sm text-muted-foreground">
          A local, per-account filter that learns from how you mark spam — no
          server, no cloud.
        </p>
      </div>
      {!account ? (
        <p className="text-sm text-muted-foreground">
          Add an account to manage its junk filtering.
        </p>
      ) : (
        <div className="flex items-center justify-between gap-6 py-1">
          <div className="grid gap-0.5">
            <Label htmlFor="junk-filter-enabled">
              Adaptively filter junk mail
            </Label>
            <p className="text-xs text-muted-foreground">
              Per account: {account.email}.{" "}
              {isImap ? (
                <>
                  Learns from your mark-spam and not-spam actions. Only mail
                  classified as junk with high confidence — after you have
                  trained it on enough spam — is moved to the Spam folder; every
                  auto-moved conversation shows a &quot;Not spam&quot; button
                  that returns it to the inbox and retrains the filter. Nothing
                  is ever deleted automatically.
                </>
              ) : (
                <>
                  Gmail accounts are filtered by Google&apos;s own spam
                  filtering and are exempt.
                </>
              )}
            </p>
          </div>
          <Switch
            id="junk-filter-enabled"
            disabled={!isImap}
            checked={isImap && enabled}
            onCheckedChange={(checked) => {
              void changeEnabled(checked)
            }}
          />
        </div>
      )}
    </section>
  )
}
