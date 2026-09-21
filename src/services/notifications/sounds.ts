import { getExecutor, type SqlExecutor } from "../db/executor"
import {
  getNewMailSoundEnabled,
  getSentSoundEnabled,
} from "../settings/preferences"

/**
 * Notification sounds (task 1.5, settings spec, design D12): short
 * WebAudio-SYNTHESIZED chimes — no bundled audio assets, no new
 * dependencies. Two events have a sound:
 *
 * - new mail: requested by the new-mail notifier AFTER its gates passed
 *   and the OS notification was actually handed over, so a message
 *   matching a "never notify" rule, a muted thread, a disabled
 *   notifications setting or a missing permission produces neither banner
 *   nor sound — the sound can never announce something the banner did
 *   not.
 * - sent confirmation: requested by the send flow when a send was
 *   accepted and NOT parked offline-queued (the offline path toasts
 *   "Message queued", which is not a sent confirmation).
 *
 * Autoplay hygiene (design D12): the AudioContext is created lazily on
 * the first play — never at module load — and a context the webview has
 * suspended (no prior user gesture in the session) only triggers a
 * best-effort resume; if the webview refuses, the play is silently
 * dropped. NOTHING in this module throws into the notification or send
 * path: every failure (no AudioContext, no database, an unsupported
 * browser) degrades to "no sound".
 */

let ctx: AudioContext | null = null

/**
 * Lazily create the shared AudioContext. Returns null when the runtime
 * has no WebAudio (plain jsdom, exotic webviews) — the caller then skips
 * the play. A suspended context (autoplay policy) is resumed
 * best-effort; the current play may still be silent, later ones recover
 * on their own.
 */
function ensureContext(): AudioContext | null {
  try {
    if (typeof AudioContext === "undefined") return null
    ctx ??= new AudioContext()
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {
        // Refused (no user gesture yet) — this play stays silent.
      })
    }
    return ctx
  } catch {
    return null
  }
}

/** One struck bell partial: a decaying sine at `frequency`. A chime is
 * two or three of these a few ms apart — cheap, asset-free, and short
 * (well under a second) by construction. */
function strike(context: AudioContext, frequency: number, at: number): void {
  const osc = context.createOscillator()
  const gain = context.createGain()
  osc.type = "sine"
  osc.frequency.setValueAtTime(frequency, context.currentTime + at)
  // Fast attack, exponential ~300ms decay: reads as a chime, not a beep.
  gain.gain.setValueAtTime(0, context.currentTime + at)
  gain.gain.linearRampToValueAtTime(0.18, context.currentTime + at + 0.012)
  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    context.currentTime + at + 0.35
  )
  osc.connect(gain)
  gain.connect(context.destination)
  osc.start(context.currentTime + at)
  osc.stop(context.currentTime + at + 0.4)
}

/** Play the two-note rising chime for new mail. */
function playNewMailChime(context: AudioContext): void {
  strike(context, 880, 0)
  strike(context, 1174.66, 0.14) // D6 — a small perfect-fourth lift
}

/** Play the softer falling pair for a sent confirmation. */
function playSentChime(context: AudioContext): void {
  strike(context, 987.77, 0) // B5
  strike(context, 659.25, 0.12) // E5 — resolved, "done"
}

/**
 * The shared play attempt: consult `enabled` (a settings read), then
 * synthesize. Never throws and never rejects — the notification and send
 * paths call this fire-and-forget (`void play…Sound()`).
 */
async function playIfEnabled(
  enabled: (executor: SqlExecutor) => Promise<boolean>,
  chime: (context: AudioContext) => void
): Promise<void> {
  try {
    if (!(await enabled(getExecutor()))) return
    const context = ensureContext()
    if (!context || context.state === "closed") return
    chime(context)
  } catch {
    // No executor (plain vite outside Tauri), a failed settings read or a
    // dead AudioContext: the event itself is unaffected — stay silent.
  }
}

/** Play the new-mail chime when the new-mail sound toggle is on. */
export function playNewMailSound(): Promise<void> {
  return playIfEnabled(getNewMailSoundEnabled, playNewMailChime)
}

/** Play the sent-confirmation chime when the sent sound toggle is on. */
export function playSentSound(): Promise<void> {
  return playIfEnabled(getSentSoundEnabled, playSentChime)
}

/** Drop the memoized AudioContext (tests only — the memo must not leak
 * fake contexts between test files). */
export function resetSoundsForTests(): void {
  ctx = null
}
