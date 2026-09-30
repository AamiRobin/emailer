import { decryptCredentials, encryptCredentials } from "@/services/crypto/credentials"
import type { SqlExecutor } from "@/services/db/executor"
import { getSetting, setSetting } from "@/services/db/settings"

/**
 * AI provider configuration store (task 4.2, design D1) — the settings
 * half of the AI phase. One JSON row in the settings table under
 * `ai.config` (the same single-row pattern as `mail.splits`,
 * `mail.threadSorts`, `mail.shortcutOverrides`): the master enable flag,
 * the active provider id, the provider list, the per-surface toggles,
 * and — additively since parity-round-2 task 2.1 — the per-tier model
 * ids (`tiers`), the surface → tier assignments (`surface_tiers`) and
 * the generative output language (`output_language`).
 *
 * Key handling (design D1, spec "Keys stay local"): a provider's API key
 * is accepted as PLAINTEXT only through `setProviderApiKey` (and
 * `addProvider`), sealed immediately with the existing AES-256-GCM
 * credentials envelope (the same at-rest treatment as OAuth refresh
 * tokens and the malware-lookup key), and stored in the row as
 * `apiKeySealed`. The sealed string and the plaintext key are NEVER
 * returned by any read API — every public read exposes only
 * `hasApiKey: boolean` — and key material is never logged anywhere in
 * this module. The ONLY consumer of the sealed value is `resolveApiKey`,
 * exported for `client.ts` (transport) alone.
 *
 * Export safety (spec "Keys stay local"): the data-portability module
 * exports mailbox content only (RFC 822 rebuilt from message rows) — it
 * never reads the settings table, so this row (sealed keys included) is
 * structurally excluded from every export path.
 *
 * Defaults and corruption tolerance: AI is OFF by default (spec "AI
 * consent and data boundaries") — an absent row, a corrupt row, or a row
 * of the wrong shape all read as disabled with no providers, so every
 * failure fails toward the privacy default. Individual provider entries
 * that fail validation are dropped on read (the splits pattern); surface
 * flags that are missing or not booleans fall back to that surface's
 * default (every surface ON — the toggles exist to disable — except
 * categorization assist, which the spec and task 4.9 keep opt-in). The
 * tier additions fail the same direction: malformed `tiers`/`surface_tiers`
 * entries drop and missing surfaces keep their default tier
 * (DEFAULT_SURFACE_TIERS), and a malformed `output_language` reads as
 * unset (null).
 */

/** The one settings-table row owned by this module. */
export const AI_SETTING_KEY = "ai.config"

/** The provider kinds the `ai_chat` Rust command routes (task 4.1). */
export type AiProviderKind =
  | "anthropic"
  | "openai"
  | "gemini"
  | "ollama"
  | "custom"

export const AI_PROVIDER_KINDS: readonly AiProviderKind[] = [
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "custom",
]

export function isAiProviderKind(value: unknown): value is AiProviderKind {
  return AI_PROVIDER_KINDS.some((kind) => kind === value)
}

/** Kinds whose endpoint requires an API key (Ollama is keyless-local,
 * custom endpoints may or may not need one — their call decides). */
const KEY_REQUIRED_KINDS: readonly AiProviderKind[] = [
  "anthropic",
  "openai",
  "gemini",
]

/**
 * The AI surfaces (spec "AI consent and data boundaries"); ids are the
 * config keys, each individually disableable. `quickReplies` (parity-round-2
 * task 2.4) and `ruleAssist` (task 2.5) are additive members of the same
 * vocabulary — every gate, toggle, tier assignment and usage row treats
 * them like the originals.
 */
export type AiSurfaceId =
  | "summaries"
  | "smartReplies"
  | "composeTransform"
  | "askInbox"
  | "taskExtraction"
  | "categorizationAssist"
  | "quickReplies"
  | "ruleAssist"
  | "eventExtraction"
  | "translation"
  | "folderDigest"

export const AI_SURFACE_IDS: readonly AiSurfaceId[] = [
  "summaries",
  "smartReplies",
  "composeTransform",
  "askInbox",
  "taskExtraction",
  "categorizationAssist",
  "quickReplies",
  "ruleAssist",
  "eventExtraction",
  "translation",
  "folderDigest",
]

export function isAiSurfaceId(value: unknown): value is AiSurfaceId {
  return AI_SURFACE_IDS.some((surface) => surface === value)
}

