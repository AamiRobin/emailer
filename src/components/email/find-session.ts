import { createContext } from "react"

/**
 * Find-in-message coordination (task 1.1, design D5): the shell-side half
 * of the sandboxed-frame search protocol. The DOM work happens INSIDE each
 * frame (the shell cannot — and must not — mirror the mail document), so
 * this module only routes commands and aggregates what frames report:
 *
 * - Each expanded message renders a SafeEmailFrame that registers a handle
 *   here on mount (insertion order = document order) and reports its match
 *   count for every search.
 * - The shell sums per-frame counts into a global total and owns ONE
 *   global active-match index; next/previous wrap across frames by
 *   addressing the owning frame with a local index (the rest get -1 =
 *   "no active match").
 * - Collapsed messages never mount a body frame, so they are never
 *   searched; the reading pane counts them ("N in collapsed messages")
 *   via setCollapsedCount. Composed reply areas and notes live in the
 *   shell DOM outside any frame, so they are excluded by construction.
 *
 * The session is a plain observable class (not a store) because its
 * consumers are split: the FindBar subscribes via useSyncExternalStore,
 * while the frames only need the stable command surface. One session per
 * ThreadView mount — a thread switch throws it away (highlights live in
 * the unmounting frames), which is exactly the spec's clean close.
 */

/** Parent → frame command (via the frame's contentWindow.postMessage). */
export const EMAILER_FIND_COMMAND_TYPE = "emailer-find-command"

/** Frame → parent report (validated against event.source, like resize). */
export const EMAILER_FIND_STATE_TYPE = "emailer-find-state"

/** Frame → parent: the in-frame Ctrl/Cmd+F keydown (keydowns inside a
 * cross-origin frame never reach the shell's listener, so the frame asks
 * the shell to open the find bar itself). */
export const EMAILER_FIND_OPEN_TYPE = "emailer-find-open-request"

/** Frame → parent: Escape pressed inside the frame (forwarded
 * unconditionally — the shell's Esc path is idempotent) — the shell closes
 * the bar and the next broadcast clears the marks. */
export const EMAILER_FIND_ESCAPE_TYPE = "emailer-find-escape-request"

/** Attribute on every highlight <mark>; the active one also carries the
 * active attribute (both styled by the frame document's injected CSS). */
export const EMAILER_FIND_MARK_ATTR = "data-emailer-find"
export const EMAILER_FIND_ACTIVE_ATTR = "data-emailer-find-active"

/**
 * Per-frame highlight cap (task 1.1): pathological mail could otherwise
 * wrap itself to death on a common term. The reference caps at 2000 too
 * (`find` in renderer/interaction.rs) — the count simply stops growing and
 * navigation works over the capped set.
 */
export const MAX_FIND_MATCHES = 2000

/** One parent → frame command. `seq` orders the conversation: frames and
 * the session both drop everything from an older search round. */
export interface FindFrameCommand {
  type: typeof EMAILER_FIND_COMMAND_TYPE
  seq: number
  action: "search" | "activate" | "clear"
  /** "search" only: the raw term ("" = clear highlights). */
  term?: string
  /** "activate" only: the local 0-based match index, -1 = none. */
  index?: number
}

/** One frame → parent report. */
export interface FindFrameState {
  type: typeof EMAILER_FIND_STATE_TYPE
  seq: number
  /** Highlighted matches currently in the frame (after the cap). */
  count: number
  /** Active match index, -1 when none. */
  active: number
}

/** Frame → parent key requests (Ctrl/Cmd+F and Escape inside the frame). */
export type FindFrameRequest =
  | { type: typeof EMAILER_FIND_OPEN_TYPE }
  | { type: typeof EMAILER_FIND_ESCAPE_TYPE }

