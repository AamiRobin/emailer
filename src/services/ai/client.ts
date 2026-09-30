import { invoke } from "@tauri-apps/api/core"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import {
  getActiveRuntimeConfig,
  getAiSettings,
  getTierRouting,
  isAiConfigured,
  isSurfaceEnabled,
  providerRequiresApiKey,
  resolveApiKey,
  DEFAULT_SURFACE_TIERS,
  type AiProviderKind,
  type AiSurfaceId,
  type AiTier,
  type AiTierRouting,
} from "./settings"
import { recordAiUsage, resolveUsageRecord } from "./usage"

/**
 * The shared TS AI client (task 4.2, design D1) — the transport every AI
 * surface of the phase consumes. Transport-only by design: prompt
 * shaping, cache keys and result caching live in the CALLERS (they own
 * kinds and input hashes over the 4.3 cache service); this module gates,
 * resolves the active provider, and maps the `ai_chat` command's
 * structured errors onto typed exceptions.
 *
 * Gating: every call first checks `isAiConfigured` (spec "No provider
 * configured" — surfaces HIDE when false) and `isSurfaceEnabled` (spec
 * "Disable a single surface"); violations throw `AiUnavailableError` so
 * the caller decides hide-vs-show. Provider failures surface as
 * `AiProviderError` carrying the Rust error's `kind`
 * (`network`/`status`/`parse`/`rate_limited`/`config`), message and HTTP
 * status — never the API key (the Rust command already redacts; this
 * module adds no logging of its own and never logs arguments).
 *
 * Model routing and usage (parity-round-2 task 2.2, design D8): the
 * model sent to the command is the surface's tier-resolved id
 * (`resolveSurfaceModel`; the tier config lives in the `ai.config`
 * envelope), and every completed call writes one `ai_usage` row via the
 * usage service — fire-and-forget, logged on failure, never fatal.
 *
 * Key flow (design D1): the sealed key is unsealed inside
 * `settings.resolveApiKey` for exactly one invoke and dropped with the
 * call frame — it exists nowhere else here.
 */

/** The six AI surfaces, as the settings toggles id them. */
export type AiSurface = AiSurfaceId

/**
 * The `surface` strings sent to the Rust per-surface rate limiter (task
 * 4.1: names containing "summar" get 10/min, "categor" 30/min,
 * "quick-repl" 40/min (task 2.4 — chips are latency surfaces), the rest
 * 20/min — the mapping below lands each surface in its intended bucket).
 */
const SURFACE_WIRE_NAMES: Record<AiSurface, string> = {
  summaries: "summaries",
  smartReplies: "smart-replies",
  composeTransform: "compose-transform",
  askInbox: "ask-inbox",
  taskExtraction: "task-extraction",
  categorizationAssist: "categorization-assist",
  quickReplies: "quick-replies",
  ruleAssist: "rule-assist",
  eventExtraction: "event-extraction",
  translation: "translation",
  folderDigest: "folder-digest",
  assistant: "assistant",
}

/** One conversation turn (plain text; prompt shaping is the caller's). */
export interface AiChatMessage {
  role: "user" | "assistant"
  content: string
}

export interface AiChatArgs {
  system?: string
  messages: AiChatMessage[]
  maxTokens?: number
  surface: AiSurface
  /**
   * The tier-resolved model for this surface, as `resolveSurfaceRuntime`
   * returned it. Surfaces that cache MUST pass the exact value they built
   * their ai_cache identity from, so the identity and the request can
   * never diverge (a tier model's output is attributed to — and
   * invalidated by — that model id). Omitted, `aiChat` resolves the
   * model itself (the surfaces without a cache identity).
   */
  model?: string
}

/** Why AI is unavailable without a provider round-trip. */
export type AiUnavailableReason = "not-configured" | "surface-disabled"

/**
 * Thrown when the call never reached a provider: no provider configured
 * ("not-configured" — hide the surface per spec) or the invoking
 * surface's toggle is off ("surface-disabled" — hide that surface's
 * affordances). Callers decide hide-vs-show from `reason`.
 */
export class AiUnavailableError extends Error {
  readonly reason: AiUnavailableReason

  constructor(reason: AiUnavailableReason) {
    super(
      reason === "not-configured"
        ? "AI assistance is not configured"
        : "This AI surface is disabled"
    )
    this.name = "AiUnavailableError"
    this.reason = reason
  }
}

/** The `ai_chat` structured error kinds (task 4.1, `AiCommandError`). */
export type AiProviderErrorKind =
  | "network"
  | "status"
  | "parse"
  | "rate_limited"
  | "config"

/**
 * A provider/command failure with its specific reason (spec "AI caching
 * and failure handling": failures reported with a specific reason and a
 * retry affordance — `kind` drives that: retry on "network", back off on
 * "rate_limited", surface configuration mistakes). The message is the
 * Rust-side, key-redacted text.
 */
