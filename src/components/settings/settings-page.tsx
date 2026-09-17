import { useState } from "react"
import {
  Archive,
  ArrowDownUp,
  ArrowLeft,
  Ban,
  Bell,
  BookOpen,
  CalendarClock,
  Filter,
  KeyRound,
  Keyboard,
  MailWarning,
  Palette,
  ShieldAlert,
  UserRound,
  Zap,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { AccountsSection } from "@/components/settings/accounts-section"
import { AppearanceSection } from "@/components/settings/appearance-section"
import { AttachmentSecuritySection } from "@/components/settings/attachment-security-section"
import { AutoArchiveSection } from "@/components/settings/auto-archive-section"
import { BlockedSendersSection } from "@/components/settings/blocked-senders-section"
import { DataPortabilitySection } from "@/components/settings/data-portability-section"
import { DeliverySchedulesSection } from "@/components/settings/delivery-schedules-section"
import { JunkFilterSection } from "@/components/settings/junk-filter-section"
import { NotificationsSection } from "@/components/settings/notifications-section"
import { PgpSection } from "@/components/settings/pgp-section"
import { ReadingSection } from "@/components/settings/reading-section"
import { RulesSection } from "@/components/settings/rules-section"
import { ShortcutsSection } from "@/components/settings/shortcuts-section"
import { SnippetsSection } from "@/components/settings/snippets-section"
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
  | "pgp"
  | "attachment-security"
  | "junk-filter"
  | "data-portability"
  | "appearance"
  | "reading"
  | "notifications"
  | "rules"
  | "blocked-senders"
  | "delivery-schedules"
  | "auto-archive"
  | "shortcuts"
  | "snippets"

const SECTIONS: {
  id: SettingsSectionId
  label: string
  icon: LucideIcon
}[] = [
  { id: "accounts", label: "Accounts", icon: UserRound },
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
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "reading", label: "Reading", icon: BookOpen },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "rules", label: "Rules", icon: Filter },
  { id: "blocked-senders", label: "Blocked senders", icon: Ban },
  {
    id: "delivery-schedules",
    label: "Delivery schedules",
    icon: CalendarClock,
  },
  { id: "auto-archive", label: "Auto-archive", icon: Archive },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "snippets", label: "Snippets", icon: Zap },
]

/**
 * Renders the active section's content.
 */
function ActiveSection({ id }: { id: SettingsSectionId }) {
  switch (id) {
    case "accounts":
      return <AccountsSection />
    case "pgp":
      return <PgpSection />
    case "attachment-security":
      return <AttachmentSecuritySection />
    case "junk-filter":
      return <JunkFilterSection />
    case "data-portability":
      return <DataPortabilitySection />
    case "appearance":
      return <AppearanceSection />
    case "reading":
      return <ReadingSection />
    case "notifications":
      return <NotificationsSection />
    case "rules":
      return <RulesSection />
    case "blocked-senders":
      return <BlockedSendersSection />
    case "delivery-schedules":
      return <DeliverySchedulesSection />
    case "auto-archive":
      return <AutoArchiveSection />
    case "shortcuts":
      return <ShortcutsSection />
    case "snippets":
      return <SnippetsSection />
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
