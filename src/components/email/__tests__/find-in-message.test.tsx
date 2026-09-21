import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  EMAILER_FIND_ACTIVE_ATTR,
  EMAILER_FIND_COMMAND_TYPE,
  EMAILER_FIND_MARK_ATTR,
  EMAILER_FIND_OPEN_TYPE,
  EMAILER_FIND_STATE_TYPE,
  FindSession,
  FindSessionContext,
  type FindFrameCommand,
  type FindFrameHandle,
  type FindFrameState,
} from "../find-session"
import { FindBar } from "../find-bar"
import { emailFindController } from "../find-frame-controller"
import { SafeEmailFrame } from "../safe-email-frame"

/**
 * Find-in-message tests (task 1.1, design D5), three layers:
 *
 * 1. The FRAME-SIDE controller — the exact serialized function the frame
 *    executes — run inside a nested jsdom iframe against real DOM surgery:
 *    highlight/count, activate command, clear restoring the text, the
 *    stale-round guard and the Ctrl/Cmd+F key reach-through.
 * 2. The shell-side FindSession: count aggregation across frames, global
 *    next/previous with wrap-around, close/clear, late registration.
 * 3. The bridge wiring in SafeEmailFrame (registration, command routing,
 *    state reports, key requests) plus the FindBar UI states — and a
 *    mock-level proof that a whole search round never touches the network.
 */

// ---------------------------------------------------------------------------
// Layer 1 — the frame-side controller, executed inside a nested jsdom frame
// ---------------------------------------------------------------------------

const PARAMS = {
  commandType: EMAILER_FIND_COMMAND_TYPE,
  stateType: EMAILER_FIND_STATE_TYPE,
  openType: EMAILER_FIND_OPEN_TYPE,
  escapeType: "emailer-find-escape-request",
  markAttr: EMAILER_FIND_MARK_ATTR,
  activeAttr: EMAILER_FIND_ACTIVE_ATTR,
  maxMatches: 2000,
}

interface FrameHost {
  win: Window
  doc: Document
  /** The controller's outward posts, captured synchronously (see below). */
  reports: { seq: number; count: number; active: number }[]
  send(data: unknown): void
  flush(): Promise<void>
  close(): void
}

const openHosts: FrameHost[] = []

/** A KeyboardEvent from the frame's own realm (typed: jsdom's `Window`
 * interface does not re-export the event constructors). */
function frameKeyEvent(
  win: Window,
  type: string,
  init: KeyboardEventInit
): KeyboardEvent {
  const Ctor = (win as unknown as { KeyboardEvent: typeof KeyboardEvent })
    .KeyboardEvent
  return new Ctor(type, init)
}

/**
 * A nested iframe whose window runs the real controller. The frame is
 * same-origin in jsdom, so the test seeds its document directly. jsdom
 * does NOT deliver cross-window postMessage events outward, so the
 * controller's `window.parent.postMessage` reports are captured by
 * stubbing postMessage on the parent window object — a synchronous spy on
 * the exact call the controller makes in the browser. Commands are handed
 * to the frame as message events authored by the parent (`source:
 * win.parent`, the channel contract the controller's identity gate
 * checks) — jsdom's WindowProxy wrappers never compare identical across
 * realms, so a literal win.postMessage would not satisfy it.
 */
function createFrameHost(bodyHtml: string): FrameHost {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const iframe = document.createElement("iframe")
  host.appendChild(iframe)
  const win = iframe.contentWindow as Window
  const doc = win.document
  doc.body.innerHTML = bodyHtml

  const reports: { seq: number; count: number; active: number }[] = []
  const parentLike = win.parent as unknown as {
    postMessage: (data: unknown, target: string) => void
  }
  parentLike.postMessage = (data) => {
    reports.push(data as { seq: number; count: number; active: number })
  }

  const script = `(${emailFindController.toString()})(${JSON.stringify(PARAMS)})`
  ;(win as unknown as { eval: (source: string) => void }).eval(script)

  const frameHost: FrameHost = {
    win,
    doc,
    reports,
    send(data: unknown) {
      win.dispatchEvent(
        new MessageEvent("message", { data, source: win.parent })
      )
    },
    flush() {
      // jsdom delivers postMessage traffic as a task.
      return new Promise((resolve) => setTimeout(resolve, 0))
    },
    close() {
      host.remove()
    },
  }
  openHosts.push(frameHost)
  return frameHost
}

