import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { getExecutor } from "@/services/db/executor"
import {
  getMalwareLookupApiKey,
  getMalwareLookupEnabled,
  setMalwareLookupApiKeyPreference,
  setMalwareLookupEnabledPreference,
} from "@/services/settings/preferences"

/**
 * Settings "Attachment security" section (task 18.9, mail-security
 * "Opt-in attachment malware lookup", design D18): the GLOBAL opt-in for
 * the hash-lookup scan plus the user's own API key. Deliberately global
 * (unlike the per-account PGP toggle beside it): the lookup is
 * content-addressed, the verdict cache is shared across accounts, and a
 * per-account switch would only make the open-path gate inconsistent.
 *
 * The static dangerous-attachment warnings (task 18.8, D17) need no
 * setting — they are always on, which the copy below states so the
 * section explains both halves of the attachment gate.
 *
 * Persistence follows the reading/pgp-section pattern: values load once
 * from the settings table, a toggle change writes immediately (optimistic,
 * reverted on failure), and the API key commits trimmed on blur.
 */

export function AttachmentSecuritySection() {
  const [enabled, setEnabled] = useState(false)
  const [apiKey, setApiKey] = useState("")
  const [loaded, setLoaded] = useState(false)
  // Set as soon as the user edits either control: the async initial load
  // must never clobber a change with a stale DB read.
  const dirtyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    try {
      void Promise.all([
        getMalwareLookupEnabled(getExecutor()),
        getMalwareLookupApiKey(getExecutor()),
      ])
        .then(([enabledValue, key]) => {
          if (cancelled || dirtyRef.current) return
          setEnabled(enabledValue)
          setApiKey(key)
          setLoaded(true)
        })
        .catch((error) => {
          console.warn(
            "[settings] failed to load the malware-lookup settings",
            error
          )
        })
    } catch (error) {
      console.warn(
        "[settings] failed to load the malware-lookup settings",
        error
      )
    }
    return () => {
      cancelled = true
    }
  }, [])

  async function changeEnabled(next: boolean): Promise<void> {
    const previous = enabled
    dirtyRef.current = true
    setEnabled(next)
    try {
      await setMalwareLookupEnabledPreference(getExecutor(), next)
    } catch (error) {
      setEnabled(previous)
      console.warn(
        "[settings] failed to persist the malware-lookup flag",
        error
      )
    }
  }

  async function commitApiKey(): Promise<void> {
    dirtyRef.current = true
    try {
      await setMalwareLookupApiKeyPreference(getExecutor(), apiKey)
    } catch (error) {
      console.warn("[settings] failed to persist the malware-lookup key", error)
    }
  }

  return (
    <section aria-label="Attachment security" className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Attachment security
        </h2>
        <p className="text-sm text-muted-foreground">
          Known dangerous file types are always flagged and confirmed before
          they open. Optionally, attachments can also be checked against a
          malware lookup service before their first open.
        </p>
      </div>
      <div className="flex items-center justify-between gap-6 py-1">
        <div className="grid gap-0.5">
          <Label htmlFor="malware-lookup-enabled">
            Check attachments with a malware lookup
          </Label>
          <p className="text-xs text-muted-foreground">
            Before an attachment opens for the first time, its SHA-256 hash is
            looked up. Malicious files are blocked with the detection report
            (you can still override); suspicious ones warn.
          </p>
        </div>
        <Switch
          id="malware-lookup-enabled"
          checked={loaded ? enabled : false}
          onCheckedChange={(checked) => {
            void changeEnabled(checked)
          }}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="malware-lookup-api-key">VirusTotal API key</Label>
        <Input
          id="malware-lookup-api-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          onBlur={() => {
            void commitApiKey()
          }}
          placeholder="Paste your key (stored on this machine)"
          autoComplete="off"
          className="font-mono"
        />
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          {loaded ? null : (
            <Loader2
              className="mt-0.5 size-3 shrink-0 animate-spin"
              aria-hidden
            />
          )}
          Only the file&apos;s SHA-256 hash is ever sent — attachment contents
          never leave this machine. Verdicts are cached locally per hash.
          Offline, without a key, or when the service cannot be reached, the
          built-in dangerous-file warnings above apply alone.
        </p>
      </div>
      <Separator />
      <p className="text-xs text-muted-foreground">
        Executables, scripts, installers and macro-enabled Office documents are
        flagged by file type on every account, regardless of this setting.
      </p>
    </section>
  )
}
