import { useCallback, useEffect, useRef, useState } from "react"

import type { SqlExecutor } from "../db/executor"
import type { DraftInput } from "./drafts"
import { isDraftEmpty, saveDraft } from "./drafts"

/**
 * useDraftAutosave (task 8.6): the one-line draft auto-save the composer
 * integration calls —
 *
 *   const draftKey = useMemo(() => crypto.randomUUID(), []) // per open
 *   const { lastSavedAt } = useDraftAutosave({
 *     accountId,
 *     draftKey,
 *     getDraftInput: () => {
 *       const composer = composerStore.getState() // your state holder
 *       return {
 *         to: composer.to,
 *         cc: composer.cc,
 *         bcc: composer.bcc,
 *         subject: composer.subject,
 *         bodyHtml: composer.html,
 *         inReplyTo: composer.mode.inReplyTo,
 *         threadId: composer.mode.threadId,
 *       }
 *     },
 *     executor: getExecutor(),
 *   })
 *
 * Behavior:
 *   - Changes are detected by diffing a JSON snapshot of getDraftInput()
 *     (cheap string compare) on a short poll, so the hook works no matter
 *     how the composer state is held; a change re-arms a
 *     DRAFT_AUTOSAVE_DEBOUNCE_MS (3s) timer, and only a quiet period
 *     writes — rapid typing produces exactly one save.
 *   - Empty snapshots (no recipients, subject, body or attachments —
 *     see isDraftEmpty) are never saved. Choice: an empty snapshot after
 *     content existed only skips the save; it does NOT delete the prior
 *     row — explicit user intent (discard confirm) owns deletion via
 *     deleteDraft, so a stray select-all-delete can't silently destroy
 *     the resume copy.
 *   - A snapshot that changed and changed back to the last saved state
 *     within the window is not re-saved.
 *   - A restored draft (resume from Drafts) is not rewritten until the
 *     user actually edits something — the first observation only primes
 *     the diff baseline.
 *   - Cleanup (unmount or account/draftKey/enabled change) flushes the
 *     last observed pending snapshot. It writes the observed snapshot
 *     rather than re-reading, so a key switch can never file the new
 *     composer's content under the old draft key. Call saveNow()
 *     explicitly on close/discard flows when you need zero poll lag.
 *   - A failed save stays dirty and retries after the debounce window.
 *
 * The service half (saveDraft/deleteDraft/listDrafts and the full
 * lifecycle recipe: open → uuid key, autosave, send/discard →
 * deleteDraft, Drafts folder → listDrafts/getDraft) lives in
 * ./drafts.ts.
 */

/** Quiet period after the last observed change before a save fires. */
export const DRAFT_AUTOSAVE_DEBOUNCE_MS = 3000

/** How often the draft snapshot is diffed for changes. */
export const DRAFT_AUTOSAVE_POLL_INTERVAL_MS = 1000

export interface UseDraftAutosaveArgs {
  accountId: string
  /** Stable key for this open composer: crypto.randomUUID() at open, or
   * the resumed row's draftKey. Swapping it flushes the previous draft. */
  draftKey: string
  /** Reads the current composer snapshot. Called on the poll interval —
   * keep it a cheap read of already-loaded state, never a query. */
  getDraftInput: () => DraftInput
  /** Pass getExecutor() in production; tests pass the node:sqlite one. */
  executor: SqlExecutor
  /** When false nothing is polled or saved; flipping it off flushes. */
  enabled?: boolean
}

export interface DraftAutosave {
  /** Unix seconds of the last successful save; null until one happens. */
  lastSavedAt: number | null
  /** Write immediately (Ctrl+S, explicit close paths). No-op when the
   * snapshot is empty or identical to the last saved one. */
  saveNow: () => Promise<void>
  /** Write the last observed pending snapshot (pre-close/pagehide) —
   * at most one poll interval behind the user's latest keystroke. */
  flush: () => Promise<void>
}

/** Everything one autosave instance needs, frozen per subscription. */
interface AutosaveTarget {
  executor: SqlExecutor
  accountId: string
  draftKey: string
  getDraftInput: () => DraftInput
}

