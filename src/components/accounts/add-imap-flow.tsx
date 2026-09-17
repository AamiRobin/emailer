import { useState } from "react"
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  addImapAccount,
  defaultImapPort,
  defaultSmtpPort,
  discoverByEmail,
  discoverBrandByEmail,
  ImapTestFailedError,
  SmtpTestFailedError,
  testImapSettings,
  testSmtpSettings,
} from "@/services/account-flows"
import type { ImapAccountConfig } from "@/services/account-flows"
import type { SecurityKind } from "@/services/email/types"
import { ProviderIcon } from "@/components/providers/provider-icon"
import { providerBrandName } from "@/components/providers/provider-brands"

/**
 * Add-IMAP/SMTP flow UI (task 5.4): email + password first, then server
 * fields auto-filled for known providers (Outlook, Yahoo, iCloud, …) or
 * presented empty for unknown domains. Per-side connection tests with a
 * mandatory pass for BOTH sides before Connect saves anything — the
 * orchestrator re-runs the tests, so a failure can never reach the
 * database (accounts spec "Connection test fails").
 */

const SECURITY_ITEMS: Record<SecurityKind, string> = {
  tls: "SSL/TLS",
  starttls: "STARTTLS",
  none: "None",
}

const SECURITY_OPTIONS = ["tls", "starttls", "none"] as const

interface ServerForm {
  imapHost: string
  imapPort: string
  imapSecurity: SecurityKind
  smtpHost: string
  smtpPort: string
  smtpSecurity: SecurityKind
}

type Side = "imap" | "smtp"

type TestStatus = "idle" | "testing" | "passed" | "failed"

interface SideTestState {
  status: TestStatus
  message?: string
}

const IDLE_BOTH: Record<Side, SideTestState> = {
  imap: { status: "idle" },
  smtp: { status: "idle" },
}

function defaultServers(): ServerForm {
  return {
    imapHost: "",
    imapPort: String(defaultImapPort("tls")),
    imapSecurity: "tls",
    smtpHost: "",
    smtpPort: String(defaultSmtpPort("starttls")),
    smtpSecurity: "starttls",
  }
}

function toConfig(form: ServerForm): ImapAccountConfig {
  return {
    imapHost: form.imapHost.trim(),
    imapPort: Number(form.imapPort),
    imapSecurity: form.imapSecurity,
    smtpHost: form.smtpHost.trim(),
    smtpPort: Number(form.smtpPort),
    smtpSecurity: form.smtpSecurity,
  }
}

interface AddImapFlowProps {
  onBack: () => void
  /** Called after the account row is saved; the host closes the dialog. */
  onSuccess: () => void
}

