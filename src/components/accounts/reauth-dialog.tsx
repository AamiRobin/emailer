import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getAccount } from "@/services/db/accounts"
import { getExecutor } from "@/services/db/executor"
import {
  ImapTestFailedError,
  OauthCancelledError,
  SmtpTestFailedError,
  cancelOauthWait,
  reauthGmailAccount,
  reauthImapPassword,
} from "@/services/account-flows"
import type { GmailFlowStep } from "@/services/account-flows"
import type { AccountInfo } from "@/stores/account-store"

/**
 * Re-authentication dialog (task 5.6, accounts spec "Refresh token
 * revoked" / "IMAP password changed"). Rendered for an account the
 * scheduler paused as auth-error:
 *
 * - gmail: the stored Client ID pre-filled (editable), then the same
 *   browser consent round-trip the add flow uses. Local mail data is
 *   never touched; on success the account returns to "active" and sync
 *   resumes immediately.
 * - imap: new password entry; the orchestrator re-tests BOTH connections
 *   against the stored server settings before saving anything.
 *
 * The host keys this component by target account (and remounts it on
 * every open), so its input/in-flight state always starts fresh. Closing
 * while a consent wait is pending unmounts the instance and cancels the
 * loopback server, so nothing leaks (same contract as the add flow); a
 * local cancel is a quiet no-op.
 */

const STEP_LABELS: Record<GmailFlowStep, string> = {
  consent: "Waiting for you to finish in the browser…",
  exchange: "Signing you in…",
  profile: "Reading your Gmail profile…",
  save: "Updating the account…",
}

