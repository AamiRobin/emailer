import { useEffect, useState } from "react"
import { formatDistanceToNow, fromUnixTime } from "date-fns"
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  AI_PROVIDER_KINDS,
  AI_SURFACE_IDS,
  AI_TIERS,
  addProvider,
  getAiSettings,
  providerRequiresApiKey,
  removeProvider,
  setActiveProvider,
  setAiEnabled,
  setOutputLanguage,
  setProviderApiKey,
  setSurfaceEnabled,
  setSurfaceTier,
  setTierModel,
  updateProvider,
  type AiProviderKind,
  type AiProviderView,
  type AiSettingsView,
  type AiSurfaceId,
  type AiTier,
} from "@/services/ai/settings"
import {
  aiCacheStats,
  clearAiCacheAll,
  type AiCacheStats,
} from "@/services/ai/cache"
import { testAiConnection } from "@/services/ai/client"
import {
  aiUsageSummary,
  clearAiUsage,
  type AiUsageSummary,
} from "@/services/ai/usage"
import {
  buildWritingStyleProfile,
  deleteStyleProfile,
  loadStyleProfile,
  type StyleProfileBuildFailure,
  type WritingStyleProfileEnvelope,
} from "@/services/ai/style-profile"
import { useAccountStore } from "@/stores/account-store"
import { getExecutor } from "@/services/db/executor"

/**
 * Settings "AI" section (task 4.2, spec ai-assistance, design D1): the
 * master enable switch, the provider list (add/edit/remove, per-provider
 * free-string model ids, connection test with a specific success/failure
 * report, active-provider radio), the per-surface toggles, the
 * result-cache management (stats + bulk clear over the 4.3 service),
 * and — parity-round-2 tasks 2.1/2.3 — the per-surface tier selectors
 * and per-tier model ids for the active provider, the output-language
 * control, and the per-surface usage summary with its clear action.
 *
 * The master switch is the spec's consent gate: with AI off, everything
 * below it disappears behind a note (nothing is configured, nothing is
 * sent). With AI on but no ACTIVE provider with a model, the mail
 * surfaces stay hidden elsewhere (settings.isAiConfigured) — this
 * section is where the user gets there: add a provider, test it, mark
 * it active.
 *
 * Key handling (design D1): the form holds the plaintext key only for
 * the moment between typing and saving; it is handed to the settings
 * service, which seals it into the credentials envelope before persist
 * (never logged, never returned by a read). Edits keep a stored key
 * unless a new one is typed; Ollama needs no key (all requests stay
 * local — spec "Ollama SHALL keep all requests on the local machine").
 *
 * Export safety: provider keys are sealed at rest and the export paths
 * (mbox/EML of mailbox content) never touch the settings table, so keys
 * are never included in exported data (spec "Keys stay local") — stated
 * in the fine print below.
 */

const KIND_LABELS: Record<AiProviderKind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  ollama: "Ollama (local)",
  custom: "Custom (OpenAI-compatible)",
}

const KIND_DEFAULT_LABELS: Record<AiProviderKind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  ollama: "Ollama",
  custom: "Custom endpoint",
}

/** Free-string model hints — the ids are never validated against a list
 * (spec: model selection is a free string, never an enum). */
const KIND_MODEL_PLACEHOLDERS: Record<AiProviderKind, string> = {
  anthropic: "e.g. claude-sonnet-4-5",
  openai: "e.g. gpt-4.1",
  gemini: "e.g. gemini-2.5-flash",
  ollama: "e.g. llama3.1",
  custom: "any model id the endpoint serves",
}

const SURFACE_COPY: Record<AiSurfaceId, { label: string; description: string }> =
  {
    summaries: {
      label: "Thread summaries",
      description: "Summarize an open thread on request.",
    },
    smartReplies: {
      label: "Smart replies",
      description: "Draft reply suggestions that match your writing style.",
    },
    composeTransform: {
      label: "Compose transforms",
      description: "Improve, shorten, or formalize selected draft text.",
    },
    askInbox: {
      label: "Ask My Inbox",
      description: "Translate natural-language questions into mailbox searches.",
    },
    taskExtraction: {
      label: "Task extraction",
      description: "Suggest tasks from open messages.",
    },
    categorizationAssist: {
      label: "Categorization assist (opt-in)",
      description:
        "Let the provider classify messages the rule engine cannot. Off by default.",
    },
    quickReplies: {
      label: "Quick replies",
      description:
        "Offer short one-tap reply chips under an open message. Nothing sends automatically.",
    },
    ruleAssist: {
      label: "Natural-language rules",
      description:
        "Translate a typed rule description into a rule preview. Only your description is sent.",
    },
    eventExtraction: {
      label: "Event extraction",
      description:
        "Suggest calendar events from open threads. Accepting one opens the event form prefilled — nothing is saved until you do.",
    },
    translation: {
      label: "Translate",
      description:
        "Translate a message into your output language on request. Only that message's text is sent.",
    },
    folderDigest: {
      label: "Catch-me-up digest",
      description:
        "Summarize the unread threads of the folder you invoke it in. Only threads from that folder are sent.",
    },
    assistant: {
      label: "AI assistant",
      description:
        "Chat with your mailbox: ask questions and the assistant looks threads up read-only to answer. Nothing is changed by it.",
    },
  }

