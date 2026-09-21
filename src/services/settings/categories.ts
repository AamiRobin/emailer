import type { SqlExecutor } from "@/services/db/executor"
import { getSetting, setSetting } from "@/services/db/settings"

/**
 * Inbox-category tab setting (task 3.5, design D4, mailbox-ui spec
 * "Category tab presentation"): one GLOBAL boolean that shows/hides the
 * category tab row (Primary/Updates/Promotions/Social/Newsletters) in the
 * mailbox tab bar. The tabs are opt-in — the spec's "hideable" row — and
 * the default is OFF, so a fresh install shows the split tabs only and
 * the inbox list itself is unaffected either way (categories are a column
 * value on threads; this flag gates only the tab UI).
 *
 * A tiny module of its own (not a preferences.ts entry) per the task 3.5
 * constraint: the same boolean pattern the preferences service uses
 * (anything but a stored JSON `true` reads as off — corrupt rows
 * included), keyed `organization.categoriesEnabled` next to the other
 * organization-facing keys. React consumers read it through
 * src/components/layout/use-categories.ts, which adds the notify seam.
 */

/** Settings-table key owned by this module. */
export const CATEGORIES_ENABLED_SETTING_KEY = "organization.categoriesEnabled"

/**
 * Whether the category tab row is shown: default off, and anything but a
 * stored JSON `true` reads as off (corrupt rows included) — failing
 * toward off keeps the tab bar as it was before task 3.5.
 */
export async function getCategoriesEnabled(
  executor: SqlExecutor
): Promise<boolean> {
  const stored = await getSetting<unknown>(
    executor,
    CATEGORIES_ENABLED_SETTING_KEY,
    false
  )
  return stored === true
}

/** Persist the category tab row's visibility. */
export async function setCategoriesEnabled(
  executor: SqlExecutor,
  enabled: boolean
): Promise<void> {
  await setSetting(executor, CATEGORIES_ENABLED_SETTING_KEY, enabled)
}
