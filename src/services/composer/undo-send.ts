import {
  sendComposerDraft,
  type SendComposerDraftArgs,
  type SendComposerDraftResult,
} from "./send"

/**
 * Undo send (design D3, tasks 5.1/5.2): the PRE-send cancellation window.
 * The composer's Send click starts a cancellable timer that only then
 * performs the normal send — during the window nothing has been
 * transmitted and nothing is queued (pending_operations replays ACCEPTED
 * work, so it stays out of this), and cancelling simply drops the intent.
 * On expiry the real sendComposerDraft runs, which is the single choke
 * point both provider paths drain from (the Gmail REST and IMAP/SMTP
 * transmitters replay the queued op), so one delay covers both. If the
 * app closes mid-window the send is lost — accepted per design; the
 * autosaved local_drafts row survives for a manual resend.
 *
 * The window length is the per-account preference
 * `mail.sendDelaySeconds:<accountId>` (preferences.ts
 * getSendDelaySeconds / setSendDelaySecondsPreference — the settings-UI
 * control is a later task; persist + read live there). Unset defaults to
 * 10s, values clamp to 5–30s, and 0 disables the window entirely
 * (immediate send).
 *
 * The composer store (composer-store.ts) drives this module: it starts
 * the window, counts the banner countdown down, and restores the draft on
 * cancelUndoSend. Tests substitute the send through the seam below
 * instead of mocking modules.
 */

/** Undo-window bounds in seconds (spec: user-configurable 5–30). */
export const MIN_SEND_DELAY_SECONDS = 5
export const MAX_SEND_DELAY_SECONDS = 30
export const DEFAULT_SEND_DELAY_SECONDS = 10

/**
 * Normalize a raw undo-send delay: 0 (or negative) passes through as the
 * explicit opt-out, non-finite values fall back to the default, and
 * everything else rounds into the 5–30s window.
 */
export function clampSendDelaySeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SEND_DELAY_SECONDS
  }
  if (value <= 0) return 0
  return Math.min(
    MAX_SEND_DELAY_SECONDS,
    Math.max(MIN_SEND_DELAY_SECONDS, Math.round(value))
  )
}

// ---------------------------------------------------------------------------
// Test seam: substitute the provider send without mocking modules (same
// pattern as the scheduler's setSyncAccountImplForTests).
// ---------------------------------------------------------------------------

type SendComposerDraftImpl = (
  args: SendComposerDraftArgs
) => Promise<SendComposerDraftResult>

let sendComposerDraftImpl: SendComposerDraftImpl = sendComposerDraft

/**
 * Replace the send the window fires on expiry (tests). Pass null to
 * restore the real one.
 */
export function setSendComposerDraftImplForTests(
  impl: SendComposerDraftImpl | null
): void {
  sendComposerDraftImpl = impl ?? sendComposerDraft
}

/** What the composer store holds while the window runs. */
export interface UndoSendController {
  /** The clamped window length the send was scheduled against. */
  totalSeconds: number
  /** Abort before expiry: the provider send never happens. True when a
   * pending window was actually cancelled (false after expiry, after a
   * prior cancel, or when disabled). */
  cancel: () => boolean
  /** Fire the pending send NOW, through the exact same invoke path the
   * expiry uses (supersede support): a window replaced by a newer one is
   * transmitted immediately instead of being silently dropped. No-op
   * once the send already fired or the window was cancelled. */
  flush: () => void
  /** True once the provider send has been INVOKED (timer fired, flush
   * ran, or the window was disabled from the start). cancelUndoSend
   * consults this: after the expiry fired, the send is in flight and
   * commits — a late cancel must be refused, not restore the snapshot
   * for a message that is about to exist. */
  hasFired: () => boolean
  /** Resolves with the real send result on expiry (or flush); null when
   * the window was cancelled before expiry or the send impl rejected
   * unexpectedly. With a delay of 0 this is just the immediate send's
   * result. */
  result: Promise<SendComposerDraftResult | null>
}

/**
 * The cancellable pre-send delay itself (task 5.1): schedules the send
 * `delaySeconds` out (clamped; 0 sends immediately, skipping the window)
 * and hands back a controller so the window can still be cancelled. The
 * provider send is NOT invoked until expiry — that is the invariant the
 * fake-timer service test pins.
 */
export function sendWithUndoDelay(
  args: SendComposerDraftArgs & { delaySeconds: number }
): UndoSendController {
  const totalSeconds = clampSendDelaySeconds(args.delaySeconds)
  const sendArgs: SendComposerDraftArgs = {
    accountId: args.accountId,
    payload: args.payload,
    ...(args.draftId !== undefined ? { draftId: args.draftId } : {}),
    ...(args.draftKey !== undefined ? { draftKey: args.draftKey } : {}),
    ...(args.executor !== undefined ? { executor: args.executor } : {}),
    ...(args.mode !== undefined ? { mode: args.mode } : {}),
    // Task 18.5: the per-message PGP intent (mode + the per-use
    // passphrase the composer collected) MUST ride the frozen args — the
    // expiry fires them, and the passphrase exists only in memory.
    ...(args.pgp !== undefined ? { pgp: args.pgp } : {}),
    // Task 16.2: the alias From identity rides too (same reason as `pgp`
    // above) — an undo-window expiry re-enters sendComposerDraft, and
    // without it the delayed send would silently lose the alias an
    // immediate send carries. Null is a meaningful value (the bare
    // account identity) and is carried as well.
    ...(args.fromAlias !== undefined ? { fromAlias: args.fromAlias } : {}),
  }

  // Disabled window: the send is "accepted" right away, exactly like a
  // sendComposerDraft call without undo send.
  if (totalSeconds <= 0) {
    return {
      totalSeconds: 0,
      cancel: () => false,
      flush: () => {},
      hasFired: () => true,
      result: sendComposerDraftImpl(sendArgs).catch(() => null),
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  let fired = false
  let cancelled = false
  let resolveResult: (value: SendComposerDraftResult | null) => void = () => {}
  const result = new Promise<SendComposerDraftResult | null>((resolve) => {
    resolveResult = resolve
  })
  // The single invoke path, shared by the expiry timer and flush(): the
  // send runs exactly once per controller, whatever triggers it.
  const fire = (): void => {
    if (fired || cancelled) return
    fired = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    // sendComposerDraft resolves typed results for validation and
    // local-write failures; only a truly unexpected rejection (e.g.
    // the account row vanished mid-window) lands here, resolving
    // null so the window still closes.
    void sendComposerDraftImpl(sendArgs).then(resolveResult, () =>
      resolveResult(null)
    )
  }
  timer = setTimeout(fire, totalSeconds * 1000)
  return {
    totalSeconds,
    cancel: () => {
      if (fired || cancelled || timer === null) return false
      cancelled = true
      clearTimeout(timer)
      timer = null
      resolveResult(null)
      return true
    },
    flush: fire,
    hasFired: () => fired,
    result,
  }
}