export type AiSurfacesConfig = Record<AiSurfaceId, boolean>

/**
 * Surface defaults when AI is enabled: every surface ON (the toggles are
 * for disabling — spec "Disable a single surface") except categorization
 * assist, which is explicitly opt-in (spec "Categorization assist":
 * "the user MAY enable"; task 4.9 wires the same default).
 */
export const DEFAULT_SURFACES: AiSurfacesConfig = {
  summaries: true,
  smartReplies: true,
  composeTransform: true,
  askInbox: true,
  taskExtraction: true,
  categorizationAssist: false,
  quickReplies: true,
  ruleAssist: true,
  eventExtraction: true,
  translation: true,
  folderDigest: true,
}

// ---------------------------------------------------------------------------
// Model tiers (parity-round-2 task 2.1, spec "Per-scenario AI model routing")
// ---------------------------------------------------------------------------

/**
 * The three model tiers a surface can route through. Tiers name SPEED and
 * COST classes, never a concrete model — the model id per tier is a free
 * string configured for the ACTIVE provider (one tier set applies to
 * whichever provider is active; switching providers keeps the tier
 * assignments but the ids are re-interpreted, like the free-string model
 * ids themselves).
 */
export type AiTier = "instant" | "cheap" | "intelligent"

export const AI_TIERS: readonly AiTier[] = [
  "instant",
  "cheap",
  "intelligent",
]

export function isAiTier(value: unknown): value is AiTier {
  return AI_TIERS.some((tier) => tier === value)
}

/** Tier → model id (free string, stored plainly — a model id is not a
 * secret; only API keys get the sealed treatment). A missing or blank
 * entry means "no model for this tier": surfaces on it use the active
 * provider's default model (spec "Tier fallback"). */
export type AiTierModels = Partial<Record<AiTier, string>>

/** Stored surface → tier assignment (partial: absent surfaces keep their
 * default below). */
export type AiSurfaceTiersConfig = Partial<Record<AiSurfaceId, AiTier>>

/**
 * Default tier per surface, applied when `surface_tiers` has no (valid)
 * entry for it. The mapping follows the reference's shape — latency-
 * sensitive per-message work on the fastest tier, routine generation on
 * the cheap tier, quality-critical writing/reasoning on the intelligent
 * tier:
 *
 * - `categorizationAssist` → instant: fires per incoming message at sync
 *   time (30/min budget); latency-sensitive like the reference's
 *   command/quick-reply scenarios, which it hardwires to the fast tier.
 * - `summaries`, `smartReplies`, `taskExtraction` → cheap: routine bulk
 *   generation where cost matters more than peak quality.
 * - `composeTransform`, `askInbox` → intelligent: user-visible writing
 *   and mailbox reasoning, where quality is the point.
 * - `quickReplies` → instant (task 2.4): one-tap chips are the reference's
 *   canonical latency surface (its Scenario::QuickReply hardwires
 *   "instant") — a slow chip is a chip nobody taps.
 * - `ruleAssist` → cheap (task 2.5): on-demand translation of one typed
 *   description into the rule schema; routine generation, no latency
 *   pressure.
 * - `eventExtraction`, `translation`, `folderDigest` → cheap (add-ai-
 *   surfaces): all three are explicitly user-initiated with short outputs
 *   — routine generation, no latency pressure beyond the click.
 *
 * A plain Record over AiSurfaceId: adding a surface later is one entry
 * here (plus one in AI_SURFACE_IDS) and everything else keeps working.
 */
export const DEFAULT_SURFACE_TIERS: Record<AiSurfaceId, AiTier> = {
  summaries: "cheap",
  smartReplies: "cheap",
  composeTransform: "intelligent",
  askInbox: "intelligent",
  taskExtraction: "cheap",
  categorizationAssist: "instant",
  quickReplies: "instant",
  ruleAssist: "cheap",
  eventExtraction: "cheap",
  translation: "cheap",
  folderDigest: "cheap",
}

/** One stored provider. `apiKeySealed` is the credentials envelope of
 * the user's key — write-through only, never surfaced by reads. */