export function AddImapFlow({ onBack, onSuccess }: AddImapFlowProps) {
  const [stage, setStage] = useState<"identity" | "servers">("identity")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [identityError, setIdentityError] = useState<string | null>(null)
  const [discovered, setDiscovered] = useState(false)
  const [servers, setServers] = useState<ServerForm>(defaultServers)
  const [tests, setTests] = useState<Record<Side, SideTestState>>(IDLE_BOTH)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Live brand detection while the address is typed: pure derivation from
  // the email state, feeding the identity-stage hint and the servers-stage
  // description. Cheap suffix match, safe on partial input.
  const detectedBrand = discoverBrandByEmail(email.trim())

  function handleIdentitySubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmedEmail = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setIdentityError("Enter a valid email address.")
      return
    }
    if (!password) {
      setIdentityError("Enter the account password (or app password).")
      return
    }
    setIdentityError(null)
    const settings = discoverByEmail(trimmedEmail)
    if (settings) {
      setServers({
        imapHost: settings.imapHost,
        imapPort: String(settings.imapPort),
        imapSecurity: settings.imapSecurity,
        smtpHost: settings.smtpHost,
        smtpPort: String(settings.smtpPort),
        smtpSecurity: settings.smtpSecurity,
      })
      setDiscovered(true)
    } else {
      // Unknown domain: empty manual fields per the accounts spec.
      setServers(defaultServers())
      setDiscovered(false)
    }
    setTests(IDLE_BOTH)
    setStage("servers")
  }

  function patchServer(patch: Partial<ServerForm>) {
    // Any edit invalidates this session's passing tests.
    setServers((current) => ({ ...current, ...patch }))
    setTests(IDLE_BOTH)
    setSaveError(null)
  }

  function changeSecurity(side: Side, security: SecurityKind) {
    setServers((current) => {
      // Follow the user to the conventional port while the current port
      // is still an untouched default.
      const defaults = new Set(["993", "143", "465", "587", "25"])
      const port =
        side === "imap" ? defaultImapPort(security) : defaultSmtpPort(security)
      const portKey = side === "imap" ? "imapPort" : "smtpPort"
      const securityKey = side === "imap" ? "imapSecurity" : "smtpSecurity"
      return {
        ...current,
        [securityKey]: security,
        [portKey]: defaults.has(
          current[side === "imap" ? "imapPort" : "smtpPort"]
        )
          ? String(port)
          : current[side === "imap" ? "imapPort" : "smtpPort"],
      }
    })
    setTests(IDLE_BOTH)
  }

  function validateSide(side: Side): string | null {
    const host = (side === "imap" ? servers.imapHost : servers.smtpHost).trim()
    const port = Number(side === "imap" ? servers.imapPort : servers.smtpPort)
    if (!host) return "Enter the server host."
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return "Enter a port between 1 and 65535."
    }
    return null
  }

  function markSide(side: Side, state: SideTestState) {
    setTests((current) => ({ ...current, [side]: state }))
  }

  async function runSideTest(side: Side) {
    const invalid = validateSide(side)
    if (invalid) {
      markSide(side, { status: "failed", message: invalid })
      return
    }
    markSide(side, { status: "testing" })
    const testConfig = { email: email.trim(), ...toConfig(servers) }
    try {
      if (side === "imap") {
        const result = await testImapSettings(testConfig, password)
        markSide("imap", {
          status: "passed",
          message: `Connected — ${result.folderCount} folder${
            result.folderCount === 1 ? "" : "s"
          }`,
        })
      } else {
        await testSmtpSettings(testConfig, password)
        markSide("smtp", {
          status: "passed",
          message: "Connected, sign-in accepted",
        })
      }
    } catch (error) {
      markSide(side, {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function handleConnect(event: React.FormEvent) {
    event.preventDefault()
    if (tests.imap.status !== "passed" || tests.smtp.status !== "passed") {
      // Auto-test on submit: the orchestrator tests IMAP then SMTP and
      // throws a typed error for whichever side failed first.
      setSaving(true)
      setSaveError(null)
      markSide("imap", { status: "testing" })
      markSide("smtp", { status: "testing" })
      try {
        await addImapAccount({
          email: email.trim(),
          password,
          config: toConfig(servers),
        })
        onSuccess()
      } catch (error) {
        if (error instanceof ImapTestFailedError) {
          markSide("imap", { status: "failed", message: error.message })
          markSide("smtp", { status: "idle" })
        } else if (error instanceof SmtpTestFailedError) {
          // IMAP already passed (the orchestrator tests it first).
          markSide("imap", { status: "passed" })
          markSide("smtp", { status: "failed", message: error.message })
        } else {
          setTests(IDLE_BOTH)
          setSaveError(
            error instanceof Error
              ? error.message
              : "Could not save the account."
          )
        }
      } finally {
        setSaving(false)
      }
      return
    }
    // Both sides already passed in this session — go straight to save.
    setSaving(true)
    setSaveError(null)
    try {
      await addImapAccount({
        email: email.trim(),
        password,
        config: toConfig(servers),
      })
      onSuccess()
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Could not save the account."
      )
    } finally {
      setSaving(false)
    }
  }

  if (stage === "identity") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Add an email account</DialogTitle>
          <DialogDescription>
            Your address and password stay on this device; known providers are
            filled in automatically.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleIdentitySubmit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="imap-email">Email address</Label>
            <Input
              id="imap-email"
              autoFocus
              type="email"
              autoComplete="off"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                setIdentityError(null)
              }}
            />
            {detectedBrand && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ProviderIcon provider={detectedBrand} className="size-3.5" />
                {providerBrandName(detectedBrand)} detected — server settings
                will be prefilled.
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="imap-password">Password</Label>
            <Input
              id="imap-password"
              type="password"
              autoComplete="off"
              placeholder="Password or app password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value)
                setIdentityError(null)
              }}
            />
          </div>
          {identityError && (
            <p role="alert" className="text-sm text-destructive">
              {identityError}
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
            <Button type="submit">Continue</Button>
          </div>
        </form>
      </>
    )
  }

  const bothPassed =
    tests.imap.status === "passed" && tests.smtp.status === "passed"
  const anyTesting =
    tests.imap.status === "testing" || tests.smtp.status === "testing"

  return (
    <>
      <DialogHeader>
        <DialogTitle>Server settings</DialogTitle>
        <DialogDescription>
          {discovered
            ? detectedBrand
              ? `Auto-filled from ${providerBrandName(detectedBrand)}'s known settings — edit if they differ.`
              : "Auto-filled from this provider's known settings — edit if they differ."
            : "This provider is not in the known list — enter the server details from your provider."}
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={handleConnect} className="grid gap-4">
        <ServerSection
          side="imap"
          title="Incoming mail (IMAP)"
          servers={servers}
          disabled={saving}
          test={tests.imap}
          onHostChange={(host) => patchServer({ imapHost: host })}
          onPortChange={(port) => patchServer({ imapPort: port })}
          onSecurityChange={(security) => changeSecurity("imap", security)}
          onTest={() => void runSideTest("imap")}
        />
        <ServerSection
          side="smtp"
          title="Outgoing mail (SMTP)"
          servers={servers}
          disabled={saving}
          test={tests.smtp}
          onHostChange={(host) => patchServer({ smtpHost: host })}
          onPortChange={(port) => patchServer({ smtpPort: port })}
          onSecurityChange={(security) => changeSecurity("smtp", security)}
          onTest={() => void runSideTest("smtp")}
        />
        {saveError && (
          <p role="alert" className="text-sm text-destructive">
            {saveError}
          </p>
        )}
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onBack}
            disabled={saving}
            className="gap-1"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Back
          </Button>
          <Button type="submit" disabled={!bothPassed || anyTesting || saving}>
            {saving && (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            )}
            {bothPassed ? "Save account" : "Test and save"}
          </Button>
        </div>
      </form>
    </>
  )
}

