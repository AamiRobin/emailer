import { useState } from "react"
import {
  Archive,
  ArrowDownUp,
  ArrowLeft,
  Ban,
  Bell,
  BookOpen,
  Calendar,
  CalendarClock,
  CircleHelp,
  Database,
  Filter,
  KeyRound,
  Keyboard,
  ListChecks,
  MailWarning,
  MailX,
  Monitor,
  Palette,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Tags,
  Users,
  UserRound,
  Zap,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { AccountsSection } from "@/components/settings/accounts-section"
import { AddressBookSection } from "@/components/settings/address-book-section"
import { AiSection } from "@/components/settings/ai-section"
import { AppearanceSection } from "@/components/settings/appearance-section"
import { AttachmentSecuritySection } from "@/components/settings/attachment-security-section"
import { AutoArchiveSection } from "@/components/settings/auto-archive-section"
import { CalendarSection } from "@/components/settings/calendar-section"
import { BlockedSendersSection } from "@/components/settings/blocked-senders-section"
import { CategoriesSection } from "@/components/settings/categories-section"
import { DataPortabilitySection } from "@/components/settings/data-portability-section"
import { DesktopSection } from "@/components/settings/desktop-section"
import { DeliverySchedulesSection } from "@/components/settings/delivery-schedules-section"
import { HelpSection } from "@/components/help/help-center"
import { JunkFilterSection } from "@/components/settings/junk-filter-section"
import { NotificationsSection } from "@/components/settings/notifications-section"
import { PgpSection } from "@/components/settings/pgp-section"
import { QuickStepsSection } from "@/components/settings/quick-steps-section"
import { ReadingSection } from "@/components/settings/reading-section"
import { RulesSection } from "@/components/settings/rules-section"
import { ShortcutsSection } from "@/components/settings/shortcuts-section"
import { SnippetsSection } from "@/components/settings/snippets-section"
import { StorageSection } from "@/components/settings/storage-section"
import { SubscriptionsSection } from "@/components/settings/subscriptions-section"
import { UpdatesSection } from "@/components/settings/updates-section"
import { useUiStore } from "@/stores/ui-store"

/**
 * The settings page (task 11.1). Replaces the mailbox panes while
 * ui-store.view.kind === "settings" (the shell swaps it in); the sidebar
 * Settings entry navigates here. The back control restores the mailbox
 * view the user came from via the store's previousView mechanism — the
 * same restore path clearSearch uses (ui-store never records settings
 * views as previousView, so back always lands on real mailbox state,
 * defaulting to the inbox).
 *
 * Section selection is internal state on purpose: ui-store only carries
 * the coarse view kind (design D5), and the mailbox-ui spec does not
 * deep-link individual settings sections.
 */

type SettingsSectionId =
  | "accounts"
  | "address-book"
  | "calendar"
  | "pgp"
  | "attachment-security"
  | "junk-filter"
  | "data-portability"
  | "storage"
  | "updates"
  | "desktop"
  | "appearance"
  | "reading"
  | "ai"
  | "notifications"
  | "rules"
  | "categories"
  | "quick-steps"
  | "blocked-senders"
  | "subscriptions"
  | "delivery-schedules"
  | "auto-archive"
  | "shortcuts"
  | "snippets"
  | "help"

const SECTIONS: {
  id: SettingsSectionId
  label: string
  icon: LucideIcon
}[] = [
  { id: "accounts", label: "Accounts", icon: UserRound },
  // CardDAV address-book sync (parity-round-2 task 4.3, spec contacts):
  // connect/disconnect, sync status, sealed-password note.
  { id: "address-book", label: "Address book", icon: Users },
  // Calendar sources (task 5.2, spec calendar): Google/CalDAV connect,
  // discovery and removal.
  { id: "calendar", label: "Calendar", icon: Calendar },
  { id: "pgp", label: "Encryption", icon: KeyRound },
  {
    id: "attachment-security",
    label: "Attachment security",
    icon: ShieldAlert,
  },
  { id: "junk-filter", label: "Junk filter", icon: MailWarning },
  {
    id: "data-portability",
    label: "Import & export",
    icon: ArrowDownUp,
  },
  // Storage usage + delete-all-local-data (tasks 1.6/1.7, settings spec).
  { id: "storage", label: "Storage", icon: Database },
  { id: "updates", label: "Updates", icon: RefreshCw },
  { id: "desktop", label: "Desktop", icon: Monitor },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "reading", label: "Reading", icon: BookOpen },
  // AI assistance (task 4.2, spec ai-assistance): provider configuration,
  // per-surface toggles and cache management.
  { id: "ai", label: "AI", icon: Sparkles },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "rules", label: "Rules", icon: Filter },
  // Category tabs (task 3.5): the inbox category tab row's visibility +
  // the on-demand back-categorization launch.
  { id: "categories", label: "Categories", icon: Tags },
  // Quick steps (task 3.2): the manage UI for the 3.1 service — chains of
  // actions runnable from the context menu, the palette, or a digit key.
  { id: "quick-steps", label: "Quick steps", icon: ListChecks },
  { id: "blocked-senders", label: "Blocked senders", icon: Ban },
  // Subscription manager (task 3.6): detected newsletter senders +
  // unsubscribed senders, with bulk unsubscribe.
  { id: "subscriptions", label: "Subscriptions", icon: MailX },
  {
    id: "delivery-schedules",
    label: "Delivery schedules",
    icon: CalendarClock,
  },
  { id: "auto-archive", label: "Auto-archive", icon: Archive },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "snippets", label: "Snippets", icon: Zap },
  // Help center (task 2.9): the settings-page entry point; the palette's
  // "Open help center" command opens the same center as a dialog.
  { id: "help", label: "Help", icon: CircleHelp },
]