export interface AiProviderConfig {
  id: string
  kind: AiProviderKind
  label: string
  /** The model id as a free string — never an enum (spec: the user picks
   * from the provider's offered models, which outgrow any fixed list). */
  model: string
  /** Endpoint override: required in practice for `custom`, optional for
   * `ollama` (default http://localhost:11434); ignored by the vendor kinds. */
  baseUrl?: string
  /** Sealed API key (credentials envelope). Never logged, never returned
   * by a read API; unsealed only inside `resolveApiKey` (client.ts). */
  apiKeySealed?: string
  /** A disabled provider stays configured but is never eligible as the
   * active provider (fail toward off). No UI toggles it yet (task 4.2
   * ships removal instead); the runtime honors it regardless. */
  disabled?: boolean
}

/** The stored row shape (internal — carries the sealed key). */
interface AiConfig {
  enabled: boolean
  activeProviderId: string | null
  providers: AiProviderConfig[]
  surfaces: AiSurfacesConfig
  /** Per-tier model ids for the active provider (validated, blank-free). */
  tiers: AiTierModels
  /** Stored surface → tier assignments (partial; defaults merged on read). */
  surfaceTiers: AiSurfaceTiersConfig
  /** Output language for generative surfaces (task 2.6 applies it to the
   * prompts); null = unset — the model infers from the input. */
  outputLanguage: string | null
}

/** The disabled default every absent/corrupt row reads as. */
const DEFAULT_CONFIG: AiConfig = {
  enabled: false,
  activeProviderId: null,
  providers: [],
  surfaces: { ...DEFAULT_SURFACES },
  tiers: {},
  surfaceTiers: {},
  outputLanguage: null,
}

/** A provider as the UI and list readers see it: key material reduced to
 * `hasApiKey` (design D1: keys never enter reads). */
export interface AiProviderView {
  id: string
  kind: AiProviderKind
  label: string
  model: string
  baseUrl: string | null
  /** Whether a (sealed) key is stored — never the key itself. */
  hasApiKey: boolean
  disabled: boolean
}

/** The configuration as every public reader sees it (no key material). */
export interface AiSettingsView {
  enabled: boolean
  activeProviderId: string | null
  providers: AiProviderView[]
  surfaces: AiSurfacesConfig
  /** Per-tier model ids for the active provider (blank-free; a missing
   * tier means the provider's default model serves that tier). */
  tiers: AiTierModels
  /** Resolved surface → tier (stored assignments merged over the
   * defaults), so readers never re-implement the fallback. */
  surfaceTiers: Record<AiSurfaceId, AiTier>
  /** Output language for generative surfaces, or null when unset. */
  outputLanguage: string | null
}

/** The runtime half of one active provider, as `client.ts` needs it. */
export interface AiRuntimeConfig {
  /** The provider's config id (for `resolveApiKey`). */
  id: string
  /** The provider kind — the `ai_chat` `provider` argument. */
  provider: AiProviderKind
  model: string
  baseUrl?: string
}

// ---------------------------------------------------------------------------
// Validation (corrupt rows fail toward off, invalid entries drop)
// ---------------------------------------------------------------------------

function isProviderConfig(value: unknown): value is AiProviderConfig {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === "string" &&
    entry.id.trim() !== "" &&
    isAiProviderKind(entry.kind) &&
    typeof entry.label === "string" &&
    entry.label.trim() !== "" &&
    typeof entry.model === "string" &&
    (entry.baseUrl === undefined ||
      entry.baseUrl === null ||
      typeof entry.baseUrl === "string") &&
    // The sealed slot must be a string when present — a blank/garbage
    // string reads as "no key" (coerced below), never as an error.
    (entry.apiKeySealed === undefined ||
      entry.apiKeySealed === null ||
      typeof entry.apiKeySealed === "string") &&
    (entry.disabled === undefined || typeof entry.disabled === "boolean")
  )
}

function toProviderConfig(value: unknown): AiProviderConfig | null {
  if (!isProviderConfig(value)) return null
  const entry = value as AiProviderConfig
  const provider: AiProviderConfig = {
    ...entry,
    model: entry.model.trim(),
    ...(entry.baseUrl !== undefined && entry.baseUrl !== null
      ? { baseUrl: entry.baseUrl.trim() }
      : {}),
  }
  // A blank sealed slot degrades to "no key" instead of poisoning the
  // decrypt path (a hand-edited row must not lose the provider).
  if (
    typeof provider.apiKeySealed === "string" &&
    provider.apiKeySealed.trim() === ""
  ) {
    delete provider.apiKeySealed
  }
  return provider
}