interface ReauthDialogProps {
  account: AccountInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ReauthDialog({
  account,
  open,
  onOpenChange,
}: ReauthDialogProps) {
  const [clientId, setClientId] = useState("")
  const [password, setPassword] = useState("")
  const [validationError, setValidationError] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [step, setStep] = useState<GmailFlowStep>("consent")
  /** True only while the browser consent wait is pending. */
  const consentRef = useRef(false)

  const accountId = account?.id
  const isGmail = account?.type === "gmail"

  // Pre-fill the stored Client ID so gmail re-authentication is usually a
  // single "Continue" — best-effort: before initDatabase() (plain vite,
  // tests) getExecutor() throws and the field simply starts empty.
  useEffect(() => {
    if (!open || !accountId || !isGmail) return
    let cancelled = false
    void (async () => {
      try {
        const row = await getAccount(getExecutor(), accountId)
        if (!cancelled && row?.oauth_client_id) {
          setClientId(row.oauth_client_id)
        }
      } catch {
        // No database binding — start with an empty field.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, accountId, isGmail])

  // If the dialog closes while the consent wait is pending, abort the
  // loopback server; the pending flow rejects as cancelled and its handler
  // stays quiet.
  useEffect(() => {
    if (!open) return
    return () => {
      if (consentRef.current) {
        void cancelOauthWait().catch(() => {
          // Nothing to cancel is fine (wait already settled).
        })
      }
    }
  }, [open])

  function handleError(error: unknown, fallback: string): void {
    setErrorMessage(error instanceof Error ? error.message : fallback)
  }

  async function handleGmailSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!account) return
    const trimmed = clientId.trim()
    if (!trimmed) {
      setValidationError("Enter your Google OAuth Client ID to continue.")
      return
    }
    setValidationError(null)
    setErrorMessage(null)
    setWorking(true)
    consentRef.current = true
    try {
      await reauthGmailAccount(account.id, {
        clientId: trimmed,
        onProgress: setStep,
      })
      onOpenChange(false)
    } catch (error) {
      if (error instanceof OauthCancelledError) {
        // Quiet: the user backed out; stay on the Client ID step.
        return
      }
      handleError(error, "Sign-in failed. Please try again.")
    } finally {
      consentRef.current = false
      setWorking(false)
    }
  }

  async function handleImapSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!account) return
    if (!password) {
      setValidationError("Enter the new password (or app password).")
      return
    }
    setValidationError(null)
    setWorking(true)
    try {
      // Both connection tests run inside the orchestrator before anything
      // is saved; the typed errors say WHICH side rejected the password.
      await reauthImapPassword(account.id, password)
      onOpenChange(false)
    } catch (error) {
      if (error instanceof ImapTestFailedError) {
        setErrorMessage(`Incoming mail (IMAP): ${error.message}`)
      } else if (error instanceof SmtpTestFailedError) {
        setErrorMessage(`Outgoing mail (SMTP): ${error.message}`)
      } else {
        handleError(error, "Could not update the password.")
      }
    } finally {
      setWorking(false)
    }
  }

  return (
    <Dialog open={open && account !== null} onOpenChange={onOpenChange}>
      {account && (
        <DialogContent>
          {isGmail ? (
            working ? (
              <>
                <DialogHeader>
                  <DialogTitle>Sign in again</DialogTitle>
                  <DialogDescription>
                    A Google sign-in page opened in your browser for{" "}
                    {account.email}. Finish there — this window continues
                    automatically.
                  </DialogDescription>
                </DialogHeader>
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-3 py-2 text-sm text-muted-foreground"
                >
                  <Loader2
                    className="size-4 shrink-0 animate-spin"
                    aria-hidden
                  />
                  {STEP_LABELS[step]}
                </div>
                <div className="flex justify-start">
                  <Button
                    variant="outline"
                    onClick={() => {
                      // Aborts the loopback wait; the flow rejects as
                      // cancelled and lands back on the Client ID step.
                      void cancelOauthWait().catch(() => {})
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>Sign in again</DialogTitle>
                  <DialogDescription>
                    Google reports this account&apos;s sign-in no longer works.
                    Re-authorize {account.email} in the browser — your local
                    mail is kept.
                  </DialogDescription>
                </DialogHeader>
                <form
                  onSubmit={(event) => {
                    void handleGmailSubmit(event)
                  }}
                  className="grid gap-3"
                >
                  <div className="grid gap-1.5">
                    <Label htmlFor="reauth-gmail-client-id">Client ID</Label>
                    <Input
                      id="reauth-gmail-client-id"
                      autoFocus
                      placeholder="1234567890-abc123.apps.googleusercontent.com"
                      value={clientId}
                      onChange={(event) => {
                        setClientId(event.target.value)
                        setValidationError(null)
                      }}
                      aria-invalid={validationError ? true : undefined}
                      className={cn(
                        validationError &&
                          "border-destructive focus-visible:ring-destructive/30"
                      )}
                    />
                    {validationError && (
                      <p role="alert" className="text-xs text-destructive">
                        {validationError}
                      </p>
                    )}
                  </div>
                  {errorMessage && (
                    <p role="alert" className="text-sm text-destructive">
                      {errorMessage}
                    </p>
                  )}
                  <div className="flex items-center justify-end">
                    <Button type="submit">Continue in browser</Button>
                  </div>
                </form>
              </>
            )
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Update password</DialogTitle>
                <DialogDescription>
                  The server rejected {account.email}&apos;s password. Enter the
                  new one — both the incoming and outgoing connections are
                  tested before it is saved, and your local mail is kept.
                </DialogDescription>
              </DialogHeader>
              <form
                onSubmit={(event) => {
                  void handleImapSubmit(event)
                }}
                className="grid gap-3"
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="reauth-imap-password">New password</Label>
                  <Input
                    id="reauth-imap-password"
                    autoFocus
                    type="password"
                    autoComplete="off"
                    placeholder="Password or app password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value)
                      setValidationError(null)
                    }}
                    aria-invalid={validationError ? true : undefined}
                    className={cn(
                      validationError &&
                        "border-destructive focus-visible:ring-destructive/30"
                    )}
                  />
                  {validationError && (
                    <p role="alert" className="text-xs text-destructive">
                      {validationError}
                    </p>
                  )}
                </div>
                {errorMessage && (
                  <p role="alert" className="text-sm text-destructive">
                    {errorMessage}
                  </p>
                )}
                <div className="flex items-center justify-end">
                  <Button type="submit" disabled={working}>
                    {working && (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    )}
                    Test and save
                  </Button>
                </div>
              </form>
            </>
          )}
        </DialogContent>
      )}
    </Dialog>
  )
}
