import { useState } from "react"
import { KeyRound, Mail, Server } from "lucide-react"

import { Button } from "@/components/ui/button"
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

/**
 * Entry point of the add-account UI (tasks 5.3/5.4): the chooser between
 * the Gmail (OAuth) and the generic IMAP/SMTP flow, plus the "what do I
 * need" pointer to Google's Client-ID instructions. The individual flows
 * replace the chooser content and report back through onSuccess.
 */

/** Google's Client-ID setup instructions, linked as the footer "What do I need?". */
const GMAIL_SETUP_GUIDE_URL =
  "https://developers.google.com/gmail/api/quickstart/js"

type AddAccountMode = "choose" | "gmail" | "imap"

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const options: {
  mode: Exclude<AddAccountMode, "choose">
  title: string
  description: string
  icon: typeof Mail
}[] = [
  {
    mode: "gmail",
    title: "Gmail",
    description:
      "Sign in with your Google account in the browser. Needs a Google Client ID (free).",
    icon: Mail,
  },
  {
    mode: "imap",
    title: "Other email (IMAP/SMTP)",
    description:
      "Outlook, Yahoo, iCloud, Fastmail, GMX, Zoho or any provider — with your email address and password.",
    icon: Server,
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
                    <option.icon className="size-4 text-muted-foreground" />
                    {option.title}
                  </span>
                  <span className="text-xs font-normal text-muted-foreground">
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