export class AiProviderError extends Error {
  readonly kind: AiProviderErrorKind
  readonly status?: number

  constructor(
    kind: AiProviderErrorKind,
    message: string,
    status?: number
  ) {
    super(message)
    this.name = "AiProviderError"
    this.kind = kind
    if (status !== undefined) this.status = status
  }
}

function isProviderErrorKind(value: string): value is AiProviderErrorKind {
  return (
    value === "network" ||
    value === "status" ||
    value === "parse" ||
    value === "rate_limited" ||
    value === "config"
  )
}

/**
 * Normalize an `ai_chat` rejection into an `AiProviderError`. The Rust
 * command rejects with `{ kind, message, status? }`; anything else (an
 * IPC-level failure, a non-Tauri runtime) wraps as kind "network" —
 * transport did not complete — with the original text as the message.
 */
function normalizeProviderError(thrown: unknown): AiProviderError {
  if (thrown instanceof AiProviderError) return thrown
  if (typeof thrown === "object" && thrown !== null) {
    const candidate = thrown as Record<string, unknown>
    if (
      typeof candidate.kind === "string" &&
      isProviderErrorKind(candidate.kind) &&
      typeof candidate.message === "string"
    ) {
      return new AiProviderError(
        candidate.kind,
        candidate.message,
        typeof candidate.status === "number" ? candidate.status : undefined
      )
    }
  }
  return new AiProviderError(
    "network",
    thrown instanceof Error ? thrown.message : String(thrown)
  )
}

/**
 * The `ai_chat` success payload (task 4.1 wire shape) plus the usage
 * block added in parity-round-2 task 2.2: the provider's token counts
 * when it reports them, absent otherwise (snake_case, matching the Rust
 * `ChatResponse` / `ChatUsage` serialization).
 */
interface AiChatResponse {
  content: string
  model: string
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
  }
}

/** The wire arguments, as the Rust command expects them (Tauri maps the
 * camelCase to its snake_case params). */
interface AiChatWireCall {
  provider: AiProviderKind
  baseUrl: string | null
  /** The unsealed key for THIS call. Never logged; dropped with the call. */
  apiKey: string | null
  model: string
  system: string | null
  messages: AiChatMessage[]
  maxTokens: number | null
  surface: string
}

async function invokeAiChat(call: AiChatWireCall): Promise<AiChatResponse> {
  try {
    return await invoke<AiChatResponse>("ai_chat", {
      provider: call.provider,
      baseUrl: call.baseUrl,
      apiKey: call.apiKey,
      model: call.model,
      system: call.system,
      messages: call.messages,
      maxTokens: call.maxTokens,
      surface: call.surface,
    })
  } catch (thrown) {
    throw normalizeProviderError(thrown)
  }
}

/**
 * Resolve the model id one surface's request is made with (task 2.2,
 * spec "Per-scenario AI model routing"): the surface's configured tier's
 * model id, falling back to the active provider's default model when the
 * surface keeps its default tier assignment or the tier has no model id
 * (spec "Tier fallback"). Exported for tests; `aiChat` is the production
 * caller.
 */
export function resolveSurfaceModel(
  surface: AiSurface,
  routing: AiTierRouting,
  defaultModel: string
): string {
  const tier: AiTier = routing.surfaceTiers[surface] ?? DEFAULT_SURFACE_TIERS[surface]
  const model = routing.tiers[tier]
  return typeof model === "string" && model.trim() !== ""
    ? model.trim()
    : defaultModel
}

/**
 * The effective runtime for one surface: the active provider config with
 * `model` already tier-resolved (`resolveSurfaceModel`). Surfaces call
 * this ONCE at the start of their flow and use the returned model for
 * BOTH their ai_cache identity and the `aiChat` request (via
 * `AiChatArgs.model`) — cache entries are thereby attributed to, and
 * invalidated by, the model that actually serves them (a tier-model
 * switch changes the identity, so stale entries stop hitting). Null
 * means the surface's gate is closed (AI off / no active provider with a
 * model) — the same conditions `getActiveRuntimeConfig` reports.
 */
export interface AiSurfaceRuntime {
  /** The provider's config id (for `resolveApiKey`). */
  id: string
  /** The provider kind — the `ai_chat` `provider` argument. */
  provider: AiProviderKind
  /** The tier-resolved model the request will use. */
  model: string
  baseUrl?: string
}

export async function resolveSurfaceRuntime(
  executor: SqlExecutor,
  surface: AiSurface
): Promise<AiSurfaceRuntime | null> {
  const runtime = await getActiveRuntimeConfig(executor)
  if (!runtime) return null
  const routing = await getTierRouting(executor)
  return {
    id: runtime.id,
    provider: runtime.provider,
    model: resolveSurfaceModel(surface, routing, runtime.model),
    ...(runtime.baseUrl !== undefined ? { baseUrl: runtime.baseUrl } : {}),
  }
}

