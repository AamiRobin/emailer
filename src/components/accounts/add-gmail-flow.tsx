import { useEffect, useRef, useState } from "react"
import { ArrowLeft, Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  addGmailAccount,
  cancelOauthWait,
  OauthCancelledError,
} from "@/services/account-flows"
import type { GmailFlowStep } from "@/services/account-flows"

/**
 * Add-Gmail flow UI (task 5.3): Client ID entry, then the browser consent
 * round-trip driven by addGmailAccount. Consent denial and a rejected
 * Client ID surface as retryable inline errors (accounts spec: no account
 * is created); a local cancel is quiet. Closing the dialog while the
 * consent wait is pending cancels the loopback server so nothing leaks.
 */

const STEP_LABELS: Record<GmailFlowStep, string> = {
  consent: "Waiting for you to finish in the browser…",
  exchange: "Signing you in…",
  profile: "Reading your Gmail profile…",
  save: "Saving the account…",
}

interface AddGmailFlowProps {
  onBack: () => void
  /** Called after the account row is saved; the host closes the dialog. */
  onSuccess: () => void
}

export function AddGmailFlow({ onBack, onSuccess }: AddGmailFlowProps) {
  const [clientId, setClientId] = useState("")
  const [validationError, setValidationError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [step, setStep] = useState<GmailFlowStep>("consent")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  /** Mirrors `working` for the unmount cleanup (stale-closure-free). */
  const workingRef = useRef(false)

  // Leak-free cancellation: if the dialog closes (or the flow unmounts)
  // while the loopback wait is pending, abort it. The in-flight
  // addGmailAccount promise rejects as cancelled and its handler is a
  // no-op on the unmounted component.
  useEffect(() => {
    return () => {
      if (workingRef.current) {
        void cancelOauthWait().catch(() => {
          // Nothing to cancel is fine (wait already settled).
        })
      }
    }
  }, [])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = clientId.trim()
    if (!trimmed) {
      setValidationError("Enter your Google OAuth Client ID to continue.")
      return
    }
    setValidationError(null)
    setErrorMessage(null)
    setWorking(true)
    workingRef.current = true
    try {
      await addGmailAccount({
        clientId: trimmed,
        onProgress: setStep,
      })
      onSuccess()
    } catch (error) {
      if (error instanceof OauthCancelledError) {
        // Quiet: the user backed out; stay on the Client ID step.
        return
      }
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Sign-in failed. Please try again."
      )
    } finally {
      workingRef.current = false
      setWorking(false)
    }
  }

  if (working) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Connect Gmail</DialogTitle>
          <DialogDescription>
            A Google sign-in page opened in your browser. Finish there — this
            window continues automatically.
          </DialogDescription>
        </DialogHeader>
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 py-2 text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
          {STEP_LABELS[step]}
        </div>
        <div className="flex justify-start">
          <Button
            variant="outline"
            onClick={() => {
              // Aborts the loopback wait; the orchestrator rejects as
              // cancelled and lands us back on the Client ID step.
              void cancelOauthWait().catch(() => {})
            }}
          >
            Cancel
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect Gmail</DialogTitle>
        <DialogDescription>
          Paste your own Google OAuth Client ID (type “Desktop app”). It is
          stored on this device only.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="gmail-client-id">Client ID</Label>
          <Input
            id="gmail-client-id"
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
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="gap-1"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Back
          </Button>
          <Button type="submit">Continue in browser</Button>
        </div>
      </form>
    </>
  )
}
