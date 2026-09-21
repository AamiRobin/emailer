import { useState } from "react"
import type { ReactNode } from "react"
import { KeyRound, Server } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ProviderIcon } from "@/components/providers/provider-icon"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AddGmailFlow } from "./add-gmail-flow"
import { AddImapFlow } from "./add-imap-flow"
import { AddMicrosoftFlow } from "./add-microsoft-flow"

/**
 * Entry point of the add-account UI (tasks 5.3/5.4, parity-round-2
 * 3.5): the chooser between the Gmail (OAuth), Microsoft 365 (Graph
 * OAuth) and the generic IMAP/SMTP flow, plus the "what do I need"
 * pointer to Google's Client-ID instructions. The individual flows
 * replace the chooser content and report back through onSuccess.
 */

/** Google's Client-ID setup instructions, linked as the footer "What do I need?". */
const GMAIL_SETUP_GUIDE_URL =
  "https://developers.google.com/gmail/api/quickstart/js"

type AddAccountMode = "choose" | "gmail" | "microsoft" | "imap"

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const options: {
  mode: Exclude<AddAccountMode, "choose">
  title: string
  description: string
  icon: ReactNode
}[] = [
  {
    mode: "gmail",
    title: "Gmail",
    description:
      "Sign in with your Google account in the browser. Needs a Google Client ID (free).",
    icon: <ProviderIcon provider="gmail" className="size-4" />,
  },
  {
    mode: "microsoft",
    title: "Microsoft 365 / Outlook.com",
    description:
      "Sign in with your Microsoft account in the browser — work, school or personal (Outlook, Hotmail, Live). Needs a one-time app registration (free).",
    icon: <ProviderIcon provider="outlook" className="size-4" />,
  },
  {
    mode: "imap",
    title: "Other email (IMAP/SMTP)",
    description:
      "Yahoo, iCloud, Fastmail, GMX, Zoho or any provider — with your email address and password.",
    icon: <Server className="size-4 text-muted-foreground" />,
  },
]

export function AddAccountDialog({
  open,
  onOpenChange,
}: AddAccountDialogProps) {
  const [mode, setMode] = useState<AddAccountMode>("choose")

  // A close — user-initiated (Esc, overlay, close button) via the Dialog's
  // callback, or flow success below — resets the dialog to the chooser, so
  // every open starts fresh.
  function close(): void {
    setMode("choose")
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close()
          return
        }
        onOpenChange(true)
      }}
    >
      <DialogContent className="sm:max-w-md">
        {mode === "gmail" ? (
          <AddGmailFlow onBack={() => setMode("choose")} onSuccess={close} />
        ) : mode === "microsoft" ? (
          <AddMicrosoftFlow onBack={() => setMode("choose")} onSuccess={close} />
        ) : mode === "imap" ? (
          <AddImapFlow onBack={() => setMode("choose")} onSuccess={close} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add an account</DialogTitle>
              <DialogDescription>
                Accounts live on this machine; messages sync locally and work
                offline.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              {options.map((option) => (
                <Button
                  key={option.mode}
                  variant="outline"
                  className="h-auto w-full flex-col items-start gap-1 px-4 py-3 text-left"
                  onClick={() => setMode(option.mode)}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {option.icon}
                    {option.title}
                  </span>
                  {/* whitespace-normal: the button base style is nowrap, and
                      the long provider line's min-content width would blow
                      the grid track past the dialog's max-width */}
                  <span className="whitespace-normal text-xs font-normal text-muted-foreground">
                    {option.description}
                  </span>
                </Button>
              ))}
            </div>
            <DialogFooter className="items-center">
              <a
                href={GMAIL_SETUP_GUIDE_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                <KeyRound className="size-3" aria-hidden />
                What do I need?
              </a>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
