import { create } from "zustand"

import { runAssistantTurn } from "@/services/ai/assistant"
import {
  AiUnavailableError,
  type AiChatMessage,
} from "@/services/ai/client"
import { getExecutor } from "@/services/db/executor"

/**
 * Assistant conversation store (ai-assistant-panel tasks 7.1, design D1 —
 * revised): the multi-turn working memory of the docked assistant panel.
 * The panel itself is mounted/unmounted with ui-store.assistantOpen (the
 * mailbox panel groups render it only while open), so this store is what
 * makes the conversation PERSIST across open/close for the app session —
 * and across layout remounts (reading-pane mode changes, view switches) —
 * without any DOM persistence. Deliberately NOT persisted further: an app
 * restart resets everything (no table; unchanged Non-Goal), and the
 * explicit in-panel "New conversation" control (resetConversation) is the
 * user-facing fresh start.
 *
 * The store is pure conversation state — the AI gating (isAiConfigured +
 * isSurfaceEnabled) stays in the panel component where the other UI gates
 * live — and it owns the exact turn-commit contract the dialog used to
 * carry (tasks 4.1, design D2/D4): one send runs one `runAssistantTurn`
 * turn against the CURRENT wire history and touched-thread set; a
 * successful turn commits everything at once (the display turns, the wire
 * history, the union of the tool-surfaced thread ids in first-surfaced
 * order, the accumulated ≈cost); a provider failure commits NOTHING and
 * only records `turnError` — the failed turn is retryable (Retry re-sends
 * `lastUserMessage` against the unchanged history); an
 * `AiUnavailableError` instead raises `unavailable`, which the panel
 * consumes to close itself (the client's hide-vs-show contract).
 *
 * Executor acquisition is per call (getExecutor()), matching every other
 * caller — tests mock the executor and the turn service.
 */

/** How the conversation renders one turn (carried over from the dialog).
 * Tool activity is a display garnish on the answer turn — the wire
 * history never carries it. */
export type DisplayTurn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolRounds: number }

/** Fallback message when a non-Error rejection surfaces (the dialog's
 * rendering). */
const PROVIDER_ERROR_FALLBACK = "The AI provider could not be reached."

interface AssistantConversationState {
  /** The displayed conversation, oldest first. */
  turns: DisplayTurn[]
  /** The multi-turn wire history the next turn extends (user/assistant
   * pairs, parallel to `turns`). */
  wireHistory: AiChatMessage[]
  /** Every thread id the tools surfaced this conversation, in
   * first-surfaced order — the source chips and read_thread's cross-turn
   * allow-list (design D4). */
  touchedThreadIds: string[]
  /** Accumulated ≈cost of the open conversation (chars/4, design D4). */
  approxTokens: number
  /** True while a turn is in flight (send or regenerate). */
  busy: boolean
  /** Provider-error text shown inline by the panel; null = no failure.
   * A failed turn committed nothing, so Retry simply re-sends
   * `lastUserMessage`. */
  turnError: string | null
  /** The most recent message a send was attempted with (the Retry
   * target, set before the turn runs). */
  lastUserMessage: string | null
  /** Set when a turn throws AiUnavailableError — the gate closed
   * mid-conversation. The panel consumes it (closes itself, then clears
   * it); the store never renders, so this is a one-shot signal. */
  unavailable: boolean
  /** Run one user turn (design D2). Empty messages and concurrent sends
   * are no-ops. */
  sendTurn: (message: string) => Promise<void>
  /** Re-run the LAST user message against the history BEFORE it (spec
   * "Regeneration"): drops the last user+assistant pair, then re-sends
   * the same message. No-op with no turns or while busy. */
  regenerateLast: () => Promise<void>
  /** The in-panel "New conversation" control: clears everything,
   * including any in-flight failure state. */
  resetConversation: () => void
  /** Panel-side consumption of the `unavailable` signal (after closing
   * itself) — clearing it here keeps reopen-after-re-enable working. */
  clearUnavailable: () => void
}

export const useAssistantStore = create<AssistantConversationState>(
  (set, get) => ({
    turns: [],
    wireHistory: [],
    touchedThreadIds: [],
    approxTokens: 0,
    busy: false,
    turnError: null,
    lastUserMessage: null,
    unavailable: false,

    sendTurn: async (message) => {
      const trimmed = message.trim()
      if (trimmed === "" || get().busy) return
      set({ busy: true, turnError: null, lastUserMessage: trimmed })
      try {
        const result = await runAssistantTurn(
          getExecutor(),
          get().wireHistory,
          trimmed,
          { touchedThreadIds: get().touchedThreadIds }
        )
        set((state) => ({
          turns: [
            ...state.turns,
            { role: "user", content: trimmed },
            {
              role: "assistant",
              content: result.answer,
              toolRounds: result.toolRounds,
            },
          ],
          wireHistory: [
            ...state.wireHistory,
            { role: "user", content: trimmed },
            { role: "assistant", content: result.answer },
          ],
          // The touched set grows in first-surfaced order (design D4) —
          // the source chips render from it and the next turn feeds it
          // back as read_thread's cross-turn allow-list.
          touchedThreadIds: (() => {
            const next = [...state.touchedThreadIds]
            for (const threadId of result.touchedThreadIds) {
              if (!next.includes(threadId)) next.push(threadId)
            }
            return next
          })(),
          approxTokens: state.approxTokens + result.approxTokens,
          busy: false,
        }))
      } catch (caught) {
        if (caught instanceof AiUnavailableError) {
          // Hide-vs-show (the client's contract): the gate closed
          // mid-conversation — the panel goes away instead of showing an
          // error. Nothing was committed.
          set({ busy: false, unavailable: true })
          return
        }
        // Provider failure (and anything unexpected): inline + Retry, the
        // ask-inbox rendering. A failed turn commits nothing — the
        // history it re-runs against (via Retry) is unchanged.
        set({
          busy: false,
          turnError:
            caught instanceof Error
              ? caught.message
              : PROVIDER_ERROR_FALLBACK,
        })
      }
    },

    regenerateLast: async () => {
      const state = get()
      if (state.busy || state.turns.length === 0) return
      // wireHistory parallels turns (one user+assistant pair each), so
      // dropping the display pair drops exactly its wire messages.
      let lastUserIndex = -1
      for (let index = state.turns.length - 1; index >= 0; index -= 1) {
        if (state.turns[index]!.role === "user") {
          lastUserIndex = index
          break
        }
      }
      if (lastUserIndex === -1) return
      const userMessage = state.turns[lastUserIndex]!
      if (userMessage.role !== "user") return
      set({
        turns: state.turns.slice(0, lastUserIndex),
        wireHistory: state.wireHistory.slice(0, lastUserIndex),
        turnError: null,
      })
      await get().sendTurn(userMessage.content)
    },

    resetConversation: () => {
      set({
        turns: [],
        wireHistory: [],
        touchedThreadIds: [],
        approxTokens: 0,
        busy: false,
        turnError: null,
        lastUserMessage: null,
        unavailable: false,
      })
    },

    clearUnavailable: () => {
      set({ unavailable: false })
    },
  })
)