/** Tier display names (parity-round-2 task 2.1). */
const TIER_LABELS: Record<AiTier, string> = {
  instant: "Instant",
  cheap: "Cheap",
  intelligent: "Intelligent",
}

/** Free-string hints for the per-tier model ids (never validated against
 * a list — like the provider model id, the ids are whatever the active
 * provider offers). */
const TIER_MODEL_PLACEHOLDERS: Record<AiTier, string> = {
  instant: "e.g. the provider's fastest model",
  cheap: "e.g. the provider's economy model",
  intelligent: "e.g. the provider's strongest model",
}

/** The per-row connection-test display. */
interface TestOutcome {
  ok: boolean
  text: string
}

type DialogTarget = { mode: "add" } | { mode: "edit"; provider: AiProviderView }

function isDefaultLabel(value: string): boolean {
  return AI_PROVIDER_KINDS.some(
    (candidate) => KIND_DEFAULT_LABELS[candidate] === value.trim()
  )
}

export function AiSection() {
  const [config, setConfig] = useState<AiSettingsView | null>(null)
  const [cache, setCache] = useState<AiCacheStats | null>(null)
  const [usage, setUsage] = useState<AiUsageSummary | null>(null)
  const [confirmClearCache, setConfirmClearCache] = useState(false)
  const [confirmClearUsage, setConfirmClearUsage] = useState(false)
  const [testOutcomes, setTestOutcomes] = useState<
    Record<string, TestOutcome>
  >({})
  const [testingId, setTestingId] = useState<string | null>(null)

  const [dialog, setDialog] = useState<DialogTarget | null>(null)
  const [kind, setKind] = useState<AiProviderKind>("anthropic")
  const [label, setLabel] = useState("")
  const [model, setModel] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    try {
      void Promise.all([
        getAiSettings(getExecutor()),
        aiCacheStats(getExecutor()),
        aiUsageSummary(getExecutor()),
      ])
        .then(([settings, stats, usageStats]) => {
          if (cancelled) return
          setConfig(settings)
          setCache(stats)
          setUsage(usageStats)
        })
        .catch((error) => {
          console.warn("[settings] failed to load the AI settings", error)
        })
    } catch (error) {
      console.warn("[settings] failed to load the AI settings", error)
    }
    return () => {
      cancelled = true
    }
  }, [])

  async function refresh(): Promise<void> {
    const executor = getExecutor()
    try {
      const [settings, stats, usageStats] = await Promise.all([
        getAiSettings(executor),
        aiCacheStats(executor),
        aiUsageSummary(executor),
      ])
      setConfig(settings)
      setCache(stats)
      setUsage(usageStats)
    } catch (error) {
      console.warn("[settings] failed to refresh the AI settings", error)
    }
  }

  async function changeEnabled(enabled: boolean): Promise<void> {
    const previous = config
    // Optimistic: the switch reacts immediately, rolls back on failure.
    setConfig((current) =>
      current ? { ...current, enabled } : current
    )
    try {
      await setAiEnabled(getExecutor(), enabled)
    } catch (error) {
      setConfig(previous)
      console.warn("[settings] failed to persist the AI enable flag", error)
    }
  }

  async function chooseActive(providerId: string): Promise<void> {
    const previous = config
    setConfig((current) =>
      current ? { ...current, activeProviderId: providerId } : current
    )
    try {
      await setActiveProvider(getExecutor(), providerId)
    } catch (error) {
      setConfig(previous)
      console.warn(
        "[settings] failed to persist the active AI provider",
        error
      )
    }
  }

  async function changeSurface(
    surface: AiSurfaceId,
    enabled: boolean
  ): Promise<void> {
    const previous = config
    setConfig((current) =>
      current
        ? { ...current, surfaces: { ...current.surfaces, [surface]: enabled } }
        : current
    )
    try {
      await setSurfaceEnabled(getExecutor(), surface, enabled)
    } catch (error) {
      setConfig(previous)
      console.warn("[settings] failed to persist the AI surface toggle", error)
    }
  }

  async function changeSurfaceTier(
    surface: AiSurfaceId,
    tier: AiTier
  ): Promise<void> {
    const previous = config
    setConfig((current) =>
      current
        ? {
            ...current,
            surfaceTiers: { ...current.surfaceTiers, [surface]: tier },
          }
        : current
    )
    try {
      await setSurfaceTier(getExecutor(), surface, tier)
    } catch (error) {
      setConfig(previous)
      console.warn(
        "[settings] failed to persist the AI surface tier",
        error
      )
    }
  }

  /** Persisted on blur: the whole row rewrites per edit, so per-keystroke
   * writes would be wasteful (the same reason the provider dialog saves
   * through a button — a text field is not a toggle). */
  async function changeTierModel(tier: AiTier, model: string): Promise<void> {
    const previous = config
    const trimmed = model.trim()
    setConfig((current) => {
      if (!current) return current
      const tiers = { ...current.tiers }
      if (trimmed === "") {
        delete tiers[tier]
      } else {
        tiers[tier] = trimmed
      }
      return { ...current, tiers }
    })
    try {
      await setTierModel(getExecutor(), tier, model)
    } catch (error) {
      setConfig(previous)
      console.warn("[settings] failed to persist the AI tier model", error)
    }
  }

  async function changeOutputLanguage(language: string): Promise<void> {
    const previous = config
    const trimmed = language.trim()
    setConfig((current) =>
      current ? { ...current, outputLanguage: trimmed || null } : current
    )
    try {
      await setOutputLanguage(getExecutor(), language)
    } catch (error) {
      setConfig(previous)
      console.warn(
        "[settings] failed to persist the AI output language",
        error
      )
    }
  }

  async function runTest(provider: AiProviderView): Promise<void> {
    setTestingId(provider.id)
    setTestOutcomes((current) => {
      const next = { ...current }
      delete next[provider.id]
      return next
    })
    try {
      const result = await testAiConnection(provider.id)
      setTestOutcomes((current) => ({
        ...current,
        [provider.id]: result.ok
          ? { ok: true, text: "Connection OK." }
          : { ok: false, text: result.reason },
      }))
    } catch (error) {
      // testAiConnection resolves failures into results; this is a belt-
      // and-braces guard so a row never shows a stale spinner.
      setTestOutcomes((current) => ({
        ...current,
        [provider.id]: {
          ok: false,
          text: error instanceof Error ? error.message : String(error),
        },
      }))
    } finally {
      setTestingId(null)
    }
  }

  async function removeExec(providerId: string): Promise<void> {
    try {
      await removeProvider(getExecutor(), providerId)
      await refresh()
    } catch (error) {
      console.warn("[settings] failed to remove the AI provider", error)
    }
  }

  function openAdd(): void {
    setDialog({ mode: "add" })
    setKind("anthropic")
    setLabel(KIND_DEFAULT_LABELS.anthropic)
    setModel("")
    setBaseUrl("")
    setApiKey("")
    setFormError(null)
  }

  function openEdit(provider: AiProviderView): void {
    setDialog({ mode: "edit", provider })
    setKind(provider.kind)
    setLabel(provider.label)
    setModel(provider.model)
    setBaseUrl(provider.baseUrl ?? "")
    // The stored key is never read back (hasApiKey only): an empty field
    // means "keep the saved key", typing replaces it.
    setApiKey("")
    setFormError(null)
  }

  function chooseKind(next: AiProviderKind): void {
    setKind(next)
    // Keep a name the user typed; follow the kind when it still shows a
    // default (add mode only — edit pins the kind).
    if (dialog?.mode === "add") {
      setLabel((current) =>
        current.trim() === "" || isDefaultLabel(current)
          ? KIND_DEFAULT_LABELS[next]
          : current
      )
    }
    setFormError(null)
  }

  function saveDisabled(): boolean {
    if (label.trim() === "" || model.trim() === "") return true
    if (kind === "custom" && baseUrl.trim() === "") return true
    if (
      dialog?.mode === "add" &&
      providerRequiresApiKey(kind) &&
      apiKey.trim() === ""
    ) {
      return true
    }
    return false
  }

  async function saveProvider(): Promise<void> {
    if (!dialog) return
    setFormError(null)
    setSaving(true)
    const executor = getExecutor()
    try {
      if (dialog.mode === "edit") {
        // Vendor kinds pin their official endpoints Rust-side; the base
        // URL field only carries meaning for custom (and optional Ollama).
        const usesBaseUrl = kind === "custom" || kind === "ollama"
        const updated = await updateProvider(executor, dialog.provider.id, {
          label,
          model,
          baseUrl: usesBaseUrl && baseUrl.trim() !== "" ? baseUrl : null,
        })
        if (!updated) {
          setFormError("This provider no longer exists.")
          return
        }
        if (apiKey.trim() !== "") {
          // Replace-key path: the plaintext goes straight into the
          // sealing setter — never persisted raw, never logged.
          await setProviderApiKey(executor, dialog.provider.id, apiKey)
        }
      } else {
        await addProvider(executor, {
          kind,
          label,
          model,
          ...(kind === "custom" || kind === "ollama"
            ? { baseUrl }
            : {}),
          ...(apiKey.trim() !== "" ? { apiKey } : {}),
        })
      }
      setDialog(null)
      await refresh()
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "Saving the provider failed."
      )
    } finally {
      setSaving(false)
    }
  }

  async function clearCache(): Promise<void> {
    try {
      await clearAiCacheAll(getExecutor())
      setConfirmClearCache(false)
      await refresh()
    } catch (error) {
      console.warn("[settings] failed to clear the AI cache", error)
    }
  }

  async function clearUsage(): Promise<void> {
    try {
      await clearAiUsage(getExecutor())
      setConfirmClearUsage(false)
      await refresh()
    } catch (error) {
      console.warn("[settings] failed to clear the AI usage", error)
    }
  }

  if (config === null) {
    return (
      <section aria-label="AI" className="flex flex-col gap-4">
        <SectionHeader />
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Loading…
        </p>
      </section>
    )
  }

  return (
    <section aria-label="AI" className="flex flex-col gap-4">
      <SectionHeader />
      <Separator />
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor="ai-enabled">AI assistance</Label>
          <p className="text-xs text-muted-foreground">
            Off by default. With AI off, no AI affordances appear anywhere in
            the app and nothing is ever sent to a provider.
          </p>
        </div>
        <Switch
          id="ai-enabled"
          checked={config.enabled}
          onCheckedChange={(checked) => {
            void changeEnabled(checked)
          }}
        />
      </div>

      {config.enabled ? (
        <>
          <ProvidersBlock
            config={config}
            dialog={dialog}
            kind={kind}
            label={label}
            model={model}
            baseUrl={baseUrl}
            apiKey={apiKey}
            formError={formError}
            saving={saving}
            testingId={testingId}
            testOutcomes={testOutcomes}
            saveDisabled={saveDisabled()}
            onAdd={openAdd}
            onEdit={openEdit}
            onRemove={(id) => {
              void removeExec(id)
            }}
            onTest={(provider) => {
              void runTest(provider)
            }}
            onActivate={(id) => {
              void chooseActive(id)
            }}
            onKindChange={chooseKind}
            onLabelChange={setLabel}
            onModelChange={setModel}
            onBaseUrlChange={setBaseUrl}
            onApiKeyChange={(next) => {
              setApiKey(next)
              setFormError(null)
            }}
            onDialogChange={setDialog}
            onSave={() => {
              void saveProvider()
            }}
          />

          <Separator />

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-semibold text-foreground">
              AI surfaces
            </legend>
            <p className="text-xs text-muted-foreground">
              Each surface can be turned off individually. Surfaces only send
              content you explicitly invoke them on, and only to the active
              provider.
            </p>
            {AI_SURFACE_IDS.map((surface) => (
              <div
                key={surface}
                className="flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <Label htmlFor={`ai-surface-${surface}`}>
                    {SURFACE_COPY[surface].label}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {SURFACE_COPY[surface].description}
                  </p>
                </div>
                <Switch
                  id={`ai-surface-${surface}`}
                  checked={config.surfaces[surface]}
                  onCheckedChange={(checked) => {
                    void changeSurface(surface, checked)
                  }}
                />
              </div>
            ))}
          </fieldset>

          <Separator />

          <TiersBlock
            config={config}
            onChangeSurfaceTier={(surface, tier) => {
              void changeSurfaceTier(surface, tier)
            }}
            onChangeTierModel={(tier, nextModel) => {
              void changeTierModel(tier, nextModel)
            }}
            onChangeOutputLanguage={(language) => {
              void changeOutputLanguage(language)
            }}
          />

          <Separator />

          <WritingStyleBlock />

          <Separator />

          <CacheBlock
            cache={cache}
            confirmClear={confirmClearCache}
            onConfirmClearChange={setConfirmClearCache}
            onClear={() => {
              void clearCache()
            }}
          />

          <Separator />

          <UsageBlock
            usage={usage}
            confirmClear={confirmClearUsage}
            onConfirmClearChange={setConfirmClearUsage}
            onClear={() => {
              void clearUsage()
            }}
          />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Turn AI assistance on to configure a provider, test the connection,
          and choose which surfaces may use it.
        </p>
      )}

      <Separator />
      <p className="text-xs text-muted-foreground">
        Provider API keys are encrypted at rest on this machine and are never
        included in exported data — exports contain mailbox content only.
        Ollama runs entirely locally.
      </p>
    </section>
  )
}