/**
 * Renders the active section's content.
 */
function ActiveSection({ id }: { id: SettingsSectionId }) {
  switch (id) {
    case "accounts":
      return <AccountsSection />
    case "address-book":
      return <AddressBookSection />
    case "calendar":
      return <CalendarSection />
    case "pgp":
      return <PgpSection />
    case "attachment-security":
      return <AttachmentSecuritySection />
    case "junk-filter":
      return <JunkFilterSection />
    case "data-portability":
      return <DataPortabilitySection />
    case "storage":
      return <StorageSection />
    case "updates":
      return <UpdatesSection />
    case "desktop":
      return <DesktopSection />
    case "appearance":
      return <AppearanceSection />
    case "reading":
      return <ReadingSection />
    case "ai":
      return <AiSection />
    case "notifications":
      return <NotificationsSection />
    case "rules":
      return <RulesSection />
    case "categories":
      return <CategoriesSection />
    case "quick-steps":
      return <QuickStepsSection />
    case "blocked-senders":
      return <BlockedSendersSection />
    case "subscriptions":
      return <SubscriptionsSection />
    case "delivery-schedules":
      return <DeliverySchedulesSection />
    case "auto-archive":
      return <AutoArchiveSection />
    case "shortcuts":
      return <ShortcutsSection />
    case "snippets":
      return <SnippetsSection />
    case "help":
      return <HelpSection />
  }
}

export function SettingsPage() {
  const [section, setSection] = useState<SettingsSectionId>("accounts")
  const setView = useUiStore((state) => state.setView)
  const previousView = useUiStore((state) => state.previousView)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-4 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Back to mailbox"
          onClick={() => setView(previousView)}
        >
          <ArrowLeft />
          Back
        </Button>
        <h1 className="truncate text-xl font-bold text-foreground">Settings</h1>
      </div>
      <Separator />
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="grid w-44 shrink-0 content-start gap-0.5 p-2"
        >
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "true" : undefined}
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "w-full justify-start",
                section === id && "bg-muted text-foreground"
              )}
              onClick={() => setSection(id)}
            >
              <Icon />
              {label}
            </button>
          ))}
        </nav>
        <Separator orientation="vertical" />
        <ScrollArea className="min-w-0 flex-1">
          <div className="mx-auto max-w-2xl p-6">
            <ActiveSection id={section} />
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