// ---------------------------------------------------------------------------
// Per-side server section
// ---------------------------------------------------------------------------

interface ServerSectionProps {
  side: Side
  title: string
  servers: ServerForm
  disabled: boolean
  test: SideTestState
  onHostChange: (host: string) => void
  onPortChange: (port: string) => void
  onSecurityChange: (security: SecurityKind) => void
  onTest: () => void
}

function ServerSection({
  side,
  title,
  servers,
  disabled,
  test,
  onHostChange,
  onPortChange,
  onSecurityChange,
  onTest,
}: ServerSectionProps) {
  const id = (suffix: string) => `${side}-${suffix}`
  const host = side === "imap" ? servers.imapHost : servers.smtpHost
  const port = side === "imap" ? servers.imapPort : servers.smtpPort
  const security = side === "imap" ? servers.imapSecurity : servers.smtpSecurity
  const sideLabel = side.toUpperCase()

  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="text-sm font-medium">{title}</legend>
      <div className="grid grid-cols-[1fr_5rem] gap-2">
        <div className="grid gap-1">
          <Label htmlFor={id("host")} className="text-xs text-muted-foreground">
            {sideLabel} server
          </Label>
          <Input
            id={id("host")}
            autoFocus={side === "imap"}
            placeholder="imap.example.com"
            value={host}
            onChange={(event) => onHostChange(event.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={id("port")} className="text-xs text-muted-foreground">
            {sideLabel} port
          </Label>
          <Input
            id={id("port")}
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(event) => onPortChange(event.target.value)}
          />
        </div>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="grid flex-1 gap-1">
          <Label
            htmlFor={id("security")}
            className="text-xs text-muted-foreground"
          >
            {sideLabel} security
          </Label>
          <Select
            items={SECURITY_ITEMS}
            value={security}
            onValueChange={(value) => {
              if (
                typeof value === "string" &&
                SECURITY_OPTIONS.includes(value as SecurityKind)
              ) {
                onSecurityChange(value as SecurityKind)
              }
            }}
          >
            <SelectTrigger id={id("security")} className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SECURITY_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {SECURITY_ITEMS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || test.status === "testing"}
          onClick={onTest}
          className="mb-0.5"
        >
          {test.status === "testing" && (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          )}
          Test
        </Button>
      </div>
      {test.status !== "idle" && test.status !== "testing" && (
        <p
          role={test.status === "failed" ? "alert" : "status"}
          className={cn(
            "text-xs",
            test.status === "failed"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          {test.status === "failed"
            ? test.message
            : (test.message ?? "Connected")}
        </p>
      )}
    </fieldset>
  )
}
