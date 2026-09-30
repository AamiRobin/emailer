import { useEffect, useState } from "react"
import { Languages } from "lucide-react"

import { Button } from "@/components/ui/button"
import { AiUnavailableError } from "@/services/ai/client"
import { isAiConfigured, isSurfaceEnabled } from "@/services/ai/settings"
import {
  translateMessage,
  type TranslationResult,
} from "@/services/ai/translation"
import { getExecutor } from "@/services/db/executor"
import type { MessageRow } from "@/services/db/messages"

/**
 * Per-message translate control (add-ai-surfaces task 5.1, ai-assistance
 * spec "Per-message translation"). A self-gating affordance mounted by
 * MailDisplay directly under the message header — the QuickReplyChips
 * posture: the surface's OWN availability gates the mount, so the parent
 * carries no gating knowledge. AI not configured, the translation toggle
 * off, or no db (outside Tauri / before bootstrap) means the component
 * renders NOTHING (spec "Gating": the translate affordance is hidden on
 * every message and no provider request is possible from the UI).
 *
 * Invoking toggles the panel: the click runs services/ai/translation's
 * translateMessage (the service owns the per message+language cache, the
 * untrusted-text fencing and the output-language resolution — none of
 * that is UI concern) and the translation renders in a bordered muted
 * panel with the original still visible beside it. A second click hides
 * the panel ("Hide translation"); clicking again goes back through the
 * service, whose cache serves an unchanged repeat without a provider
 * call (spec "Cached repeat" — the UI just calls through).
 *
 * Failure handling follows the canonical AI surface split: a mid-session
 * gate close (AiUnavailableError — provider removed, toggle off) HIDES
 * the control entirely, while a provider failure (AiProviderError, and
 * anything unexpected) renders inline in the panel area with Retry —
 * the ask-inbox / task-extraction pattern, never a toast or a dialog
 * (spec "AI caching and failure handling": reported inline on the
 * surface that invoked them).
 */

interface TranslateControlProps {
  message: MessageRow
  /** Disabled alongside the rest of the thread chrome (pending action). */
  disabled?: boolean
}

/** One control state: hidden (gate closed — nothing renders), closed
 * (gate open, panel hidden), loading (a call in flight), open (panel
 * visible) and error (provider failure inline with Retry). */
type TranslateStage =
  | { stage: "hidden" }
  | { stage: "closed" }
  | { stage: "loading" }
  | { stage: "open"; result: TranslationResult }
  | { stage: "error"; message: string }

export function TranslateControl({
  message,
  disabled = false,
}: TranslateControlProps) {
  const [state, setState] = useState<TranslateStage>({ stage: "hidden" })

  // Gate check (spec "Gating"): configured AND the translation surface
  // enabled, read once per message mount — MailDisplay is keyed by
  // message id upstream, so toggling the surface in settings takes
  // effect on the next mount. Best-effort like the other gate loaders
  // (composer, ask-inbox): any read failure fails toward hidden.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const executor = getExecutor()
        const ok =
          (await isAiConfigured(executor)) &&
          (await isSurfaceEnabled(executor, "translation"))
        if (!cancelled) setState(ok ? { stage: "closed" } : { stage: "hidden" })
      } catch {
        // No executor (plain vite / before bootstrap) — fail toward hidden.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [message.id])

  /** Run (or re-run) the translation through the service. The executor
   * acquisition mirrors QuickReplyChips: getExecutor() throws before db
   * bootstrap, so the synchronous throw lands in the same inline error
   * path as a provider failure — retryable, never a crash. */
  function runTranslate(): void {
    setState({ stage: "loading" })
    try {
      const executor = getExecutor()
      void translateMessage(executor, message)
        .then((result) => {
          setState({ stage: "open", result })
        })
        .catch((error: unknown) => {
          if (error instanceof AiUnavailableError) {
            // The gate closed mid-session (provider removed, toggle
            // off): the hide-vs-show contract — the control disappears.
            setState({ stage: "hidden" })
            return
          }
          // AiProviderError (and anything unexpected): inline with
          // Retry, the original content untouched.
          setState({
            stage: "error",
            message:
              error instanceof Error ? error.message : "Translation failed.",
          })
        })
    } catch {
      setState({ stage: "error", message: "Translation is unavailable." })
    }
  }

  /** Toggle: open → close the panel (the result stays in state; the
   * next open goes back through the service and its cache). Closed or
   * errored → run the translation. Loading is not clickable (disabled). */
  function handleToggle(): void {
    if (state.stage === "loading") return
    if (state.stage === "open") {
      setState({ stage: "closed" })
      return
    }
    runTranslate()
  }

  if (state.stage === "hidden") return null

  return (
    <div className="mt-1 flex flex-col items-start gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 text-xs text-muted-foreground"
        disabled={disabled || state.stage === "loading"}
        aria-expanded={state.stage === "open"}
        data-testid="message-translate"
        onClick={handleToggle}
      >
        <Languages className="size-3.5" aria-hidden />
        {state.stage === "open"
          ? "Hide translation"
          : state.stage === "loading"
            ? "Translating…"
            : "Translate"}
      </Button>
      {state.stage === "open" && (
        <div
          data-testid="message-translation-panel"
          className="w-full rounded-md border border-border bg-muted/50 px-3 py-2"
        >
          {state.result.language !== null && (
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Translated to {state.result.language}
            </p>
          )}
          <p className="whitespace-pre-wrap text-sm">
            {state.result.translation}
          </p>
        </div>
      )}
      {state.stage === "error" && (
        <div
          role="alert"
          data-testid="message-translate-error"
          className="flex w-full items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span className="min-w-0 flex-1">{state.message}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0"
            disabled={disabled}
            data-testid="message-translate-retry"
            onClick={runTranslate}
          >
            Retry
          </Button>
        </div>
      )}
    </div>
  )
}
