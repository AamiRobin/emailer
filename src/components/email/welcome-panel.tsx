import { MailIcon, ServerIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ProviderIcon } from "@/components/providers/provider-icon"
import { PROVIDER_BRANDS } from "@/components/providers/provider-brands"
import type { ProviderBrandId } from "@/services/account-flows"
import { EmptyState } from "./empty-state"

/**
 * First-run welcome state (task 6.9, mailbox-ui spec "First launch with
 * no accounts"): shown in the list area while no account is connected.
 * Presents the Add Gmail and Add IMAP/SMTP actions; both open the shared
 * AddAccountDialog chooser (tasks 5.3/5.4) — the single host of the
 * per-provider flows, so the welcome panel stays a thin reuser of the
 * existing account components. The brand strip below the actions shows
 * the IMAP providers with known settings (see provider-discovery), so
 * first-run users can see their provider is supported at a glance.
 */

/** Brands with auto-discovered settings, in display order. */
const SUPPORTED_BRANDS: ProviderBrandId[] = [
  "outlook",
  "yahoo",
  "icloud",
  "fastmail",
  "gmx",
  "zoho",
  "aol",
]

export function WelcomePanel({ onAddAccount }: { onAddAccount: () => void }) {
  return (
    <EmptyState
      testId="welcome-panel"
      icon={MailIcon}
      title="Welcome to emailer"
      hint="A local-first mail client: your messages stay on this machine and keep working offline. Connect an account to start syncing."
      actions={
        <>
          <Button onClick={onAddAccount}>
            <ProviderIcon
              provider="gmail"
              className="size-4"
              data-icon="inline-start"
            />
            Add Gmail
          </Button>
          <Button variant="outline" onClick={onAddAccount}>
            <ServerIcon data-icon="inline-start" />
            Add IMAP/SMTP
          </Button>
        </>
      }
      footer={
        <div className="mt-2 flex max-w-sm flex-wrap items-center justify-center gap-x-3 gap-y-1">
          {SUPPORTED_BRANDS.map((brand) => (
            <span
              key={brand}
              className="flex items-center gap-1 text-[11px] text-muted-foreground"
            >
              <ProviderIcon provider={brand} className="size-3" />
              {PROVIDER_BRANDS[brand].name}
            </span>
          ))}
        </div>
      }
    />
  )
}
