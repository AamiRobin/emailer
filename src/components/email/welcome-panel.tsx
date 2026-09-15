import { MailIcon, ServerIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { EmptyState } from "./empty-state"

/**
 * First-run welcome state (task 6.9, mailbox-ui spec "First launch with
 * no accounts"): shown in the list area while no account is connected.
 * Presents the Add Gmail and Add IMAP/SMTP actions; both open the shared
 * AddAccountDialog chooser (tasks 5.3/5.4) — the single host of the
 * per-provider flows, so the welcome panel stays a thin reuser of the
 * existing account components. No mailbox chrome is required to proceed.
 */
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
            <MailIcon data-icon="inline-start" />
            Add Gmail
          </Button>
          <Button variant="outline" onClick={onAddAccount}>
            <ServerIcon data-icon="inline-start" />
            Add IMAP/SMTP
          </Button>
        </>
      }
    />
  )
}
