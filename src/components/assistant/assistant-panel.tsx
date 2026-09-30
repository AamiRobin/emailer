import { useEffect, useRef, useState } from "react"
import type { KeyboardEvent } from "react"
import { RefreshCw, Sparkles, X } from "lucide-react"

import { accountHue } from "@/components/email/account-hue"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { getExecutor } from "@/services/db/executor"
import { getThread } from "@/services/db/threads"
import { useAssistantStore } from "@/stores/assistant-store"
import { useUiStore } from "@/stores/ui-store"
import { useAssistantAvailable } from "./use-assistant-available"

/**
 * The AI assistant as a DOCKED panel (ai-assistant-panel tasks 7.1–7.3,
 * design D1 revised, spec "Assistant conversation panel"): mail-shell
 * mounts it as the trailing panel of each mailbox ResizablePanelGroup
 * (reading-pane right/bottom/hidden) while ui-store.assistantOpen is set,
 * so the thread list and reading pane stay visible and usable beside it —
 * never a modal. The three self-gating entries (the search-field Sparkles
 * button, the palette command, Cmd/Ctrl+J — design D6) only flip the
 * flag. Conversation state lives in the assistant-store (task 7.1), so
 * closing the panel — collapsing, per D1's "collapse = close" — never
 * loses the thread; reopening continues it, and the in-panel "New
 * conversation" control is the explicit reset.
 *
 * Gating (spec "Assistant gating and entry points"): the availability
 * hook is the dialog's best-effort async check (provider configured AND
 * the assistant toggle on) failing toward hidden, re-read on every open
 * so live settings edits take effect. A mid-conversation
 * `AiUnavailableError` raises the store's one-shot `unavailable` signal,
 * which closes the panel (hide-vs-show, the client's contract). Source
 * chips keep the dialog's behavior except the close (design D4, revised
 * for the dock): activating one opens the thread through
 * ui-store.setActiveThread and the panel STAYS OPEN beside it — the
 * whole point of the dock is checking the answer against the real
 * thread.
 */

/** Source chips shown at most (design D4's display cap; the full touched
 * set still feeds the next turn's read_thread allow-list). */
const MAX_SOURCE_CHIPS = 8

/** The empty state's suggested prompts (spec "Empty-state guidance");
 * activating one sends it as the user's message. */
const SUGGESTED_PROMPTS = [
  "Find my flight confirmations",
  "What did I promise in the last week?",
  "Summarize unread newsletters",
]

/** Resolved chip label for one touched thread; null = the thread is gone
 * or unreadable, and the chip degrades to a placeholder (chips are
 * garnish — never an error row). */
type ThreadTitle = { subject: string; accountId: string } | null

/**
 * The gated mount: closed or gated → nothing (the shell omits the panel
 * pair entirely; the conversation survives in the store). Open and
 * available → the body.
 */
export function AssistantPanel() {
  const open = useUiStore((state) => state.assistantOpen)
  const available = useAssistantAvailable(open)
  if (!open || !available) return null
  return <AssistantPanelBody />
}

/**
 * The panel body: a full-height column — header (title, consent line,
 * New conversation, close), the scrolling conversation, and the footer
 * (source chips, composer, ≈cost). All conversation state reads from the
 * assistant-store; this component only renders it and dispatches.
 */