export function isFindFrameState(data: unknown): data is FindFrameState {
  if (typeof data !== "object" || data === null) return false
  const message = data as {
    type?: unknown
    seq?: unknown
    count?: unknown
    active?: unknown
  }
  return (
    message.type === EMAILER_FIND_STATE_TYPE &&
    typeof message.seq === "number" &&
    Number.isFinite(message.seq) &&
    typeof message.count === "number" &&
    Number.isFinite(message.count) &&
    typeof message.active === "number" &&
    Number.isFinite(message.active)
  )
}

export function isFindFrameRequest(data: unknown): data is FindFrameRequest {
  if (typeof data !== "object" || data === null) return false
  const type = (data as { type?: unknown }).type
  return type === EMAILER_FIND_OPEN_TYPE || type === EMAILER_FIND_ESCAPE_TYPE
}

/** What the frame mounted inside this session may do: post a command in
 * and the session keeps no other channel. */
export interface FindFrameHandle {
  post(command: FindFrameCommand): void
}

/** Immutable view for the FindBar (useSyncExternalStore snapshot). */
export interface FindSnapshot {
  /** The find bar is open. */
  open: boolean
  /** Current term (retained across close/open within one thread). */
  term: string
  /** Total matches across the searched (expanded) frames. */
  total: number
  /** Global 0-based active match; -1 = none (no matches yet). */
  active: number
  /** Collapsed messages whose bodies were not searched. */
  collapsed: number
}

const EMPTY_SNAPSHOT: FindSnapshot = {
  open: false,
  term: "",
  total: 0,
  active: -1,
  collapsed: 0,
}

/** Frame key reach-through wiring: a body frame saw Ctrl/Cmd+F or Escape
 * (keydowns inside a cross-origin frame never reach the shell's own
 * listener). The reading pane injects these at construction. */
export interface FindSessionHooks {
  onRequestOpen?: () => void
  onRequestEscape?: () => void
}

export class FindSession {
  private frames = new Map<string, FindFrameHandle>()
  private counts = new Map<string, number>()
  private seq = 0
  /** The search round the global activation was set for — a late frame
   * report from an older round must not move the active match. */
  private activatedSeq = -1
  private snapshot: FindSnapshot = EMPTY_SNAPSHOT
  private listeners = new Set<() => void>()
  private readonly hooks: FindSessionHooks

  constructor(hooks: FindSessionHooks = {}) {
    this.hooks = hooks
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): FindSnapshot => this.snapshot

  // ---- Frame lifecycle ---------------------------------------------------

  /** A frame saw Ctrl/Cmd+F inside the frame body. */
  openRequest(): void {
    this.hooks.onRequestOpen?.()
  }

  /** A frame saw Escape while highlights were up. */
  escapeRequest(): void {
    this.hooks.onRequestEscape?.()
  }

  /**
   * Register a frame handle; returns its id. Frames join in document order
   * (React mounts the message list top-down). Opening a collapsed message
   * mid-search registers here and immediately joins the current round.
   */
  registerFrame(handle: FindFrameHandle): string {
    const id = `frame-${this.frames.size}-${Math.random().toString(36).slice(2, 8)}`
    this.frames.set(id, handle)
    if (this.snapshot.open && this.snapshot.term !== "") {
      // Join the live round so the fresh frame is counted and navigable.
      handle.post({
        type: EMAILER_FIND_COMMAND_TYPE,
        seq: this.seq,
        action: "search",
        term: this.snapshot.term,
      })
    }
    return id
  }

  unregisterFrame(id: string): void {
    this.frames.delete(id)
    if (this.counts.delete(id)) {
      this.recomputeTotal()
    }
  }

  /** A frame reported its state for a search round. Stale rounds are
   * dropped (the user typed on). */
  handleFrameState(id: string, state: FindFrameState): void {
    if (!this.frames.has(id)) return
    if (state.seq !== this.seq) return
    this.counts.set(id, Math.max(0, Math.floor(state.count)))
    this.recomputeTotal()
  }

  // ---- Shell-side state --------------------------------------------------