function SectionHeader() {
  return (
    <div>
      <h2 className="text-base font-semibold text-foreground">
        AI assistance
      </h2>
      <p className="text-sm text-muted-foreground">
        Optional AI help over your mail, powered by a provider you configure —
        including a fully local Ollama endpoint. Mail never depends on AI.
      </p>
    </div>
  )
}

interface ProvidersBlockProps {
  config: AiSettingsView
  dialog: DialogTarget | null
  kind: AiProviderKind
  label: string
  model: string
  baseUrl: string
  apiKey: string
  formError: string | null
  saving: boolean
  testingId: string | null
  testOutcomes: Record<string, TestOutcome>
  saveDisabled: boolean
  onAdd: () => void
  onEdit: (provider: AiProviderView) => void
  onRemove: (providerId: string) => void
  onTest: (provider: AiProviderView) => void
  onActivate: (providerId: string) => void
  onKindChange: (kind: AiProviderKind) => void
  onLabelChange: (label: string) => void
  onModelChange: (model: string) => void
  onBaseUrlChange: (baseUrl: string) => void
  onApiKeyChange: (apiKey: string) => void
  onDialogChange: (dialog: DialogTarget | null) => void
  onSave: () => void
}

function ProvidersBlock(props: ProvidersBlockProps) {
  const { config } = props
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Providers</h3>
          <p className="text-xs text-muted-foreground">
            Add a provider, test the connection, then mark one active. Model
            ids are free text — type whatever your provider offers.
          </p>
        </div>
        <Button size="sm" onClick={props.onAdd}>
          <Plus aria-hidden />
          Add provider
        </Button>
      </div>

      {config.providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No providers configured yet. Until one is active, no AI affordances
          appear anywhere in the app.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {config.providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              isActive={config.activeProviderId === provider.id}
              testing={props.testingId === provider.id}
              outcome={props.testOutcomes[provider.id]}
              onActivate={props.onActivate}
              onTest={props.onTest}
              onEdit={props.onEdit}
              onRemove={props.onRemove}
            />
          ))}
        </ul>
      )}

      <ProviderDialog
        dialog={props.dialog}
        kind={props.kind}
        label={props.label}
        model={props.model}
        baseUrl={props.baseUrl}
        apiKey={props.apiKey}
        formError={props.formError}
        saving={props.saving}
        saveDisabled={props.saveDisabled}
        onKindChange={props.onKindChange}
        onLabelChange={props.onLabelChange}
        onModelChange={props.onModelChange}
        onBaseUrlChange={props.onBaseUrlChange}
        onApiKeyChange={props.onApiKeyChange}
        onDialogChange={props.onDialogChange}
        onSave={props.onSave}
      />
    </div>
  )
}