function AssistantPanelBody() {
  const setAssistantOpen = useUiStore((state) => state.setAssistantOpen)
  const turns = useAssistantStore((state) => state.turns)
  const busy = useAssistantStore((state) => state.busy)
  const turnError = useAssistantStore((state) => state.turnError)
  const lastUserMessage = useAssistantStore((state) => state.lastUserMessage)
  const approxTokens = useAssistantStore((state) => state.approxTokens)
  const touchedThreadIds = useAssistantStore((state) => state.touchedThreadIds)
  const unavailable = useAssistantStore((state) => state.unavailable)
  const [draft, setDraft] = useState("")
  const [threadTitles, setThreadTitles] = useState<
    Record<string, ThreadTitle>
  >({})
  const endRef = useRef<HTMLDivElement>(null)

  function close(): void {
    setAssistantOpen(false)
  }

  function runTurn(userMessage: string): void {
    const message = userMessage.trim()
    if (message === "" || busy) return
    setDraft("")
    // A failed turn restores the draft (nothing the user typed is lost) —
    // the dialog's behavior, read back through the store's turnError. The
    // restore deliberately lives in this event-handler continuation, not
    // in an effect.
    void useAssistantStore.getState().sendTurn(message).then(() => {
      const state = useAssistantStore.getState()
      if (state.turnError !== null && state.lastUserMessage === message) {
        setDraft(message)
      }
    })
  }

  // The store consumes the AiUnavailableError signal here: hide-vs-show —
  // the panel goes away instead of showing an error, and the one-shot
  // flag is cleared so a later reopen (after re-enabling the gate) works.
  useEffect(() => {
    if (!unavailable) return
    useAssistantStore.getState().clearUnavailable()
    setAssistantOpen(false)
  }, [unavailable, setAssistantOpen])

  // The failed-turn draft restore lives in runTurn's continuation (an
  // event handler), not in an effect.


  // Source-chip subjects resolve lazily per newly-touched id through the
  // light single-row getter (design D4; small N, panel-local). Failures
  // degrade to the placeholder — chips never become an error row.
  useEffect(() => {
    const pending = touchedThreadIds.filter(
      (threadId) => threadTitles[threadId] === undefined
    )
    if (pending.length === 0) return
    let cancelled = false
    void (async () => {
      const resolved = await Promise.all(
        pending.map(async (threadId) => {
          try {
            const thread = await getThread(getExecutor(), threadId)
            const subject = thread?.subject?.trim()
            return [
              threadId,
              thread && subject
                ? { subject, accountId: thread.account_id }
                : null,
            ] as const
          } catch {
            return [threadId, null] as const
          }
        })
      )
      if (cancelled) return
      setThreadTitles((previous) => {
        const next = { ...previous }
        for (const [threadId, title] of resolved) next[threadId] = title
        return next
      })
    })()
    return () => {
      cancelled = true
    }
  }, [touchedThreadIds, threadTitles])

  // Newest turn at the bottom: keep the end sentinel in view after every
  // conversation change (turns, busy, error).
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [turns, busy, turnError])

  // Enter submits; Shift+Enter is the newline (the chat-input convention).
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      runTurn(draft)
    }
  }

  const empty = turns.length === 0
  const lastTurnIndex = turns.length - 1

  return (
    <div
      data-testid="assistant-panel"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      {/* Header: identity + consent line, the New-conversation reset
          (spec "New conversation control"; disabled mid-turn) and the
          close (collapse = close, design D1). */}
      <div className="flex items-start justify-between gap-2 border-b px-3 py-2.5">
        <div className="flex min-w-0 items-start gap-2">
          <Sparkles
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-5">AI assistant</h2>
            <p className="text-xs text-muted-foreground">
              Answers are generated from your mailbox with read-only
              lookups. Nothing is changed.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="assistant-new-conversation"
            disabled={busy}
            onClick={() => useAssistantStore.getState().resetConversation()}
          >
            New conversation
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Close assistant"
            data-testid="assistant-close"
            onClick={close}
          >
            <X aria-hidden />
          </Button>
        </div>
      </div>

      {/* The conversation (auto-scrolls to the newest turn). */}
      <div
        data-testid="assistant-conversation"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
      >
        {empty && !busy && (
          <div
            data-testid="assistant-empty"
            className="flex flex-col gap-3 py-4"
          >
            <p className="text-center text-sm text-muted-foreground">
              Ask about your mailbox — e.g. "find all my flight
              confirmations".
            </p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  data-testid="assistant-prompt-chip"
                  onClick={() => runTurn(prompt)}
                  className="rounded-full border bg-muted/40 px-2.5 py-1 text-xs text-foreground hover:bg-accent"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((turn, index) =>
          turn.role === "user" ? (
            <p
              key={index}
              data-testid="assistant-user-turn"
              className="ms-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap"
            >
              {turn.content}
            </p>
          ) : (
            <div key={index} className="flex flex-col gap-1">
              <p
                data-testid="assistant-answer-turn"
                className="max-w-[85%] text-sm whitespace-pre-wrap"
              >
                {turn.content}
              </p>
              {turn.toolRounds > 0 && (
                <p
                  data-testid="assistant-tool-activity"
                  className="text-xs text-muted-foreground"
                >
                  Searched the mailbox (
                  {turn.toolRounds}{" "}
                  {turn.toolRounds === 1 ? "lookup" : "lookups"})
                </p>
              )}
              {/* Regenerate (spec "Regeneration"): offered on the newest
                  answer only — regenerateLast re-runs the LAST user
                  message, so a button on an older answer would lie. */}
              {index === lastTurnIndex && !busy && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="self-start text-muted-foreground"
                  data-testid="assistant-regenerate"
                  onClick={() =>
                    void useAssistantStore.getState().regenerateLast()
                  }
                >
                  <RefreshCw aria-hidden />
                  Regenerate
                </Button>
              )}
            </div>
          )
        )}
        {busy && (
          <p
            role="status"
            data-testid="assistant-busy"
            className="text-sm text-muted-foreground"
          >
            Looking in your mailbox…
          </p>
        )}
        {turnError && lastUserMessage && (
          <div
            role="alert"
            data-testid="assistant-error"
            className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-sm text-destructive"
          >
            <span>{turnError}</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="self-start"
              disabled={busy}
              onClick={() => runTurn(lastUserMessage)}
            >
              Retry
            </Button>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Footer: the source chips (design D4 — activating one opens the
          thread beside the open panel), then the composer and the ≈cost
          line (chars/4 accumulation — an honest estimate label, not a
          read-back). */}
      <form
        className="flex flex-col gap-2 border-t px-3 py-2.5"
        onSubmit={(event) => {
          event.preventDefault()
          runTurn(draft)
        }}
      >
        {touchedThreadIds.length > 0 && (
          <div data-testid="assistant-sources" className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              Sources
            </p>
            <div className="flex flex-wrap gap-1.5">
              {touchedThreadIds.slice(0, MAX_SOURCE_CHIPS).map((threadId) => {
                const title = threadTitles[threadId]
                return (
                  <button
                    key={threadId}
                    type="button"
                    data-testid="assistant-source-chip"
                    onClick={() =>
                      useUiStore.getState().setActiveThread(threadId)
                    }
                    className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-xs text-foreground hover:bg-accent"
                  >
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      // Data-derived color exception (the account-badge
                      // rule): the hue is the thread's account identity.
                      style={{
                        backgroundColor: `hsl(${accountHue(title?.accountId ?? threadId)} 55% 50%)`,
                      }}
                    />
                    <span className="max-w-48 truncate">
                      {title?.subject ?? "(no subject)"}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
        <Textarea
          data-testid="assistant-input"
          aria-label="Message the assistant"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your mailbox…"
          rows={2}
          disabled={busy}
        />
        <div className="flex items-center justify-between gap-2">
          <p
            data-testid="assistant-token-cost"
            className="text-xs text-muted-foreground"
          >
            ≈ {approxTokens} tokens
          </p>
          <Button
            type="submit"
            size="sm"
            disabled={busy || draft.trim() === ""}
          >
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>
      </form>
    </div>
  )
}