/**
 * Run one chat completion against the ACTIVE provider for the given
 * surface. Gates on configuration and the surface toggle
 * (`AiUnavailableError` otherwise), resolves the runtime config and the
 * unsealed
 * key, invokes `ai_chat`, and returns the completion text. Caching is
 * the caller's concern (task 4.3 service) — this function always
 * represents a live provider call.
 *
 * Model routing (task 2.2): the model passed to the command is the
 * surface's tier-resolved id (`resolveSurfaceModel`), not necessarily
 * the provider's default — or the caller's `args.model`, which caching
 * surfaces pass so their cache identity and this request ride ONE
 * resolution. Usage accounting (task 2.2, design D8): every
 * COMPLETED call inserts one `ai_usage` row — provider-reported tokens
 * when the provider sent them, a chars/4 estimate otherwise — written
 * fire-and-forget: a recording failure logs and continues, never failing
 * the AI call it accounts for.
 */
export async function aiChat(args: AiChatArgs): Promise<string> {
  const executor = getExecutor()
  if (!(await isAiConfigured(executor))) {
    throw new AiUnavailableError("not-configured")
  }
  if (!(await isSurfaceEnabled(executor, args.surface))) {
    throw new AiUnavailableError("surface-disabled")
  }
  const [runtime, routing] = await Promise.all([
    getActiveRuntimeConfig(executor),
    getTierRouting(executor),
  ])
  if (!runtime) {
    // isAiConfigured and getActiveRuntimeConfig read the same state, so
    // this is unreachable in practice — kept as the fail-toward-off guard.
    throw new AiUnavailableError("not-configured")
  }
  const apiKey = await resolveApiKey(executor, runtime.id)
  const model =
    args.model !== undefined && args.model.trim() !== ""
      ? args.model.trim()
      : resolveSurfaceModel(args.surface, routing, runtime.model)
  const response = await invokeAiChat({
    provider: runtime.provider,
    baseUrl: runtime.baseUrl ?? null,
    apiKey,
    model,
    system: args.system ?? null,
    messages: args.messages,
    maxTokens: args.maxTokens ?? null,
    surface: SURFACE_WIRE_NAMES[args.surface],
  })
  // Fire-and-forget usage row (design D8): one insert per completed
  // call, keyed by the model that actually served it. Failures log and
  // continue — usage accounting must never break an AI surface.
  recordAiUsage(
    executor,
    resolveUsageRecord({
      surface: args.surface,
      model: response.model || model,
      system: args.system ?? null,
      messages: args.messages,
      content: response.content,
      usage: response.usage,
    })
  ).catch((error: unknown) => {
    console.warn("[ai] failed to record the usage row", error)
  })
  return response.content
}

export type AiConnectionTestResult =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * The Settings → AI connection test (spec "Configure and activate a
 * provider"): one 1-token "ping" through `ai_chat` for the GIVEN
 * provider (it need not be active — the user tests before activating),
 * under the "test" surface (the Rust limiter's default 20/min bucket).
 * Obvious configuration gaps (no model, no key on a key-requiring kind,
 * no base URL on a custom endpoint) are reported locally as specific
 * reasons without a network round-trip; anything the command rejects
 * comes back as its specific structured message. Success is `{ ok:
 * true }`, failure `{ ok: false, reason }` — never a throw, never key
 * material in a reason (the Rust side redacts).
 */
export async function testAiConnection(
  providerId: string
): Promise<AiConnectionTestResult> {
  const executor = getExecutor()
  const settings = await getAiSettings(executor)
  const provider = settings.providers.find(
    (candidate) => candidate.id === providerId
  )
  if (!provider) {
    return { ok: false, reason: "This provider no longer exists." }
  }
  if (provider.model.trim() === "") {
    return { ok: false, reason: "Choose a model id first." }
  }
  if (providerRequiresApiKey(provider.kind) && !provider.hasApiKey) {
    return { ok: false, reason: "Add an API key first." }
  }
  if (provider.kind === "custom" && provider.baseUrl === null) {
    return { ok: false, reason: "Add the endpoint base URL first." }
  }
  const apiKey = await resolveApiKey(executor, provider.id)
  try {
    await invokeAiChat({
      provider: provider.kind,
      baseUrl: provider.baseUrl,
      apiKey,
      model: provider.model.trim(),
      system: null,
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 1,
      surface: "test",
    })
    return { ok: true }
  } catch (error) {
    const providerError = normalizeProviderError(error)
    return { ok: false, reason: providerError.message }
  }
}