async function search(host: FrameHost, term: string, seq: number) {
  act(() => {
    host.send({ type: PARAMS.commandType, seq, action: "search", term })
  })
  await host.flush()
}

function marksOf(host: FrameHost): HTMLElement[] {
  return [
    ...host.doc.body.querySelectorAll<HTMLElement>(`[${PARAMS.markAttr}]`),
  ]
}

afterEach(() => {
  while (openHosts.length > 0) {
    const host = openHosts.pop()
    if (host) host.close()
  }
  cleanup()
})

// Convenience for tests that need a frame's state report object.
function state(seq: number, count: number): FindFrameState {
  return { type: EMAILER_FIND_STATE_TYPE, seq, count, active: -1 }
}

describe("frame-side find controller", () => {
  it("highlights every case-insensitive occurrence and reports the count", async () => {
    const host = createFrameHost(
      "<p>Invoice paid. The INVOICE number is on the second invoice line.</p>"
    )
    await search(host, "invoice", 1)
    const marks = marksOf(host)
    expect(marks).toHaveLength(3)
    expect(marks.map((mark) => mark.textContent)).toEqual([
      "Invoice",
      "INVOICE",
      "invoice",
    ])
    expect(host.reports.at(-1)).toMatchObject({ seq: 1, count: 3, active: -1 })
  })

  it("does not match across element boundaries (per-text-node semantics)", async () => {
    const host = createFrameHost("<p><b>in</b>voice</p><p>invoice</p>")
    await search(host, "invoice", 1)
    // Only the plain text node matches — same semantics as the reference's
    // per-node match walk.
    expect(marksOf(host)).toHaveLength(1)
  })

  it("never highlights inside script/style/mark subtrees (its own code included)", async () => {
    const host = createFrameHost(
      "<p>needle here</p><script>var needle = 1</script>" +
        "<style>.needle {}</style><p>plain <mark>needle</mark> needle tail</p>"
    )
    await search(host, "needle", 1)
    // The script/style contents and the pre-existing mark's text are
    // skipped; the two body text nodes are wrapped.
    expect(marksOf(host)).toHaveLength(2)
    expect(host.doc.querySelector("script")?.textContent).toContain("needle")
    const literalMark = host.doc.querySelector(`mark:not([${PARAMS.markAttr}])`)
    expect(literalMark?.textContent).toBe("needle")
  })

  it("activate styles the index-th mark (and clears the previous), clear unwraps everything", async () => {
    const host = createFrameHost("<p>alpha beta alpha</p>")
    await search(host, "alpha", 1)

    act(() => {
      host.send({
        type: PARAMS.commandType,
        seq: 1,
        action: "activate",
        index: 1,
      })
    })
    await host.flush()
    const marks = marksOf(host)
    expect(marks[1].hasAttribute(PARAMS.activeAttr)).toBe(true)
    expect(marks[0].hasAttribute(PARAMS.activeAttr)).toBe(false)
    expect(host.reports.at(-1)).toMatchObject({ count: 2, active: 1 })

    act(() => {
      host.send({
        type: PARAMS.commandType,
        seq: 1,
        action: "activate",
        index: -1,
      })
    })
    await host.flush()
    expect(marksOf(host)[0].hasAttribute(PARAMS.activeAttr)).toBe(false)

    act(() => {
      host.send({ type: PARAMS.commandType, seq: 2, action: "clear" })
    })
    await host.flush()
    // The original text is restored exactly — no marks, no split nodes.
    expect(marksOf(host)).toHaveLength(0)
    expect(host.doc.body.querySelector("p")?.innerHTML).toBe("alpha beta alpha")
    expect(host.reports.at(-1)).toMatchObject({ seq: 2, count: 0, active: -1 })
  })

  it("ignores stale rounds and clears on an empty term", async () => {
    const host = createFrameHost("<p>term term</p>")
    await search(host, "term", 5)
    expect(marksOf(host)).toHaveLength(2)
    // A stale round (seq below the current) is dropped entirely.
    await search(host, "zzz", 4)
    expect(marksOf(host)).toHaveLength(2)
    expect(host.reports).toHaveLength(1)
    // An empty search clears without reporting highlights.
    await search(host, "", 6)
    expect(marksOf(host)).toHaveLength(0)
    expect(host.reports.at(-1)).toMatchObject({ seq: 6, count: 0, active: -1 })
  })

  it("forwards Ctrl/Cmd+F and Escape to the shell (Escape regardless of matches)", async () => {
    const host = createFrameHost("<p>term term</p>")
    await search(host, "term", 1)
    // Keydowns inside a frame never reach the shell's own listener, so the
    // controller asks the shell to open (Ctrl/Cmd+F) or close (Escape) on
    // the session's behalf. The posts are the same synchronous channel as
    // the reports.
    act(() => {
      host.win.dispatchEvent(
        frameKeyEvent(host.win, "keydown", {
          key: "f",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      )
    })
    act(() => {
      host.win.dispatchEvent(
        frameKeyEvent(host.win, "keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        })
      )
    })
    const keyTypes = () =>
      host.reports.map(
        (report) => (report as unknown as { type?: string }).type
      )
    expect(keyTypes()).toContain(PARAMS.openType)
    expect(keyTypes()).toContain(PARAMS.escapeType)

    // …and after the highlights are cleared Escape is STILL forwarded —
    // with the bar open showing "0 matches" it is the only way to Esc-close
    // from inside the frame (the shell's Esc path is idempotent).
    act(() => {
      host.send({ type: PARAMS.commandType, seq: 2, action: "clear" })
    })
    await host.flush()
    act(() => {
      host.win.dispatchEvent(
        frameKeyEvent(host.win, "keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        })
      )
    })
    expect(
      keyTypes().filter((type) => type === PARAMS.escapeType)
    ).toHaveLength(2)
  })

  it("ignores commands whose source is not the parent shell", async () => {
    const host = createFrameHost("<p>term term</p>")
    // A message authored by the frame itself (or any window that is not
    // the direct parent) is dropped on identity, before its content is
    // even looked at.
    act(() => {
      host.win.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: PARAMS.commandType,
            seq: 1,
            action: "search",
            term: "term",
          },
          source: host.win,
        })
      )
    })
    expect(marksOf(host)).toHaveLength(0)
    expect(host.reports).toHaveLength(0)
    // The real shell channel (postMessage from the parent window) still
    // commands the frame.
    await search(host, "term", 1)
    expect(marksOf(host)).toHaveLength(2)
  })

  it("a clear command never scrolls the document (reading position preserved)", async () => {
    const host = createFrameHost("<p>alpha beta alpha</p>")
    await search(host, "alpha", 1)
    const scrolls: unknown[] = []
    for (const mark of marksOf(host)) {
      mark.scrollIntoView = (...args) => {
        scrolls.push(args)
      }
    }
    // Activating a match legitimately scrolls it into view…
    act(() => {
      host.send({
        type: PARAMS.commandType,
        seq: 1,
        action: "activate",
        index: 1,
      })
    })
    await host.flush()
    expect(scrolls).toHaveLength(1)

    // …but the clear (bar close broadcasts exactly this command) must not
    // scroll or re-activate anything — closing the bar keeps the reader
    // exactly where they were.
    act(() => {
      host.send({ type: PARAMS.commandType, seq: 2, action: "clear" })
    })
    await host.flush()
    expect(scrolls).toHaveLength(1)
    expect(host.reports.at(-1)).toMatchObject({ seq: 2, count: 0, active: -1 })
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — the shell-side FindSession
// ---------------------------------------------------------------------------

function fakeHandle(): FindFrameHandle & { sent: FindFrameCommand[] } {
  const sent: FindFrameCommand[] = []
  return {
    sent,
    post(command: FindFrameCommand) {
      sent.push(command)
    },
  }
}

/** Non-search traffic (activation dispatches) a frame received. */
function activationsOf(handle: ReturnType<typeof fakeHandle>) {
  return handle.sent.filter((command) => command.action === "activate")
}

describe("FindSession", () => {
  it("aggregates counts across frames and activates the first match", () => {
    const session = new FindSession()
    const a = fakeHandle()
    const b = fakeHandle()
    const idA = session.registerFrame(a)
    const idB = session.registerFrame(b)
    // Round 1 (no prior open → this is the first search round).
    session.search("x")

    session.handleFrameState(idA, state(1, 2))
    expect(session.getSnapshot().total).toBe(2)
    // Frame b has not reported — it has only ever been told to drop its
    // active styling (the activation dispatch addresses every frame).
    expect(activationsOf(b).at(-1)).toMatchObject({
      action: "activate",
      index: -1,
    })

    session.handleFrameState(idB, state(1, 3))
    expect(session.getSnapshot().total).toBe(5)
    // First round with matches: global match 0 is active, owned by frame a.
    expect(session.getSnapshot().active).toBe(0)
    expect(activationsOf(a).at(-1)).toMatchObject({
      action: "activate",
      index: 0,
    })
  })

  it("navigates next/previous across frames with wrap-around", () => {
    const session = new FindSession()
    const a = fakeHandle()
    const b = fakeHandle()
    const idA = session.registerFrame(a)
    const idB = session.registerFrame(b)
    session.search("x")
    session.handleFrameState(idA, state(1, 2))
    session.handleFrameState(idB, state(1, 3))
    // Frame a owns global 0–1, frame b owns global 2–4.

    // Four nexts land on the LAST match: frame b, local index 2.
    session.goNext()
    session.goNext()
    session.goNext()
    session.goNext()
    expect(session.getSnapshot().active).toBe(4)
    expect(activationsOf(a).at(-1)).toMatchObject({
      action: "activate",
      index: -1,
    })
    expect(activationsOf(b).at(-1)).toMatchObject({
      action: "activate",
      index: 2,
    })

    // One more next wraps to the first match (frame a, local 0)…
    session.goNext()
    expect(session.getSnapshot().active).toBe(0)
    expect(activationsOf(a).at(-1)).toMatchObject({
      action: "activate",
      index: 0,
    })
    expect(activationsOf(b).at(-1)).toMatchObject({
      action: "activate",
      index: -1,
    })

    // …and previous from there wraps back to the last.
    session.goPrevious()
    expect(session.getSnapshot().active).toBe(4)
    expect(activationsOf(a).at(-1)).toMatchObject({
      action: "activate",
      index: -1,
    })
    expect(activationsOf(b).at(-1)).toMatchObject({
      action: "activate",
      index: 2,
    })
  })

  it("drops stale reports and stops counting unregistered frames", () => {
    const session = new FindSession()
    const a = fakeHandle()
    const idA = session.registerFrame(a)
    session.search("x") // round 1
    session.search("xy") // round 2 — the live one
    // The round-1 report arrives late: dropped.
    session.handleFrameState(idA, state(1, 7))
    expect(session.getSnapshot().total).toBe(0)
    session.handleFrameState(idA, state(2, 4))
    expect(session.getSnapshot().total).toBe(4)
    session.unregisterFrame(idA)
    expect(session.getSnapshot().total).toBe(0)
  })

  it("close clears every frame and resets; a fresh open re-runs the term", () => {
    const session = new FindSession()
    const a = fakeHandle()
    const idA = session.registerFrame(a)
    session.search("x") // round 1
    session.handleFrameState(idA, state(1, 1))
    session.close()
    expect(session.getSnapshot()).toMatchObject({
      open: false,
      total: 0,
      active: -1,
      term: "x",
    })
    expect(a.sent.at(-1)).toMatchObject({ action: "clear" })

    // Reopen re-runs the retained term's search so highlights come back
    // exactly as before the close (round 2).
    session.open()
    expect(a.sent.at(-1)).toMatchObject({ action: "search", term: "x" })
    expect(a.sent.at(-1)?.seq).toBe(2)
  })

  it("a frame registered mid-search joins the live round", () => {
    const session = new FindSession()
    const a = fakeHandle()
    session.registerFrame(a)
    // The bar is open with a term (open's empty search = round 1, then
    // the term's search = round 2) when a collapsed message expands:
    session.open()
    session.search("x")
    const late = fakeHandle()
    session.registerFrame(late)
    expect(late.sent.at(-1)).toMatchObject({ action: "search", term: "x" })
    expect(late.sent.at(-1)?.seq).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Layer 3 — bridge wiring (SafeEmailFrame) and the FindBar UI
// ---------------------------------------------------------------------------

function postFromSource(source: Window | null, data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }))
  })
}

function getFrame(): HTMLIFrameElement {
  const frame = document.querySelector("iframe")
  if (!frame) throw new Error("no iframe rendered")
  return frame
}

/** Records every unregister so the re-registration cycles can be counted. */
class CountingSession extends FindSession {
  unregistered: string[] = []

  override unregisterFrame(id: string): void {
    this.unregistered.push(id)
    super.unregisterFrame(id)
  }
}

describe("SafeEmailFrame find wiring", () => {
  it("registers with the session, receives search commands and reports counts", async () => {
    const session = new FindSession()
    render(
      <FindSessionContext.Provider value={session}>
        <SafeEmailFrame html="<p>Hi</p>" />
      </FindSessionContext.Provider>
    )
    const frame = getFrame()
    const postSpy = vi.spyOn(frame.contentWindow as Window, "postMessage")

    // open() runs a search of the empty term (round 1), search() is
    // round 2 — the frame must have received the live round's command.
    session.open()
    session.search("hello")
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: EMAILER_FIND_COMMAND_TYPE,
        action: "search",
        term: "hello",
      }),
      "*"
    )

    // The frame's count report lands in the session (routed by the
    // event.source identity check) — and the whole round never touches
    // the network (spec: search is purely local, no image unblocking).
    const fetchSpy = vi.fn()
    const previousFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      postFromSource(frame.contentWindow, state(2, 3))
      expect(session.getSnapshot().total).toBe(3)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it("ignores find-state traffic from any other source", () => {
    const session = new FindSession()
    render(
      <FindSessionContext.Provider value={session}>
        <SafeEmailFrame html="<p>Hi</p>" />
      </FindSessionContext.Provider>
    )
    session.search("hello")
    postFromSource(window, state(1, 9))
    postFromSource(null, state(1, 9))
    expect(session.getSnapshot().total).toBe(0)
  })

  it("forwards the frame's Ctrl/Cmd+F request to the session hook", () => {
    const requestOpen = vi.fn()
    const session = new FindSession({ onRequestOpen: requestOpen })
    render(
      <FindSessionContext.Provider value={session}>
        <SafeEmailFrame html="<p>Hi</p>" />
      </FindSessionContext.Provider>
    )
    postFromSource(getFrame().contentWindow, { type: EMAILER_FIND_OPEN_TYPE })
    expect(requestOpen).toHaveBeenCalledTimes(1)
  })

  it("a theme flip rebuilds the document and the frame re-joins the live round", async () => {
    const session = new CountingSession()
    render(
      <FindSessionContext.Provider value={session}>
        <SafeEmailFrame html="<p>Hi</p>" />
      </FindSessionContext.Provider>
    )
    const frame = getFrame()
    const postSpy = vi.spyOn(frame.contentWindow as Window, "postMessage")
    session.open()
    session.search("hello")
    const srcDocBefore = frame.getAttribute("srcdoc")
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "search", term: "hello" }),
      "*"
    )

    // The dark flip rebuilds srcDoc; the frame document reloads and its
    // fresh controller has lost every mark — the registration effect must
    // re-run (srcDoc in its deps) so the new document re-joins the open
    // round instead of silently drifting from the session's counts.
    act(() => {
      document.documentElement.classList.add("dark")
    })
    await act(async () => {}) // flush the theme observer → re-render → effect
    expect(frame.getAttribute("srcdoc")).not.toBe(srcDocBefore)
    // The OLD id was unregistered exactly once for this cycle…
    expect(session.unregistered).toHaveLength(1)
    // …and registerFrame re-posted the live round's term to the fresh frame.
    expect(postSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: EMAILER_FIND_COMMAND_TYPE,
        action: "search",
        term: "hello",
      }),
      "*"
    )
    document.documentElement.classList.remove("dark")
    await act(async () => {})
  })

  it("a source-variant frame registers nothing and ships no find controller", () => {
    const session = new FindSession()
    render(
      <FindSessionContext.Provider value={session}>
        <SafeEmailFrame variant="source" html="<p>Hi</p>" />
      </FindSessionContext.Provider>
    )
    session.open()
    session.search("hello")
    // No registration happened, so the broadcast had no receivers and the
    // srcdoc carries no controller at all (it IS monospace, though).
    const srcdoc = getFrame().getAttribute("srcdoc") ?? ""
    expect(srcdoc).not.toContain(EMAILER_FIND_COMMAND_TYPE)
    expect(srcdoc).toContain("ui-monospace")
  })
})

