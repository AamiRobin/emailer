import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { CategoryBackfillStatus } from "@/components/layout/category-backfill-status"
import {
  categorizeExistingMail,
  isBackfillActive,
  setCategoryTabsEnabled,
  useCategoriesEnabled,
  useCategoryBackfillProgress,
} from "@/components/layout/use-categories"

/**
 * Settings "Categories" section (task 3.5, design D4, mailbox-ui spec
 * "Category tab presentation" + mail-organization spec "Automatic
 * categorization"): the visibility toggle for the inbox category tab row
 * (`organization.categoriesEnabled` — the spec's hideable row; disabling
 * shows the split tabs only and leaves the inbox list untouched) and the
 * on-demand back-categorization affordance — the spec's "the user enables
 * categories and chooses to categorize existing mail" scenario, offered
 * here the moment the tabs are switched on and remaining as the re-run
 * entry. The running job reports through the same progress surface the
 * tab bar uses (CategoryBackfillStatus: "Categorizing… N of M" + Cancel,
 * the done summary as a toast).
 */
export function CategoriesSection() {
  const enabled = useCategoriesEnabled()
  const progress = useCategoryBackfillProgress()

  return (
    <section aria-label="Categories" className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Categories</h2>
        <p className="text-sm text-muted-foreground">
          Automatic inbox categories (Primary, Updates, Promotions, Social,
          Newsletters) shown as tabs above the thread list.
        </p>
      </div>
      <div className="divide-y divide-border">
        <div className="flex items-center justify-between gap-6 py-3">
          <div className="grid gap-0.5">
            <Label htmlFor="categories-enabled">Category tabs</Label>
            <p className="text-xs text-muted-foreground">
              Show the category tabs above the inbox, with unread counts per
              category. Your folders and split tabs are unaffected.
            </p>
          </div>
          <Switch
            id="categories-enabled"
            data-testid="categories-enabled-switch"
            checked={enabled}
            onCheckedChange={(checked) => {
              void setCategoryTabsEnabled(checked)
            }}
          />
        </div>
        {enabled && (
          <div className="flex flex-col gap-2 py-3">
            <div className="grid gap-0.5">
              <Label htmlFor="categorize-existing">
                Categorize existing mail
              </Label>
              <p className="text-xs text-muted-foreground">
                Classify messages already in your mailbox with the same local
                engine new mail uses. Already-categorized threads are left
                alone.
              </p>
            </div>
            <div>
              <Button
                id="categorize-existing"
                variant="outline"
                size="sm"
                data-testid="categorize-existing-button"
                disabled={isBackfillActive(progress)}
                onClick={() => void categorizeExistingMail()}
              >
                Categorize existing mail
              </Button>
            </div>
            {/* The running job's progress line — the exact surface the
                tab bar shows, so both entry points report alike. */}
            <CategoryBackfillStatus />
          </div>
        )}
      </div>
    </section>
  )
}
