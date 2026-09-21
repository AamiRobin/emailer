import { useEffect, useState } from "react"
import { Reply, Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import { getExecutor } from "@/services/db/executor"
import {
  generateQuickReplies,
  MAX_QUICK_REPLIES,
  type QuickRepliesResult,
} from "@/services/ai/quick-replies"
import { transformedTextToHtml } from "@/components/composer/compose-transform"
import { openQuickReplyForThread } from "./reply-opener"

/**
 * Quick-reply suggestion chips (parity-round-2 task 2.4, ai-assistance
 * spec "AI quick reply suggestions"). Rendered by the reading pane above
 * the inline-reply affordance; the surface's OWN availability gates the
 * mount — AI not configured or the quickReplies toggle off means the
 * component renders nothing (spec scenario "Surface disabled": no chips
 * appear anywhere), the same fail-toward-hidden posture as the toolbar's
 * AI affordances.
 *
 * Generation starts on mount (the surface is a latency surface by design;
 * ai_cache makes re-opening an unchanged thread free). Outcomes other than
 * a usable suggestion list render nothing — chips are an ambient
 * affordance, never an error banner. Tapping a chip opens the composer
 * prefilled as an EDITABLE reply to the sender (the shared reply-opener
 * path, the smart-reply dialog's insert semantics): the suggestion becomes
 * the draft body, and NOTHING is sent automatically (spec scenario "Use a
 * suggestion") — dispatch remains the composer's explicit send button.
 */

interface QuickReplyChipsProps {
  threadId: string
  /** The thread's OWNING account (the (YOU) marking + reply account). */
  accountId: string
  /** Disabled alongside the rest of the thread toolbar (pending action). */
  disabled?: boolean
}

/** Chip loading states: suggestions, or nothing to show. */
type Chips =
  | { stage: "loading" }
  | { stage: "ready"; replies: string[] }
  | { stage: "hidden" }

export function QuickReplyChips({
  threadId,
  accountId,
  disabled = false,
}: QuickReplyChipsProps) {
  const [chips, setChips] = useState<Chips>({ stage: "loading" })

  // Load once per thread mount. Failures of every kind (gate closed,
  // provider error, unparseable reply) collapse to "hidden" — the spec's
  // hide posture, and chips never nag. The synchronous reset is the same
  // sanctioned set-state-in-effect escape hatch the smart-reply dialog
  // uses (a thread switch must not flash the previous thread's chips).
  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChips({ stage: "loading" })
    const load = () => {
      void generateQuickReplies(getExecutor(), accountId, threadId)
        .then((result: QuickRepliesResult) => {
          if (cancelled) return
          setChips(
            result.ok && result.replies.length > 0
              ? { stage: "ready", replies: result.replies }
              : { stage: "hidden" }
          )
        })
        .catch(() => {
          if (!cancelled) setChips({ stage: "hidden" })
        })
    }
    try {
      load()
    } catch {
      // No executor (plain vite) — hidden.
      setChips({ stage: "hidden" })
    }
    return () => {
      cancelled = true
    }
  }, [threadId, accountId])

  if (chips.stage !== "ready") return null

  return (
    <div
      data-testid="quick-reply-chips"
      className="flex flex-wrap items-center gap-2 px-6 pt-1"
    >
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Sparkles className="size-3" aria-hidden />
        Quick replies
      </span>
      {chips.replies.slice(0, MAX_QUICK_REPLIES).map((reply) => (
        <Button
          key={reply}
          type="button"
          variant="outline"
          size="sm"
          className="h-7 max-w-72 rounded-full px-3 text-xs font-normal"
          disabled={disabled}
          data-testid="quick-reply-chip"
          title="Open as a draft reply"
          onClick={() => {
            try {
              void openQuickReplyForThread({
                threadId,
                replyAll: false,
                accountId,
                bodyHtml: transformedTextToHtml(reply),
              }).catch(() => {})
            } catch {
              // No executor — the chip stays; the user can retry.
            }
          }}
        >
          <Reply className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{reply}</span>
        </Button>
      ))}
    </div>
  )
}
