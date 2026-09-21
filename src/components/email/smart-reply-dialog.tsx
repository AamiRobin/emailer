import { useCallback, useEffect, useState } from "react"
import { Loader2, WandSparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getExecutor } from "@/services/db/executor"
import {
  buildWritingStyleProfile,
  loadStyleProfile,
  type StyleProfileBuildFailure,
} from "@/services/ai/style-profile"
import {
  generateSmartReply,
  type SmartReplyFailureReason,
} from "@/services/ai/smart-replies"
import { openSmartReplyForThread } from "./reply-opener"

/**
 * The smart-reply dialog (task 4.5, ai-assistance spec "Writing-style
 * smart replies"). Opened from the reading-pane toolbar's wand button
 * (thread-view.tsx, rendered only when AI is configured and the
 * smartReplies surface is enabled — the same hide posture as the other
 * toolbar AI affordances). ONE suggestion at a time, always on request:
 *
 * - No profile yet → the CONSENT card first: the build is described
 *   verbatim as an analysis of recent sent messages, and the card states
 *   that nothing is sent automatically (spec: building SHALL clearly
 *   state that recent sent messages are analyzed). "Analyze sent mail"
 *   runs `buildWritingStyleProfile`; success reports the sample size and
 *   proceeds to the generate step.
 * - Generate → `generateSmartReply` (cached per design D2) → the
 *   suggestion renders in a preview card with "Use reply" / "Regenerate".
 * - "Use reply" inserts the suggestion into the composer as an EDITABLE
 *   draft through `openSmartReplyForThread` (the shared reply-opener
 *   prefill: addressing, subject and threading context from buildReply,
 *   the suggestion replacing the quoted draft body) and closes the
 *   dialog. Nothing is ever dispatched on its own.
 *
 * Failures render inline with Retry (spec "AI caching and failure
 * handling"); the card notes the suggestion is AI-generated (spec:
 * indicate AI-generated content).
 */

/** Dialog stages, in flow order (error overlays build/generate). */
type Stage =
  | "checking" // profile presence probe (per open)
  | "consent" // no profile — the consent card
  | "building" // profile build in flight
  | "ready" // profile exists — awaiting Generate
  | "generating" // suggestion in flight
  | "preview" // suggestion shown — Use reply / Regenerate
  | "error"

interface SmartReplyDialogProps {
  threadId: string
  /** The thread's OWNING account (profile + build scope) — thread-view
   * passes its resolved owner, like every account-scoped toolbar action. */
  accountId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Why the last attempt failed — Retry re-runs that step. */
type ErrorStep = "build" | "generate"

/** The whole dialog flow in one object: an open-reset is a single
 * setState (see the probe effect below). Fields are present only in the
 * stages that mean them. */
type Flow = {
  stage: Stage
  /** Human-readable failure copy (error stage only). */
  errorMessage?: string
  /** Which step failed — Retry re-runs it (error stage only). */
  errorStep?: ErrorStep
  /** The generated suggestion (preview stage only). */
  reply?: string
  /** Completion report after a successful in-dialog build; kept through
   * the generate step so the report stays visible. */
  builtInfo?: string
}

/** Human copy for the typed service failure reasons. */
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

function generateFailureCopy(reason: SmartReplyFailureReason): string {
  switch (reason) {
    case "not-configured":
      return "AI assistance is not configured."
    case "surface-disabled":
      return "Smart replies are turned off in Settings."
    case "no-profile":
      return "No writing-style profile was found — build one first."
    case "no-thread":
      return "This conversation could not be loaded."
    case "provider":
      return "The provider request failed."
  }
}

/**
 * Suggestion plain text → composer HTML, mirroring the compose transform's
 * `transformedTextToHtml` splice-in pattern (task 4.6): blank-line-separated
 * blocks become paragraphs, single newlines become `<br>`, everything
 * escaped — the model's output contract guarantees the shape.
 */
function suggestionTextToHtml(text: string): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== "")
  if (blocks.length === 0) return ""
  const inline = (block: string) => escape(block).replace(/\n/g, "<br>")
  if (blocks.length === 1) return inline(blocks[0])
  return blocks.map((block) => `<p>${inline(block)}</p>`).join("")
}