/** Validated surfaces: missing or non-boolean flags fall back to that
 * surface's default (all ON except categorization assist). */
function toSurfaces(value: unknown): AiSurfacesConfig {
  const surfaces = { ...DEFAULT_SURFACES }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return surfaces
  }
  const stored = value as Record<string, unknown>
  for (const id of AI_SURFACE_IDS) {
    if (typeof stored[id] === "boolean") surfaces[id] = stored[id] as boolean
  }
  return surfaces
}

/** Validated tier → model map: only known tiers with a non-blank string
 * survive; a blank id reads as "no model for this tier" (the tier
 * fallback), so it is dropped rather than stored. */
function toTierModels(value: unknown): AiTierModels {
  const tiers: AiTierModels = {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return tiers
  }
  const stored = value as Record<string, unknown>
  for (const tier of AI_TIERS) {
    const model = stored[tier]
    if (typeof model === "string" && model.trim() !== "") {
      tiers[tier] = model.trim()
    }
  }
  return tiers
}

/** Validated surface → tier assignments: only known (surface, tier) pairs
 * survive; everything else falls back to DEFAULT_SURFACE_TIERS on read. */
function toSurfaceTiers(value: unknown): AiSurfaceTiersConfig {
  const surfaceTiers: AiSurfaceTiersConfig = {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return surfaceTiers
  }
  const stored = value as Record<string, unknown>
  for (const surface of AI_SURFACE_IDS) {
    const tier = stored[surface]
    if (isAiTier(tier)) surfaceTiers[surface] = tier
  }
  return surfaceTiers
}

/** The output language: a non-blank string, else null (unset — the model
 * infers the language from the input). */
function toOutputLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

/** Decode the stored row, tolerating every corrupt shape: a non-object,
 * an unparseable row (getSetting's default), a non-array provider list —
 * all read as the disabled default; invalid provider entries drop. The
 * tier additions (task 2.1) fail the same way: a malformed `tiers`,
 * `surface_tiers` or `output_language` reads as the defaults. */
function decodeConfig(stored: unknown): AiConfig {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return { ...DEFAULT_CONFIG, surfaces: { ...DEFAULT_SURFACES } }
  }
  const row = stored as Record<string, unknown>
  const providers = (
    Array.isArray(row.providers) ? row.providers : []
  ).flatMap((entry) => {
    const provider = toProviderConfig(entry)
    return provider ? [provider] : []
  })
  return {
    enabled: row.enabled === true,
    activeProviderId:
      typeof row.activeProviderId === "string" ? row.activeProviderId : null,
    providers,
    surfaces: toSurfaces(row.surfaces),
    tiers: toTierModels(row.tiers),
    surfaceTiers: toSurfaceTiers(row.surface_tiers),
    outputLanguage: toOutputLanguage(row.output_language),
  }
}

/** The public view of one provider — strips the sealed key slot. */
function toProviderView(provider: AiProviderConfig): AiProviderView {
  return {
    id: provider.id,
    kind: provider.kind,
    label: provider.label,
    model: provider.model,
    baseUrl: provider.baseUrl ?? null,
    hasApiKey:
      typeof provider.apiKeySealed === "string" &&
      provider.apiKeySealed.trim() !== "",
    disabled: provider.disabled === true,
  }
}

function toView(config: AiConfig): AiSettingsView {
  return {
    enabled: config.enabled,
    activeProviderId: config.activeProviderId,
    providers: config.providers.map(toProviderView),
    surfaces: { ...config.surfaces },
    tiers: { ...config.tiers },
    surfaceTiers: { ...DEFAULT_SURFACE_TIERS, ...config.surfaceTiers },
    outputLanguage: config.outputLanguage,
  }
}

// ---------------------------------------------------------------------------
// Row access (internal)
// ---------------------------------------------------------------------------

/** Read + validate the stored row. Internal: the result carries sealed
 * key strings and must never escape this module except through
 * `resolveApiKey`'s controlled decrypt. */
async function loadConfig(executor: SqlExecutor): Promise<AiConfig> {
  const stored = await getSetting<unknown>(executor, AI_SETTING_KEY, null)
  return decodeConfig(stored)
}