interface ProviderRowProps {
  provider: AiProviderView
  isActive: boolean
  testing: boolean
  outcome: TestOutcome | undefined
  onActivate: (providerId: string) => void
  onTest: (provider: AiProviderView) => void
  onEdit: (provider: AiProviderView) => void
  onRemove: (providerId: string) => void
}

function ProviderRow(props: ProviderRowProps) {
  const { provider } = props
  return (
    <li
      data-testid="ai-provider-row"
      className="flex flex-col gap-1.5 rounded-md border p-3"
    >
      <div className="flex items-center gap-3">
        <input
          type="radio"
          name="ai-active-provider"
          value={provider.id}
          checked={props.isActive}
          onChange={() => props.onActivate(provider.id)}
          aria-label={`Use ${provider.label} for AI`}
          className="size-4 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {provider.label}
            </span>
            <Badge variant="outline">{KIND_LABELS[provider.kind]}</Badge>
            {provider.kind === "ollama" ? (
              <span className="text-xs text-muted-foreground">
                no key needed
              </span>
            ) : provider.hasApiKey ? (
              <Badge variant="secondary">key saved</Badge>
            ) : (
              <Badge variant="outline">no API key</Badge>
            )}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {provider.model === "" ? "no model set" : provider.model}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={props.testing}
            onClick={() => props.onTest(provider)}
          >
            {props.testing ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : null}
            Test connection
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit ${provider.label}`}
            onClick={() => props.onEdit(provider)}
          >
            <Pencil aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove ${provider.label}`}
            onClick={() => props.onRemove(provider.id)}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      </div>
      {props.outcome ? (
        <p
          data-testid="ai-connection-result"
          role={props.outcome.ok ? "status" : "alert"}
          className={
            props.outcome.ok
              ? "text-xs text-muted-foreground"
              : "text-xs text-destructive"
          }
        >
          {props.outcome.text}
        </p>
      ) : null}
    </li>
  )
}

