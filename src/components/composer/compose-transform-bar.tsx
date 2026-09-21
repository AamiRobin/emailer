import { Button } from "@/components/ui/button"

/**
 * The pending-replacement bar for the composer's AI offers (task 4.6,
 * ai-assistance spec "Compose text transform"; batch C3 generalizes it to
 * the prompt-drafted and generated-reply offers, which ride the SAME
 * accept/discard/retry flow): the inline banner between toolbar and body
 * that carries an offer from invoke to resolution — "<label>…" while the
 * request runs, Accept/Discard once a result is ready, and the specific
 * provider error with Retry on failure. Presentational only: the composer
 * owns the pending state (component state, not composer-store — a pending
 * replacement is transient UI, not draft data). The draft stays fully
 * editable underneath; the bar never blocks it. Styling follows the
 * undo-send-banner pattern (status bar, xs actions).
 */

export type ComposeTransformStatus = "transforming" | "ready" | "error"

interface ComposeTransformBarProps {
  /** Display name of the running offer ("Improve writing", "Draft from
   * prompt", …) — the composer owns the mapping. */
  label: string
  status: ComposeTransformStatus
  /** The sanitized provider failure for status "error". */
  error: string | null
  onAccept: () => void
  onDiscard: () => void
  onRetry: () => void
}

export function ComposeTransformBar({
  label,
  status,
  error,
  onAccept,
  onDiscard,
  onRetry,
}: ComposeTransformBarProps) {
  return (
    <div
      role="status"
      data-testid="compose-transform-bar"
      className="flex flex-wrap items-center gap-2 bg-muted/60 px-4 py-1.5 text-sm text-foreground"
    >
      {status === "transforming" ? (
        <span className="text-muted-foreground">{label} — transforming…</span>
      ) : null}
      {status === "ready" ? (
        <>
          <span className="min-w-0 truncate text-muted-foreground">
            Replacement ready. Your text is unchanged until you accept.
          </span>
          <Button size="xs" onClick={onAccept}>
            Accept
          </Button>
        </>
      ) : null}
      {status === "error" ? (
        <>
          <span role="alert" className="min-w-0 flex-1 truncate text-destructive">
            {error}
          </span>
          <Button size="xs" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </>
      ) : null}
      <Button
        size="xs"
        variant="outline"
        className="ms-auto"
        onClick={onDiscard}
      >
        Discard
      </Button>
    </div>
  )
}