/**
 * The row as it persists (task 2.1): the pre-existing fields keep their
 * camelCase keys, the tier additions use the envelope key names the
 * change specifies — `tiers`, `surface_tiers`, `output_language`. Decode
 * (above) reads exactly these keys, so the round-trip is stable.
 */
interface AiConfigStored {
  enabled: boolean
  activeProviderId: string | null
  providers: AiProviderConfig[]
  surfaces: AiSurfacesConfig
  tiers: AiTierModels
  surface_tiers: AiSurfaceTiersConfig
  output_language: string | null
}

function toStoredConfig(config: AiConfig): AiConfigStored {
  return {
    enabled: config.enabled,
    activeProviderId: config.activeProviderId,
    providers: config.providers,
    surfaces: config.surfaces,
    tiers: config.tiers,
    surface_tiers: config.surfaceTiers,
    output_language: config.outputLanguage,
  }
}

async function persistConfig(
  executor: SqlExecutor,
  config: AiConfig
): Promise<void> {
  await setSetting(executor, AI_SETTING_KEY, toStoredConfig(config))
}

// ---------------------------------------------------------------------------
// Public reads (never expose key material)
// ---------------------------------------------------------------------------

/**
 * The full configuration as the AI settings section renders it: providers
 * reduced to `hasApiKey` views, surfaces validated. Absent and corrupt
 * rows read as disabled-AI.
 */
export async function getAiSettings(
  executor: SqlExecutor
): Promise<AiSettingsView> {
  return toView(await loadConfig(executor))
}

/**
 * Whether any AI affordance may appear anywhere in the app: the master
 * switch is on AND the active provider exists (not disabled) with a
 * model. When this is false every AI surface stays hidden — the spec's
 * "No provider configured" scenario — so every failure here fails toward
 * false.
 */
export async function isAiConfigured(executor: SqlExecutor): Promise<boolean> {
  return (await getActiveRuntimeConfig(executor)) !== null
}

/**
 * The per-surface gate: AI enabled AND this surface's toggle on. The
 * toggles exist to disable (all default ON; categorization assist
 * defaults OFF), so an unknown/absent flag reads as that surface's
 * default — never as an implicit off for the on-by-default surfaces.
 */
export async function isSurfaceEnabled(
  executor: SqlExecutor,
  surface: AiSurfaceId
): Promise<boolean> {
  const config = await loadConfig(executor)
  if (!config.enabled) return false
  return config.surfaces[surface]
}

/**
 * Resolve the ACTIVE provider into the runtime call shape
 * (`{ provider, baseUrl?, model }` plus its config id), or null when AI
 * is off, no provider is active, the active one is gone/disabled, or its
 * model is empty — the same conditions `isAiConfigured` checks, so the
 * two can never disagree.
 */
export async function getActiveRuntimeConfig(
  executor: SqlExecutor
): Promise<AiRuntimeConfig | null> {
  const config = await loadConfig(executor)
  if (!config.enabled || config.activeProviderId === null) return null
  const active = config.providers.find(
    (provider) =>
      provider.id === config.activeProviderId && provider.disabled !== true
  )
  if (!active || active.model.trim() === "") return null
  return {
    id: active.id,
    provider: active.kind,
    model: active.model.trim(),
    ...(active.baseUrl !== undefined && active.baseUrl.trim() !== ""
      ? { baseUrl: active.baseUrl.trim() }
      : {}),
  }
}

/**
 * The tier-routing half of the config, as `client.ts` needs it to resolve
 * one surface's model: the per-tier model ids plus the RESOLVED
 * surface → tier map (stored assignments merged over the defaults). Not
 * key material — model ids are stored and returned plainly.
 */
export interface AiTierRouting {
  tiers: AiTierModels
  surfaceTiers: Record<AiSurfaceId, AiTier>
}

export async function getTierRouting(
  executor: SqlExecutor
): Promise<AiTierRouting> {
  const config = await loadConfig(executor)
  return {
    tiers: { ...config.tiers },
    surfaceTiers: { ...DEFAULT_SURFACE_TIERS, ...config.surfaceTiers },
  }
}

/**
 * The configured output language for generative surfaces (spec "AI output
 * language", persisted by `setOutputLanguage`), or null when unset — the
 * model then infers the language from the input. Task 2.6's prompt helper
 * (`services/ai/prompt.ts`) turns this into the appended directive; the
 * fail-toward-unset reading matches every other malformed-field rule.
 */