export function SmartReplyDialog({
  threadId,
  accountId,
  open,
  onOpenChange,
}: SmartReplyDialogProps) {
  /** The whole flow in one object, so an open-reset is a single setState. */
  const [flow, setFlow] = useState<Flow>(() => ({ stage: "checking" }))
  const resetFlow = () => setFlow({ stage: "checking" })

  /** Probe the stored profile once per open — consent first when absent.
   * The synchronous reset is the same sanctioned set-state-in-effect
   * escape hatch task-extraction-dialog.tsx uses: a deferred reset would
   * flash the previous flow's stage while the new probe starts (the
   * dialog remounts per open in thread-view, so this only guards an
   * `open` flip on a kept-alive instance). */
  useEffect(() => {
    if (!open) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    resetFlow()
    try {
      void loadStyleProfile(getExecutor(), accountId)
        .then((stored) => {
          if (!cancelled) setFlow({ stage: stored ? "ready" : "consent" })
        })
        .catch(() => {
          if (!cancelled) setFlow({ stage: "consent" })
        })
    } catch {
      // No executor (plain vite) — degrade to the consent card.
      if (!cancelled) setFlow({ stage: "consent" })
    }
    return () => {
      cancelled = true
    }
  }, [open, accountId])

  /** Build the profile (consent card's button, and Retry after a build
   * failure). Success reports completion and proceeds to Generate. */
  const runBuild = useCallback(() => {
    setFlow({ stage: "building" })
    try {
      void buildWritingStyleProfile(getExecutor(), accountId)
        .then((result) => {
          if (result.ok) {
            setFlow({
              stage: "ready",
              builtInfo: `Profile built from ${result.sampleSize} sent message${
                result.sampleSize === 1 ? "" : "s"
              }.`,
            })
          } else {
            setFlow({
              stage: "error",
              errorStep: "build",
              errorMessage:
                result.reason === "provider" && result.message
                  ? `${buildFailureCopy(result.reason)} ${result.message}`
                  : buildFailureCopy(result.reason),
            })
          }
        })
        .catch(() => {
          setFlow({
            stage: "error",
            errorStep: "build",
            errorMessage: "Building the writing-style profile failed.",
          })
        })
    } catch {
      setFlow({
        stage: "error",
        errorStep: "build",
        errorMessage: "Building the writing-style profile failed.",
      })
    }
  }, [accountId])

  /** Generate (or regenerate) one style-matched suggestion. */
  const runGenerate = useCallback(
    (regenerate: boolean) => {
      setFlow({ stage: "generating", builtInfo: flow.builtInfo })
      try {
        void generateSmartReply(
          getExecutor(),
          accountId,
          threadId,
          regenerate ? { regenerate: true } : {}
        )
          .then((result) => {
            if (result.ok) {
              setFlow({
                stage: "preview",
                builtInfo: flow.builtInfo,
                reply: result.reply,
              })
            } else if (result.reason === "no-profile") {
              // Defensive (the consent step normally guarantees one):
              // route back to the consent card instead of an error.
              setFlow({ stage: "consent" })
            } else {
              setFlow({
                stage: "error",
                errorStep: "generate",
                errorMessage:
                  result.reason === "provider" && result.message
                    ? `${generateFailureCopy(result.reason)} ${result.message}`
                    : generateFailureCopy(result.reason),
              })
            }
          })
          .catch(() => {
            setFlow({
              stage: "error",
              errorStep: "generate",
              errorMessage: "Drafting the suggestion failed.",
            })
          })
      } catch {
        setFlow({
          stage: "error",
          errorStep: "generate",
          errorMessage: "Drafting the suggestion failed.",
        })
      }
    },
    [accountId, threadId, flow.builtInfo]
  )

  /** Use reply: insert the suggestion into the composer as an editable
   * draft (the shared reply-opener path) and close on success. */
  const useReply = useCallback(() => {
    if (flow.reply === undefined) return
    try {
      void openSmartReplyForThread({
        threadId,
        replyAll: false,
        accountId,
        bodyHtml: suggestionTextToHtml(flow.reply),
      })
        .then((opened) => {
          if (opened) onOpenChange(false)
        })
        .catch(() => {})
    } catch {
      // No executor — keep the dialog open; the user can retry.
    }
  }, [flow.reply, threadId, accountId, onOpenChange])

  const stage = flow.stage
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="smart-reply-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WandSparkles className="size-4" aria-hidden />
            Smart reply
          </DialogTitle>
          <DialogDescription>
            A draft suggestion in your writing style, for you to edit. Nothing
            is sent automatically.
          </DialogDescription>
        </DialogHeader>

        {stage === "checking" && (
          <div
            data-testid="smart-reply-checking"
            className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Checking your writing-style profile…
          </div>
        )}

        {stage === "consent" && (
          <div data-testid="smart-reply-consent" className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Emailer analyzes your recent sent messages to learn your writing
              style, so suggestions sound like you. The analysis runs against
              the active AI provider and the profile stays on this machine.
            </p>
            <p className="text-xs text-muted-foreground">
              Nothing is sent automatically — suggestions are always drafts
              for you to review and edit.
            </p>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                aria-label="Close smart replies"
              >
                Cancel
              </Button>
              <Button
                data-testid="smart-reply-build"
                onClick={runBuild}
              >
                <WandSparkles aria-hidden />
                Analyze sent mail
              </Button>
            </DialogFooter>
          </div>
        )}

        {stage === "building" && (
          <div
            data-testid="smart-reply-build-busy"
            className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Analyzing your recent sent messages…
          </div>
        )}

        {(stage === "ready" || stage === "generating") && (
          <div className="flex flex-col gap-3">
            {flow.builtInfo !== undefined && (
              <p
                data-testid="smart-reply-built-info"
                role="status"
                className="text-xs text-muted-foreground"
              >
                {flow.builtInfo}
              </p>
            )}
            {stage === "ready" ? (
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  aria-label="Close smart replies"
                >
                  Cancel
                </Button>
                <Button
                  data-testid="smart-reply-generate"
                  onClick={() => runGenerate(false)}
                >
                  <WandSparkles aria-hidden />
                  Generate suggestion
                </Button>
              </DialogFooter>
            ) : (
              <div
                data-testid="smart-reply-generate-busy"
                className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Drafting a suggestion in your style…
              </div>
            )}
          </div>
        )}

        {stage === "preview" && flow.reply !== undefined && (
          <div className="flex flex-col gap-3">
            <div
              data-testid="smart-reply-preview"
              className="max-h-64 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3"
            >
              <p
                data-testid="smart-reply-text"
                className="whitespace-pre-wrap text-sm text-foreground"
              >
                {flow.reply}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              AI-generated — inserting opens the composer with this draft for
              you to edit before sending.
            </p>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                aria-label="Dismiss smart reply"
              >
                Dismiss
              </Button>
              <Button
                variant="outline"
                data-testid="smart-reply-regenerate"
                onClick={() => runGenerate(true)}
              >
                Regenerate
              </Button>
              <Button data-testid="smart-reply-use" onClick={useReply}>
                Use reply
              </Button>
            </DialogFooter>
          </div>
        )}

        {stage === "error" && flow.errorMessage !== undefined && (
          <div
            data-testid="smart-reply-error"
            className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
          >
            <span className="text-destructive">{flow.errorMessage}</span>
            <Button
              variant="outline"
              size="sm"
              data-testid="smart-reply-retry"
              onClick={
                flow.errorStep === "build"
                  ? runBuild
                  : () => runGenerate(false)
              }
            >
              Retry
            </Button>
          </div>
        )}

      </DialogContent>
    </Dialog>
  )
}