interface ProviderDialogProps {
  dialog: DialogTarget | null
  kind: AiProviderKind
  label: string
  model: string
  baseUrl: string
  apiKey: string
  formError: string | null
  saving: boolean
  saveDisabled: boolean
  onKindChange: (kind: AiProviderKind) => void
  onLabelChange: (label: string) => void
  onModelChange: (model: string) => void
  onBaseUrlChange: (baseUrl: string) => void
  onApiKeyChange: (apiKey: string) => void
  onDialogChange: (dialog: DialogTarget | null) => void
  onSave: () => void
}

function ProviderDialog(props: ProviderDialogProps) {
  const open = props.dialog !== null
  const isEdit = props.dialog?.mode === "edit"
  const usesBaseUrl = props.kind === "custom" || props.kind === "ollama"
  const usesApiKey = props.kind !== "ollama"
  const kindItems = Object.fromEntries(
    AI_PROVIDER_KINDS.map((candidate) => [candidate, KIND_LABELS[candidate]])
  )
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) props.onDialogChange(null)
      }}
    >
      <DialogContent data-testid="ai-provider-dialog">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit provider" : "Add an AI provider"}
          </DialogTitle>
          <DialogDescription>
            Your key is encrypted on this machine and is sent only to the
            provider you configured, per request.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {isEdit ? (
            <p className="text-xs text-muted-foreground">
              Provider type: {KIND_LABELS[props.kind]}
            </p>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="ai-provider-kind">Provider type</Label>
              <Select
                value={props.kind}
                items={kindItems}
                onValueChange={(value) => props.onKindChange(String(value) as AiProviderKind)}
              >
                <SelectTrigger id="ai-provider-kind" className="w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AI_PROVIDER_KINDS.map((candidate) => (
                    <SelectItem key={candidate} value={candidate}>
                      {KIND_LABELS[candidate]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="ai-provider-label">Name</Label>
            <Input
              id="ai-provider-label"
              value={props.label}
              onChange={(event) => props.onLabelChange(event.target.value)}
              placeholder="Work Anthropic"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="ai-provider-model">Model id</Label>
            <Input
              id="ai-provider-model"
              value={props.model}
              onChange={(event) => props.onModelChange(event.target.value)}
              placeholder={KIND_MODEL_PLACEHOLDERS[props.kind]}
              className="font-mono"
            />
          </div>

          {usesBaseUrl ? (
            <div className="grid gap-2">
              <Label htmlFor="ai-provider-base-url">
                Base URL{props.kind === "custom" ? "" : " (optional)"}
              </Label>
              <Input
                id="ai-provider-base-url"
                value={props.baseUrl}
                onChange={(event) => props.onBaseUrlChange(event.target.value)}
                placeholder={
                  props.kind === "ollama"
                    ? "http://localhost:11434"
                    : "https://your-endpoint.example.com/v1"
                }
                className="font-mono"
              />
            </div>
          ) : null}

          {props.kind === "ollama" ? (
            <p className="text-xs text-muted-foreground">
              Ollama runs on this machine — requests never leave your computer
              and no API key is needed.
            </p>
          ) : usesApiKey ? (
            <div className="grid gap-2">
              <Label htmlFor="ai-provider-api-key">API key</Label>
              <Input
                id="ai-provider-api-key"
                type="password"
                value={props.apiKey}
                onChange={(event) => props.onApiKeyChange(event.target.value)}
                placeholder={
                  props.dialog?.mode === "edit" && props.dialog.provider.hasApiKey
                    ? "Saved — leave blank to keep the stored key"
                    : "Paste your key (stored encrypted on this machine)"
                }
                autoComplete="off"
                className="font-mono"
              />
            </div>
          ) : null}

          {props.formError ? (
            <p role="alert" className="text-xs text-destructive">
              {props.formError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => props.onDialogChange(null)}
            disabled={props.saving}
          >
            Cancel
          </Button>
          <Button onClick={props.onSave} disabled={props.saveDisabled || props.saving}>
            {props.saving ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : null}
            {isEdit ? "Save changes" : "Add provider"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface CacheBlockProps {
  cache: AiCacheStats | null
  confirmClear: boolean
  onConfirmClearChange: (confirm: boolean) => void
  onClear: () => void
}

function CacheBlock(props: CacheBlockProps) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-foreground">
        Cached AI results
      </h3>
      <p className="text-xs text-muted-foreground">
        AI results are cached on this machine, keyed by input content and
        model, and reused when the same input repeats. Removing an account
        automatically deletes the results derived from its mail.
      </p>
      {props.cache === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div data-testid="ai-cache-stats" className="flex flex-col gap-1">
          <p className="text-sm text-foreground">
            {props.cache.total} cached result
            {props.cache.total === 1 ? "" : "s"}
          </p>
          {props.cache.byKind.map((entry) => (
            <p key={entry.kind} className="text-xs text-muted-foreground">
              {entry.kind}: {entry.count}
            </p>
          ))}
        </div>
      )}
      {props.cache !== null && props.cache.total > 0 ? (
        props.confirmClear ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Clear all {props.cache.total} cached result
              {props.cache.total === 1 ? "" : "s"}?
            </span>
            <Button size="sm" variant="destructive" onClick={props.onClear}>
              Clear all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => props.onConfirmClearChange(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => props.onConfirmClearChange(true)}
            >
              Clear all
            </Button>
          </div>
        )
      ) : null}
    </div>
  )
}

/**
 * Settings → AI "Model tiers" block (parity-round-2 task 2.1, spec
 * "Per-scenario AI model routing", design D8): one tier selector per
 * surface plus the per-tier model ids for the ACTIVE provider and the
 * output-language control. One tier set applies to whichever provider is
 * active; a tier left blank falls back to that provider's default model
 * (spec "Tier fallback"), which the copy states. Tier changes persist
 * immediately (they are selections); the text fields persist on blur —
 * a per-keystroke whole-row rewrite would be wasteful.
 */
interface TiersBlockProps {
  config: AiSettingsView
  onChangeSurfaceTier: (surface: AiSurfaceId, tier: AiTier) => void
  onChangeTierModel: (tier: AiTier, model: string) => void
  onChangeOutputLanguage: (language: string) => void
}

function TiersBlock(props: TiersBlockProps) {
  const { config } = props
  const tierItems = Object.fromEntries(
    AI_TIERS.map((tier) => [tier, TIER_LABELS[tier]])
  )
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Model tiers</h3>
        <p className="text-xs text-muted-foreground">
          Each surface runs on one of three tiers. Set a model id per tier
          for the active provider; a tier left empty uses the provider's
          default model.
        </p>
      </div>

      {AI_SURFACE_IDS.map((surface) => (
        <div
          key={surface}
          className="flex items-center justify-between gap-4"
        >
          <div className="min-w-0">
            <Label htmlFor={`ai-tier-${surface}`}>
              {SURFACE_COPY[surface].label}
            </Label>
            <p className="text-xs text-muted-foreground">
              Tier: {TIER_LABELS[config.surfaceTiers[surface]]}
            </p>
          </div>
          <Select
            value={config.surfaceTiers[surface]}
            items={tierItems}
            onValueChange={(value) => {
              props.onChangeSurfaceTier(surface, String(value) as AiTier)
            }}
          >
            <SelectTrigger
              id={`ai-tier-${surface}`}
              aria-label={`Tier for ${SURFACE_COPY[surface].label}`}
              className="w-40"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AI_TIERS.map((tier) => (
                <SelectItem key={tier} value={tier}>
                  {TIER_LABELS[tier]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}

      <div className="grid gap-3 sm:grid-cols-3">
        {AI_TIERS.map((tier) => (
          <div key={tier} className="grid gap-2">
            <Label htmlFor={`ai-tier-model-${tier}`}>
              {TIER_LABELS[tier]} model id
            </Label>
            {/* Uncontrolled + blur-persist: the key re-mounts the field
            whenever the stored value changes (initial load, refresh,
            post-persist trim); typing stays in the DOM until blur. */}
            <Input
              key={`ai-tier-model-${tier}-${config.tiers[tier] ?? ""}`}
              id={`ai-tier-model-${tier}`}
              defaultValue={config.tiers[tier] ?? ""}
              onBlur={(event) =>
                props.onChangeTierModel(tier, event.target.value)
              }
              placeholder={TIER_MODEL_PLACEHOLDERS[tier]}
              className="font-mono"
            />
          </div>
        ))}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="ai-output-language">Output language</Label>
        <Input
          key={`ai-output-language-${config.outputLanguage ?? ""}`}
          id="ai-output-language"
          defaultValue={config.outputLanguage ?? ""}
          onBlur={(event) => props.onChangeOutputLanguage(event.target.value)}
          placeholder="e.g. German — leave empty to infer from the input"
        />
        <p className="text-xs text-muted-foreground">
          Generative surfaces answer in this language when set; left empty,
          the language follows the conversation.
        </p>
      </div>
    </div>
  )
}

/**
 * Settings → AI "Usage" block (parity-round-2 task 2.3, spec "Usage
 * visibility"): per-surface request counts and token totals over the
 * `ai_usage` rows, refreshed on open (the section loads the summary
 * alongside the settings). Totals that include estimated rows are
 * labeled "approx." (design risk note: estimates mislead) — a row is
 * estimated when the provider did not report tokens and the chars/4
 * estimate was recorded instead. Cache hits make no provider request and
 * are not counted. Clearing is a two-step confirm, like the cache clear.
 */
interface UsageBlockProps {
  usage: AiUsageSummary | null
  confirmClear: boolean
  onConfirmClearChange: (confirm: boolean) => void
  onClear: () => void
}

function UsageBlock(props: UsageBlockProps) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-foreground">Usage</h3>
      <p className="text-xs text-muted-foreground">
        Requests and token totals per surface, recorded on this machine.
        Cached results are reused without a request and are not counted.
      </p>
      {props.usage === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : props.usage.totalRequests === 0 ? (
        <p data-testid="ai-usage-stats" className="text-sm text-foreground">
          No usage recorded yet.
        </p>
      ) : (
        <div data-testid="ai-usage-stats" className="flex flex-col gap-1">
          {props.usage.surfaces.map((surface) => {
            const label = SURFACE_COPY[surface.surface as AiSurfaceId]?.label
            const approximate = surface.estimatedRequests > 0
            return (
              <p
                key={surface.surface}
                className="text-xs text-muted-foreground"
              >
                {label ?? surface.surface}: {surface.requests} request
                {surface.requests === 1 ? "" : "s"} ·{" "}
                {surface.promptTokens} prompt · {surface.completionTokens}{" "}
                completion · {surface.totalTokens} total tokens
                {approximate ? " (approx.)" : ""}
              </p>
            )
          })}
        </div>
      )}
      {props.usage !== null && props.usage.totalRequests > 0 ? (
        props.confirmClear ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Clear the recorded usage (
              {props.usage.totalRequests} request
              {props.usage.totalRequests === 1 ? "" : "s"})?
            </span>
            <Button size="sm" variant="destructive" onClick={props.onClear}>
              Clear usage
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => props.onConfirmClearChange(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => props.onConfirmClearChange(true)}
            >
              Clear usage
            </Button>
          </div>
        )
      ) : null}
    </div>
  )
}

/** Human copy for the profile-build failure reasons (mirrors the smart-
 * reply dialog's copy — same typed reasons, one voice). */
function buildFailureCopy(reason: StyleProfileBuildFailure): string {
  switch (reason) {
    case "not-configured":
      return "AI assistance is not configured."
    case "no-sent-mail":
      return "No recent sent messages were found to analyze."
    case "parse":
      return "The writing style could not be read from the model's reply. Try again."
    case "provider":
      return "The provider request failed."
  }
}

/**
 * Settings → AI "Writing style" block (task 4.5, ai-assistance spec
 * "Writing-style smart replies", scenario "Rebuild the profile"): the
 * profile STATUS for the active account (built when · how many sent
 * messages were analyzed / none yet) plus Rebuild and Delete.
 *
 * Consent lives in the description: it states verbatim that building
 * analyzes the account's recent sent messages with the active provider,
 * and that suggestions stay editable drafts — nothing is sent
 * automatically. A rebuild re-runs the analysis and REPORTS COMPLETION
 * inline (role=status) with the new sample size; a delete removes the
 * stored profile outright (rebuilds simply save over it, so no confirm —
 * the row is re-creatable in one click). The profile is per ACCOUNT: the
 * block scopes to the account-store's active account and says so when
 * none is active.
 */
function WritingStyleBlock() {
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  /** The loaded status, keyed by the account it was loaded FOR — the
   * render derives "Loading…" while a different account's probe is in
   * flight, so the load effect never needs a synchronous setState reset
   * (react-hooks/set-state-in-effect). */
  const [loadedFor, setLoadedFor] = useState<{
    accountId: string
    profile: WritingStyleProfileEnvelope | null
  } | null>(null)
  const [building, setBuilding] = useState(false)
  const [notice, setNotice] = useState<{
    accountId: string
    ok: boolean
    text: string
  } | null>(null)

  const statusKnown = loadedFor?.accountId === activeAccountId
  const profile = statusKnown ? (loadedFor?.profile ?? null) : null
  const accountNotice =
    notice?.accountId === activeAccountId ? notice : null

  useEffect(() => {
    if (activeAccountId === null) return
    let cancelled = false
    // The probe runs through an async IIFE so even getExecutor()'s
    // synchronous throw (plain vite) resolves through the same
    // callback-setState path — never a synchronous setState here.
    void (async () => {
      try {
        const stored = await loadStyleProfile(getExecutor(), activeAccountId)
        if (!cancelled) {
          setLoadedFor({ accountId: activeAccountId, profile: stored })
        }
      } catch {
        if (!cancelled) {
          setLoadedFor({ accountId: activeAccountId, profile: null })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeAccountId])

  async function rebuild(): Promise<void> {
    if (activeAccountId === null || building) return
    setBuilding(true)
    setNotice(null)
    try {
      const result = await buildWritingStyleProfile(
        getExecutor(),
        activeAccountId
      )
      if (result.ok) {
        // Spec scenario "Rebuild the profile": re-analyze and report
        // completion (inline status + the refreshed built-at line).
        const stored = await loadStyleProfile(getExecutor(), activeAccountId)
        setLoadedFor({ accountId: activeAccountId, profile: stored })
        setNotice({
          accountId: activeAccountId,
          ok: true,
          text: `Profile rebuilt from ${result.sampleSize} sent message${
            result.sampleSize === 1 ? "" : "s"
          }.`,
        })
      } else {
        setNotice({
          accountId: activeAccountId,
          ok: false,
          text:
            result.reason === "provider" && result.message
              ? `${buildFailureCopy(result.reason)} ${result.message}`
              : buildFailureCopy(result.reason),
        })
      }
    } catch (error) {
      console.warn("[settings] writing-style rebuild failed", error)
      setNotice({
        accountId: activeAccountId,
        ok: false,
        text: "Rebuilding the profile failed.",
      })
    } finally {
      setBuilding(false)
    }
  }

  async function remove(): Promise<void> {
    if (activeAccountId === null) return
    try {
      await deleteStyleProfile(getExecutor(), activeAccountId)
      setLoadedFor({ accountId: activeAccountId, profile: null })
      setNotice({
        accountId: activeAccountId,
        ok: true,
        text: "Writing-style profile deleted.",
      })
    } catch (error) {
      console.warn("[settings] writing-style delete failed", error)
    }
  }

  return (
    <div
      data-testid="writing-style-block"
      className="flex flex-col gap-2"
      aria-label="Writing style"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            Writing style
          </h3>
          <p className="text-xs text-muted-foreground">
            Smart replies follow your writing style. Building the profile
            analyzes your recent sent messages with the active provider —
            suggestions are always editable drafts; nothing is ever sent
            automatically.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            data-testid="writing-style-rebuild"
            disabled={building || activeAccountId === null}
            onClick={() => {
              void rebuild()
            }}
          >
            {building ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw aria-hidden />
            )}
            {statusKnown && profile ? "Rebuild" : "Build profile"}
          </Button>
          {profile ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="writing-style-delete"
              disabled={building}
              aria-label="Delete writing-style profile"
              onClick={() => {
                void remove()
              }}
            >
              <Trash2 aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>
      {activeAccountId === null ? (
        <p className="text-xs text-muted-foreground">
          No active account — the profile is built per account from its sent
          mail.
        </p>
      ) : statusKnown ? (
        <p
          data-testid="writing-style-status"
          className="text-sm text-foreground"
        >
          {profile
            ? `Built ${formatDistanceToNow(fromUnixTime(profile.builtAt), {
                addSuffix: true,
              })} · ${profile.sampleSize} sample${
                profile.sampleSize === 1 ? "" : "s"
              }`
            : "No profile yet."}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Loading…</p>
      )}
      {accountNotice !== null && (
        <p
          data-testid="writing-style-notice"
          role={accountNotice.ok ? "status" : "alert"}
          className={
            accountNotice.ok
              ? "text-xs text-muted-foreground"
              : "text-xs text-destructive"
          }
        >
          {accountNotice.text}
        </p>
      )}
    </div>
  )
}