describe("FindBar", () => {
  const baseSnapshot = {
    open: true,
    term: "invoice",
    total: 3,
    active: 0,
    collapsed: 0,
  }

  function renderBar(
    snapshot: Partial<typeof baseSnapshot>,
    handlers: {
      onTermChange?: (term: string) => void
      onNext?: () => void
      onPrevious?: () => void
      onClose?: () => void
    } = {}
  ) {
    return render(
      <FindBar
        snapshot={{ ...baseSnapshot, ...snapshot }}
        onTermChange={handlers.onTermChange ?? (() => {})}
        onNext={handlers.onNext ?? (() => {})}
        onPrevious={handlers.onPrevious ?? (() => {})}
        onClose={handlers.onClose ?? (() => {})}
      />
    )
  }

  it("shows the spec's position count with the collapsed hint", () => {
    const { getByTestId } = renderBar({ active: 0, collapsed: 2 })
    expect(getByTestId("find-count").textContent).toBe(
      "1 of 3 · 2 in collapsed messages"
    )
    cleanup()
    renderBar({ active: 2, collapsed: 0 })
    expect(getByTestId("find-count").textContent).toBe("3 of 3")
  })

  it("zero matches shows 0 and disables navigation", () => {
    const { getByTestId } = renderBar({ total: 0, active: -1 })
    expect(getByTestId("find-count").textContent).toBe("0 matches")
    expect((getByTestId("find-next") as HTMLButtonElement).disabled).toBe(true)
    expect((getByTestId("find-previous") as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it("Enter goes next, Shift+Enter previous, Escape closes", () => {
    const next = vi.fn()
    const previous = vi.fn()
    const close = vi.fn()
    const { getByTestId } = renderBar(
      {},
      { onNext: next, onPrevious: previous, onClose: close }
    )
    const input = getByTestId("find-input")
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(next).toHaveBeenCalledTimes(1)
    expect(previous).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
