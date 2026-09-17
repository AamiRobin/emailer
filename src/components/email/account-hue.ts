/**
 * Derived account identity hue (task 9.2, design D4), kept out of the
 * account-badge component file so fast-refresh only sees components there.
 *
 * The accounts data model has no per-account color, so the hue is derived
 * from the account id (djb2-style hash mod 360): deterministic, so the
 * same account renders the same color in every session and everywhere it
 * appears — the unified list's row badges (account-badge.tsx) and the
 * unified header's per-account sync dots (mail-shell.tsx) agree.
 */

/** Deterministic hue (0-359) for an account id. */
export function accountHue(accountId: string): number {
  let hash = 5381
  for (let index = 0; index < accountId.length; index += 1) {
    hash = ((hash << 5) + hash + accountId.charCodeAt(index)) % 360
  }
  return hash
}