export async function getOutputLanguage(
  executor: SqlExecutor
): Promise<string | null> {
  const config = await loadConfig(executor)
  return config.outputLanguage
}

/**
 * INTERNAL — for `client.ts` (the transport) ONLY. Never call from UI or
 * surface code, never log the result, never store it beyond the invoke
 * arguments: unseals the provider's API key for exactly one `ai_chat`
 * call (design D1: the key travels webview → command → provider header,
 * then it is dropped).
 *
 * Returns null when the provider has no key, or the envelope cannot be
 * decrypted (key store rotated/corrupt) — failing toward "no key" so the
 * provider reports a config error instead of this module throwing.
 */
export async function resolveApiKey(
  executor: SqlExecutor,
  providerId: string
): Promise<string | null> {
  const config = await loadConfig(executor)
  const provider = config.providers.find(
    (candidate) => candidate.id === providerId
  )
  const sealed = provider?.apiKeySealed
  if (typeof sealed !== "string" || sealed.trim() === "") return null
  try {
    const key = await decryptCredentials<string>(sealed)
    return typeof key === "string" && key.trim() !== "" ? key : null
  } catch {
    // Undecryptable envelope (rotated key store, corrupt row): never fall
    // back to the raw value — report "no key" instead.
    return null
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Persist the master enable flag. Providers and toggles are kept, so
 * re-enabling restores the previous setup. */
export async function setAiEnabled(
  executor: SqlExecutor,
  enabled: boolean
): Promise<void> {
  const config = await loadConfig(executor)
  config.enabled = enabled
  await persistConfig(executor, config)
}

/**
 * Append a provider. The optional `apiKey` is the PLAINTEXT key from the
 * settings form: it is sealed here (never stored raw, never logged) and
 * only the envelope persists. Returns the provider as a key-free view.
 */
export async function addProvider(
  executor: SqlExecutor,
  input: {
    kind: AiProviderKind
    label: string
    model: string
    baseUrl?: string
    apiKey?: string
  }
): Promise<AiProviderView> {
  const config = await loadConfig(executor)
  const trimmedKey = input.apiKey?.trim() ?? ""
  const provider: AiProviderConfig = {
    id: crypto.randomUUID(),
    kind: input.kind,
    label: input.label.trim(),
    model: input.model.trim(),
    ...(input.baseUrl !== undefined && input.baseUrl.trim() !== ""
      ? { baseUrl: input.baseUrl.trim() }
      : {}),
    // Seal-on-write: the plaintext key exists only for this call.
    ...(trimmedKey !== "" ? { apiKeySealed: await encryptCredentials(trimmedKey) } : {}),
  }
  config.providers = [...config.providers, provider]
  await persistConfig(executor, config)
  return toProviderView(provider)
}

export interface AiProviderPatch {
  label?: string
  model?: string
  /** `null` clears the override; `undefined` leaves it untouched. */
  baseUrl?: string | null
  disabled?: boolean
}

/**
 * Update a provider's metadata (label/model/base URL/disabled). Keys are
 * NOT touched here — `setProviderApiKey` owns that slot, so a form edit
 * can never accidentally wipe a stored key. Returns the refreshed
 * key-free view, or null when the id is unknown.
 */
export async function updateProvider(
  executor: SqlExecutor,
  providerId: string,
  patch: AiProviderPatch
): Promise<AiProviderView | null> {
  const config = await loadConfig(executor)
  const existing = config.providers.find(
    (provider) => provider.id === providerId
  )
  if (!existing) return null
  const next: AiProviderConfig = { ...existing }
  if (patch.label !== undefined) next.label = patch.label.trim()
  if (patch.model !== undefined) next.model = patch.model.trim()
  if (patch.baseUrl !== undefined) {
    if (patch.baseUrl === null || patch.baseUrl.trim() === "") {
      delete next.baseUrl
    } else {
      next.baseUrl = patch.baseUrl.trim()
    }
  }
  if (patch.disabled !== undefined) next.disabled = patch.disabled
  config.providers = config.providers.map((provider) =>
    provider.id === providerId ? next : provider
  )
  await persistConfig(executor, config)
  return toProviderView(next)
}

/**
 * Store (or clear with "") a provider's API key. Accepts the PLAINTEXT
 * key from the settings form, seals it with the credentials envelope,
 * and persists ONLY the sealed string — the plaintext never touches the
 * database, a log line, or a return value. Returns false when the
 * provider id is unknown.
 */
export async function setProviderApiKey(
  executor: SqlExecutor,
  providerId: string,
  key: string
): Promise<boolean> {
  const config = await loadConfig(executor)
  const existing = config.providers.find(
    (provider) => provider.id === providerId
  )
  if (!existing) return false
  const trimmed = key.trim()
  const next: AiProviderConfig = { ...existing }
  if (trimmed === "") {
    delete next.apiKeySealed
  } else {
    // Seal-on-write; the plaintext key exists only within this call.
    next.apiKeySealed = await encryptCredentials(trimmed)
  }
  config.providers = config.providers.map((provider) =>
    provider.id === providerId ? next : provider
  )
  await persistConfig(executor, config)
  return true
}

/**
 * Remove a provider entirely (sealed key included). Clearing the active
 * pointer when it referenced the removed provider keeps `isAiConfigured`
 * honest — the AI surfaces hide again rather than dangling.
 */
export async function removeProvider(
  executor: SqlExecutor,
  providerId: string
): Promise<void> {
  const config = await loadConfig(executor)
  config.providers = config.providers.filter(
    (provider) => provider.id !== providerId
  )
  if (config.activeProviderId === providerId) {
    config.activeProviderId = null
  }
  await persistConfig(executor, config)
}

/**
 * Point the active provider at an existing (non-disabled) provider, or
 * clear the selection with null. Unknown or disabled ids are no-ops —
 * the callers (settings UI) only offer eligible rows.
 */
export async function setActiveProvider(
  executor: SqlExecutor,
  providerId: string | null
): Promise<void> {
  const config = await loadConfig(executor)
  if (
    providerId !== null &&
    !config.providers.some(
      (provider) =>
        provider.id === providerId && provider.disabled !== true
    )
  ) {
    return
  }
  config.activeProviderId = providerId
  await persistConfig(executor, config)
}

/** Flip one surface's toggle (the other five are untouched). */
export async function setSurfaceEnabled(
  executor: SqlExecutor,
  surface: AiSurfaceId,
  enabled: boolean
): Promise<void> {
  const config = await loadConfig(executor)
  config.surfaces = { ...config.surfaces, [surface]: enabled }
  await persistConfig(executor, config)
}

/**
 * Assign one surface to a tier (task 2.1). Only the affected surface is
 * touched; the assignment persists explicitly even when it matches the
 * default, so a later change to DEFAULT_SURFACE_TIERS cannot silently
 * re-route a surface the user configured.
 */
export async function setSurfaceTier(
  executor: SqlExecutor,
  surface: AiSurfaceId,
  tier: AiTier
): Promise<void> {
  const config = await loadConfig(executor)
  config.surfaceTiers = { ...config.surfaceTiers, [surface]: tier }
  await persistConfig(executor, config)
}

/**
 * Set (or clear with "") the model id of one tier for the ACTIVE
 * provider. Model ids are free strings stored plainly — they are not
 * secrets and get no sealed treatment (only API keys do). Blank deletes
 * the entry: surfaces on that tier fall back to the provider's default
 * model (spec "Tier fallback").
 */
export async function setTierModel(
  executor: SqlExecutor,
  tier: AiTier,
  model: string
): Promise<void> {
  const config = await loadConfig(executor)
  const trimmed = model.trim()
  const tiers: AiTierModels = { ...config.tiers }
  if (trimmed === "") {
    delete tiers[tier]
  } else {
    tiers[tier] = trimmed
  }
  config.tiers = tiers
  await persistConfig(executor, config)
}

/**
 * Set the output language for generative surfaces (spec "AI output
 * language"), or clear it with null — the model then infers the language
 * from the input. Applying the directive to prompts is task 2.6; this
 * only persists the choice.
 */
export async function setOutputLanguage(
  executor: SqlExecutor,
  language: string | null
): Promise<void> {
  const config = await loadConfig(executor)
  const trimmed = language?.trim() ?? ""
  config.outputLanguage = trimmed === "" ? null : trimmed
  await persistConfig(executor, config)
}

/** Whether a provider kind requires an API key on its endpoint — the
 * add/edit form and the connection test gate on this. */
export function providerRequiresApiKey(kind: AiProviderKind): boolean {
  return KEY_REQUIRED_KINDS.includes(kind)
}