  /** The reading pane reports how many collapsed messages carry a body —
   * they are not searched, only counted for the bar's hint. */
  setCollapsedCount(count: number): void {
    if (this.snapshot.collapsed === count) return
    this.setSnapshot({ collapsed: count })
  }

  /** Open the bar (Ctrl/Cmd+F). A retained term re-runs its search so the
   * highlights come back exactly as before the close. */
  open(): void {
    this.setSnapshot({ open: true })
    this.search(this.snapshot.term)
  }

  /** Close the bar and clear every frame's highlights. The term is kept
   * for the next open; reading position is untouched (the bar floats —
   * opening/closing never reflows the message list). */
  close(): void {
    this.setSnapshot({ open: false, total: 0, active: -1 })
    this.activatedSeq = -1
    this.counts.clear()
    this.broadcast({ action: "clear" })
  }

  /** Tear down with the thread (frames are going away anyway). */
  dispose(): void {
    this.close()
    this.frames.clear()
    this.listeners.clear()
  }

  /** Run a search round: reset the aggregation and command every frame.
   * An empty term clears the frames (and the bar shows no count). */
  search(term: string): void {
    this.seq += 1
    this.activatedSeq = -1
    this.counts.clear()
    this.setSnapshot({ term, total: 0, active: -1 })
    this.broadcast({ action: "search", term })
  }

  /** Next/previous with wrap-around across ALL frames (the reference
   * walks its match list with a modulo — same semantics, shell-side). */
  goNext(): void {
    this.step(1)
  }

  goPrevious(): void {
    this.step(-1)
  }

  private step(delta: number): void {
    const { total, active } = this.snapshot
    if (total <= 0) return
    const next = (((active < 0 ? 0 : active + delta) % total) + total) % total
    this.setSnapshot({ active: next })
    this.activatedSeq = this.seq
    this.dispatchActivation()
  }

  /** Sum the per-frame counts. On the first non-zero total of a round the
   * first match becomes active (frames do not self-activate on search). */
  private recomputeTotal(): void {
    let total = 0
    for (const count of this.counts.values()) total += count
    if (total === this.snapshot.total) {
      this.notify()
      return
    }
    let active = -1
    if (this.activatedSeq === this.seq) {
      // Mid-round growth: keep the current index valid (it still points at
      // the same match; later matches shift behind it).
      const current = this.snapshot.active < 0 ? 0 : this.snapshot.active
      active = Math.min(current, total - 1)
    } else if (total > 0) {
      this.activatedSeq = this.seq
      active = 0
    }
    this.setSnapshot({ total, active })
    this.dispatchActivation()
  }

  /** Address the frame owning the global active index; everyone else
   * drops their active styling (index -1, no scroll). */
  private dispatchActivation(): void {
    const { active } = this.snapshot
    let remaining = active
    for (const [id, handle] of this.frames) {
      const count = this.counts.get(id) ?? 0
      if (remaining >= 0 && remaining < count) {
        handle.post({
          type: EMAILER_FIND_COMMAND_TYPE,
          seq: this.seq,
          action: "activate",
          index: remaining,
        })
        remaining = -1
      } else {
        if (remaining >= 0) remaining -= count
        handle.post({
          type: EMAILER_FIND_COMMAND_TYPE,
          seq: this.seq,
          action: "activate",
          index: -1,
        })
      }
    }
  }

  private broadcast(
    command: Pick<FindFrameCommand, "action"> &
      Partial<Pick<FindFrameCommand, "term">>
  ): void {
    for (const handle of this.frames.values()) {
      const message: FindFrameCommand = {
        type: EMAILER_FIND_COMMAND_TYPE,
        seq: this.seq,
        action: command.action,
      }
      if (command.term !== undefined) message.term = command.term
      handle.post(message)
    }
  }

  private setSnapshot(patch: Partial<FindSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

/** React context handing the thread's session down to every SafeEmailFrame
 * without threading props through MailDisplay. Null (popouts, the source
 * dialog) = the frame renders without find support. */
export const FindSessionContext = createContext<FindSession | null>(null)