export function useDraftAutosave(args: UseDraftAutosaveArgs): DraftAutosave {
  const { accountId, draftKey, enabled = true } = args
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)

  // latest-ref pattern: timer callbacks read the current closures without
  // re-subscribing the poll on every render
  const argsRef = useRef(args)
  useEffect(() => {
    argsRef.current = args
  })

  const lastSeenJsonRef = useRef<string | null>(null)
  const lastSeenInputRef = useRef<DraftInput | null>(null)
  const lastSavedJsonRef = useRef<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // serialize writes so overlapping saves can't complete out of order
  const writeChainRef = useRef<Promise<void>>(Promise.resolve())
  const disposedRef = useRef(false)

  const clearDebounce = useCallback(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [])

  // writeInput recurses (failure retry) through this ref — the callback
  // below stays a stable identity while the retry always calls the latest
  const writeInputRef = useRef<
    ((target: AutosaveTarget, input: DraftInput) => Promise<void>) | null
  >(null)

  const writeInput = useCallback(
    (target: AutosaveTarget, input: DraftInput): Promise<void> => {
      if (isDraftEmpty(input)) return Promise.resolve() // never save empty
      const json = JSON.stringify(input)
      if (json === lastSavedJsonRef.current) return Promise.resolve()
      const write = writeChainRef.current.then(async () => {
        // re-check against the now-serialized state
        if (json === lastSavedJsonRef.current) return
        try {
          const saved = await saveDraft(target.executor, {
            accountId: target.accountId,
            draftKey: target.draftKey,
            draft: input,
          })
          lastSavedJsonRef.current = json
          if (!disposedRef.current) setLastSavedAt(saved.updatedAt)
        } catch {
          // stay dirty; retry after another quiet period. Any newly
          // observed change clears this timer and schedules a fresh write.
          clearDebounce()
          debounceRef.current = setTimeout(() => {
            debounceRef.current = null
            void writeInputRef.current?.(target, input)
          }, DRAFT_AUTOSAVE_DEBOUNCE_MS)
        }
      })
      // never leave an unhandled rejection on the chain
      writeChainRef.current = write.catch(() => undefined)
      return write
    },
    [clearDebounce]
  )

  useEffect(() => {
    writeInputRef.current = writeInput
  })

  const saveNow = useCallback((): Promise<void> => {
    clearDebounce()
    let input: DraftInput
    try {
      input = argsRef.current.getDraftInput()
    } catch {
      return Promise.resolve()
    }
    return writeInput(argsRef.current, input)
  }, [clearDebounce, writeInput])

  const flush = useCallback((): Promise<void> => {
    clearDebounce()
    const snapshot = lastSeenInputRef.current
    if (!snapshot) return Promise.resolve()
    return writeInput(argsRef.current, snapshot)
  }, [clearDebounce, writeInput])

  useEffect(() => {
    if (!enabled) return
    disposedRef.current = false

    // fresh bookkeeping per subscription; a resumed draft is treated as
    // already saved so it is not rewritten untouched
    lastSeenJsonRef.current = null
    lastSeenInputRef.current = null
    lastSavedJsonRef.current = null

    const target: AutosaveTarget = {
      executor: argsRef.current.executor,
      accountId,
      draftKey,
      getDraftInput: argsRef.current.getDraftInput,
    }

    const poll = (): void => {
      let input: DraftInput
      try {
        input = target.getDraftInput()
      } catch {
        return // transient read error; try again next tick
      }
      const json = JSON.stringify(input)
      if (json === lastSeenJsonRef.current) return
      const firstObservation = lastSeenJsonRef.current === null
      lastSeenJsonRef.current = json
      lastSeenInputRef.current = input
      if (firstObservation) return
      clearDebounce()
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        void writeInput(target, input)
      }, DRAFT_AUTOSAVE_DEBOUNCE_MS)
    }

    const interval = setInterval(poll, DRAFT_AUTOSAVE_POLL_INTERVAL_MS)
    return () => {
      disposedRef.current = true
      clearInterval(interval)
      // flush the last observed pending snapshot (never a fresh read:
      // the input closures may already belong to the next draft)
      const snapshot = lastSeenInputRef.current
      if (snapshot) void writeInput(target, snapshot)
    }
  }, [accountId, draftKey, enabled, clearDebounce, writeInput])

  return { lastSavedAt, saveNow, flush }
}
