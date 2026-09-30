import { useCallback, useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"

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
  buildFolderDigest,
  type DigestResult,
  type DigestScope,
} from "@/services/ai/folder-digest"
import { AiUnavailableError } from "@/services/ai/client"

/**
 * The "Catch me up" digest dialog (task 7.1, ai-assistance spec "Folder
 * unread digest"). Opened by the mailbox header's affordance
 * (thread-list.tsx) with the invoked view's scope SNAPSHOT — the dialog
 * never re-reads the list store, so a view switch while it is open cannot
 * move the briefing's scope mid-flight. It mounts already open and
 * unmounts on close (the ask-inbox/save-search pattern), so every open
 * starts a fresh run: buildFolderDigest on mount (the service owns the
 * cache — an unchanged unread set re-opens makes no provider call), a
 * loading state while it builds, then the briefing with a coverage meta
 * line ("N unread threads covered", plus ", and M more not covered" when
 * the scope overflowed the cap).
 *
 * Failure handling follows the AI spec: an AiUnavailableError is the hide
 * contract — the affordance only renders when the gate is open, so the
 * dialog closes and renders nothing (fail-toward-off) — while an
 * AiProviderError (and anything unexpected) renders inline with a Retry,
 * mirroring the task-extraction dialog's error block. The dialog notes
 * the briefing is AI-generated (spec: indicate AI-generated content).
 */

/** The dialog state after (and between) builds. "hidden" is the
 * AiUnavailableError terminal: render nothing, close. */
type DigestPhase =
  | { phase: "loading" }
  | { phase: "ready"; result: DigestResult }
  | { phase: "empty" }
  | { phase: "error"; message: string | null }
  | { phase: "hidden" }

interface FolderDigestDialogProps {
  /** The invoked view's scope, snapshotted at open time (see above). */
  scope: DigestScope
  /** Called false on the hide-contract close; the parent unmounts the
   * dialog while closed. */
  onOpenChange: (open: boolean) => void
}

export function FolderDigestDialog({
  scope,
  onOpenChange,
}: FolderDigestDialogProps) {
  const [phase, setPhase] = useState<DigestPhase>({ phase: "loading" })
  // A ref for the close callback so an unstable parent handler can never
  // re-trigger the mount effect below (the digest runs once per open).
  const onOpenChangeRef = useRef(onOpenChange)
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  const runDigest = useCallback(() => {
    setPhase({ phase: "loading" })
    try {
      void buildFolderDigest(getExecutor(), { scope })
        .then((outcome) => {
          if (outcome === null) {
            // Zero unread raced (threads were read elsewhere since the
            // rows the affordance derived its visibility from loaded).
            // An explicit empty line beats popping the dialog shut under
            // the cursor — the user asked, the dialog answers.
            setPhase({ phase: "empty" })
          } else {
            setPhase({ phase: "ready", result: outcome })
          }
        })
        .catch((error: unknown) => {
          if (error instanceof AiUnavailableError) {
            // The hide contract: the affordance hides itself when the
            // gate is closed, so this is the fail-toward-off guard (the
            // service's own not-configured throw) — close, render nothing.
            setPhase({ phase: "hidden" })
            onOpenChangeRef.current(false)
            return
          }
          // AiProviderError (and anything unexpected): inline with Retry,
          // the task-extraction dialog's error idiom.
          setPhase({
            phase: "error",
            message:
              error instanceof Error
                ? error.message
                : "Could not build the digest.",
          })
        })
    } catch {
      // No executor (plain vite / early startup) — same hide contract.
      setPhase({ phase: "hidden" })
      onOpenChangeRef.current(false)
    }
  }, [scope])

  // Fresh digest on mount (Retry re-runs the same callback). The
  // synchronous reset is intentional — the dialog must not flash a
  // previous open's briefing — the sanctioned set-state-in-effect escape
  // hatch the task-extraction dialog uses.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    runDigest()
  }, [runDigest])

  if (phase.phase === "hidden") return null

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="folder-digest-dialog"
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Catch me up</DialogTitle>
          <DialogDescription>
            An AI-generated briefing over this view's unread threads. Only
            those threads' text is sent to the provider.
          </DialogDescription>
        </DialogHeader>
        {phase.phase === "loading" && (
          <div
            data-testid="folder-digest-busy"
            className="py-6 text-center text-sm text-muted-foreground"
          >
            Catching you up…
          </div>
        )}
        {phase.phase === "empty" && (
          <div
            data-testid="folder-digest-empty"
            className="py-6 text-center text-sm text-muted-foreground"
          >
            No unread threads.
          </div>
        )}
        {phase.phase === "error" && (
          <div
            data-testid="folder-digest-error"
            className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
          >
            <span className="text-destructive">
              {phase.message ?? "Could not build the digest."}
            </span>
            <Button
              variant="outline"
              size="sm"
              data-testid="folder-digest-retry"
              onClick={runDigest}
            >
              Retry
            </Button>
          </div>
        )}
        {phase.phase === "ready" && (
          <>
            <DigestText digest={phase.result.digest} />
            {/* Coverage meta (spec: "the most recent unread threads in
                that scope"): what the briefing covers, plus the overflow
                tail when the scope's unread threads exceeded the cap —
                the same counts the digest was generated from. */}
            <p
              data-testid="folder-digest-meta"
              className="text-xs text-muted-foreground"
            >
              {phase.result.threadCount} unread{" "}
              {phase.result.threadCount === 1 ? "thread" : "threads"} covered
              {phase.result.omittedCount > 0
                ? `, and ${phase.result.omittedCount} more not covered`
                : ""}
            </p>
          </>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            aria-label="Close digest"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Minimal briefing renderer. The service's prompt pins the digest's shape
 * (folder-digest.ts SYSTEM_PROMPT): one "- <subject> — <gist>" bullet per
 * thread, then a final "Overview: …" line (and, on overflow, the service's
 * own "…and N more unread threads not covered." line) — so a two-rule
 * renderer covers the contract without a markdown dependency: consecutive
 * "- " lines become one list, any other non-blank line becomes a plain
 * paragraph. Anything else the model emits renders as inert text, one
 * line per paragraph — never interpreted.
 */
function DigestText({ digest }: { digest: string }) {
  const blocks: ReactNode[] = []
  let bullets: string[] = []
  let bulletKey: number | null = null
  const flushBullets = () => {
    if (bullets.length === 0) return
    const items = bullets
    const key = `bullets-${bulletKey}`
    bullets = []
    bulletKey = null
    blocks.push(
      <ul key={key} className="list-disc space-y-1 ps-5">
        {items.map((bullet, index) => (
          <li key={index}>{bullet}</li>
        ))}
      </ul>
    )
  }
  digest.split("\n").forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith("- ")) {
      if (bulletKey === null) bulletKey = index
      bullets.push(trimmed.slice(2))
      return
    }
    flushBullets()
    if (trimmed !== "") blocks.push(<p key={index}>{trimmed}</p>)
  })
  flushBullets()
  return (
    <div
      data-testid="folder-digest-body"
      className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1 text-sm leading-relaxed"
    >
      {blocks}
    </div>
  )
}
