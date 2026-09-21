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
  addMicrosoftAccount,
  cancelOauthWait,
  OauthCancelledError,
} from "@/services/account-flows"
import type { MicrosoftFlowStep } from "@/services/account-flows"
import { OAUTH_LOOPBACK_PORT } from "@/services/account-flows"

/**
 * Add-Microsoft 365 flow UI (parity-round-2 task 3.5): registration help,
 * then Client ID entry, then the browser consent round-trip driven by
 * addMicrosoftAccount.
 *
 * Emailer ships NO bundled Microsoft registration — a personal app
 * registration is REQUIRED before the flow can start (the accounts spec:
 * "clearing it restores the built-in registration when one exists" — for
 * Microsoft none exists, so clearing leaves the app unset and this flow
 * explains what to create). The help text covers the redirect URI
 * (http://localhost:<port>, public client, no secret) and the work/school
 * admin-consent caveat (an organization may require admin approval for
 * the app registration).
 *
 * Consent denial and a rejected Client ID surface as retryable inline
 * errors (no account is created); a local cancel is quiet. Closing the
 * dialog while the consent wait is pending cancels the loopback server
 * so nothing leaks (the add-gmail contract).
 */

const STEP_LABELS: Record<MicrosoftFlowStep, string> = {
  consent: "Waiting for you to finish in the browser…",
  exchange: "Signing you in…",
  profile: "Reading your Microsoft 365 profile…",
  save: "Saving the account…",
}

/** Microsoft Entra's app-registration portal, linked from the help text. */
const ENTRA_APP_REGISTRATIONS_URL =
  "https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"

interface AddMicrosoftFlowProps {
  onBack: () => void
  /** Called after the account row is saved; the host closes the dialog. */
  onSuccess: () => void
}

export function AddMicrosoftFlow({ onBack, onSuccess }: AddMicrosoftFlowProps) {
  const [clientId, setClientId] = useState("")
  const [validationError, setValidationError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [step, setStep] = useState<MicrosoftFlowStep>("consent")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  /** Mirrors `working` for the unmount cleanup (stale-closure-free). */
  const workingRef = useRef(false)

  // Leak-free cancellation: if the dialog closes (or the flow unmounts)
  // while the loopback wait is pending, abort it.
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
      setValidationError("Enter your Microsoft app registration's Client ID to continue.")
      return
    }
    setValidationError(null)
    setErrorMessage(null)
    setWorking(true)
    workingRef.current = true
    try {
      await addMicrosoftAccount({
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
          <DialogTitle>Connect Microsoft 365</DialogTitle>
          <DialogDescription>
            A Microsoft sign-in page opened in your browser. Finish there —
            this window continues automatically.
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
        <DialogTitle>Connect Microsoft 365</DialogTitle>
        <DialogDescription>
          Emailer has no built-in Microsoft app, so a one-time personal
          registration is needed. It stays on this device only.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="grid gap-3">
        <div className="grid gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          <p>
            In the{" "}
            <a
              href={ENTRA_APP_REGISTRATIONS_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Azure portal
            </a>{" "}
            register an app (type “Accounts in any organizational directory
            and personal Microsoft accounts”), then add the redirect URI
            <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono">
              http://localhost:{OAUTH_LOOPBACK_PORT}
            </code>
            as a <em>mobile and desktop</em> platform entry. No client
            secret is needed.
          </p>
          <p>
            Work or school account? Your organization may require admin
            approval for the app registration — if sign-in reports that
            admin approval is needed, ask your IT administrator to grant
            it.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="microsoft-client-id">Application (client) ID</Label>
          <Input
            id="microsoft-client-id"
            autoFocus
            placeholder="00000000-0000-0000-0000-000000000000"
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
