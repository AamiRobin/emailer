import { accountHue } from "./account-hue"
import type { AccountInfo } from "@/stores/account-store"

/**
 * Per-row account identity for the unified inbox (task 9.2, design D4):
 * a tiny colored dot carrying the owning account's hue, with the account
 * address as its tooltip. Rendered ONLY in the unified scope — the
 * per-account views stay clean (every row is the active account's).
 * The hue comes from account-hue.ts (derived from the account id, shared
 * with the unified header's per-account sync dots).
 */

export function AccountBadge({ account }: { account: AccountInfo }) {
  return (
    <span
      data-account-badge={account.id}
      title={
        account.displayName
          ? `${account.displayName} · ${account.email}`
          : account.email
      }
      aria-label={`Account ${account.email}`}
      className="size-2 shrink-0 rounded-full"
      // Data-derived color exception (mirrors the label chips): the hue is
      // identity content derived from the account row, not component
      // styling, so the token rule does not apply.
      style={{ backgroundColor: `hsl(${accountHue(account.id)} 55% 50%)` }}
    />
  )
}
