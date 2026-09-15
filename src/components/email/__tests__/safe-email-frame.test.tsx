import { act, cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  EMAILER_RESIZE_MESSAGE_TYPE,
  MIN_EMAIL_FRAME_HEIGHT,
  SafeEmailFrame,
} from "../safe-email-frame"

/**
 * jsdom does not execute srcdoc documents, so the injected resize reporter
 * is exercised from the test side: messages are dispatched at the parent
 * window with `source` set to the frame's contentWindow — exactly what the
 * real postMessage traffic looks like.
 */

function getFrame(): HTMLIFrameElement {
  const frame = document.querySelector("iframe")
  if (!frame) throw new Error("SafeEmailFrame did not render an iframe")
  return frame
}

function postFromSource(source: Window | null, data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }))
  })
}

afterEach(cleanup)

describe("SafeEmailFrame", () => {
  it("renders a sandboxed iframe without allow-same-origin", () => {
    render(<SafeEmailFrame html="<p>Hi</p>" />)
    const frame = getFrame()
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-popups allow-popups-to-escape-sandbox"
    )
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin")
    expect(frame.getAttribute("srcdoc")).toContain("<p>Hi</p>")
  })

  it("sanitizes hostile html before embedding it in srcdoc", () => {
    render(
      <SafeEmailFrame html='<p onclick="x()">Hi</p><script>alert(1)</script>' />
    )
    const srcdoc = getFrame().getAttribute("srcdoc") ?? ""
    expect(srcdoc).toContain("<p>Hi</p>")
    expect(srcdoc).not.toContain("alert(1)")
    expect(srcdoc).not.toContain("onclick")
    // The injected resize reporter IS part of the document.
    expect(srcdoc).toContain(EMAILER_RESIZE_MESSAGE_TYPE)
  })

  it("injects theme token values and pre-wrap support into the document", () => {
    render(<SafeEmailFrame html="plain" />)
    const srcdoc = getFrame().getAttribute("srcdoc") ?? ""
    expect(srcdoc).toContain("--background:")
    expect(srcdoc).toContain("--foreground:")
    expect(srcdoc).toContain(
      "[data-emailer-plaintext] { white-space: pre-wrap; }"
    )
    expect(srcdoc).toContain("background: transparent")
  })

  it("rebuilds the document when the host theme flips (no stale tokens)", async () => {
    document.documentElement.classList.remove("dark")
    const { unmount } = render(<SafeEmailFrame html="<p>Hi</p>" />)
    expect(getFrame().getAttribute("srcdoc") ?? "").toContain(
      "color-scheme: light"
    )

    act(() => {
      document.documentElement.classList.add("dark")
    })
    // MutationObserver fires in a microtask; flush before asserting.
    await act(async () => {})
    expect(getFrame().getAttribute("srcdoc") ?? "").toContain(
      "color-scheme: dark"
    )

    unmount()
    document.documentElement.classList.remove("dark")
  })

  it("starts at the min-height floor and grows with resize messages", () => {
    render(<SafeEmailFrame html="<p>Hi</p>" />)
    const frame = getFrame()
    expect(frame.style.height).toBe(`${MIN_EMAIL_FRAME_HEIGHT}px`)
    postFromSource(frame.contentWindow, {
      type: EMAILER_RESIZE_MESSAGE_TYPE,
      height: 456,
    })
    expect(frame.style.height).toBe("456px")
  })

  it("never shrinks below the min-height floor", () => {
    render(<SafeEmailFrame html="<p>Hi</p>" />)
    const frame = getFrame()
    postFromSource(frame.contentWindow, {
      type: EMAILER_RESIZE_MESSAGE_TYPE,
      height: 10,
    })
    expect(frame.style.height).toBe(`${MIN_EMAIL_FRAME_HEIGHT}px`)
  })

  it("ignores malformed resize payloads", () => {
    render(<SafeEmailFrame html="<p>Hi</p>" />)
    const frame = getFrame()
    postFromSource(frame.contentWindow, { type: EMAILER_RESIZE_MESSAGE_TYPE })
    postFromSource(frame.contentWindow, {
      type: EMAILER_RESIZE_MESSAGE_TYPE,
      height: "999",
    })
    postFromSource(frame.contentWindow, {
      type: EMAILER_RESIZE_MESSAGE_TYPE,
      height: Number.POSITIVE_INFINITY,
    })
    postFromSource(frame.contentWindow, { type: "something-else", height: 999 })
    expect(frame.style.height).toBe(`${MIN_EMAIL_FRAME_HEIGHT}px`)
  })

  it("ignores resize messages from any other source", () => {
    render(<SafeEmailFrame html="<p>Hi</p>" />)
    const frame = getFrame()
    postFromSource(window, { type: EMAILER_RESIZE_MESSAGE_TYPE, height: 999 })
    postFromSource(null, { type: EMAILER_RESIZE_MESSAGE_TYPE, height: 999 })
    expect(frame.style.height).toBe(`${MIN_EMAIL_FRAME_HEIGHT}px`)
  })

  it("removes the message listener on unmount", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener")
    const { unmount } = render(<SafeEmailFrame html="<p>Hi</p>" />)
    unmount()
    expect(removeSpy).toHaveBeenCalledWith("message", expect.any(Function))
    removeSpy.mockRestore()
  })

  it("resets to the floor and swaps content when the html prop changes", () => {
    const { rerender } = render(<SafeEmailFrame html="<p>One</p>" />)
    postFromSource(getFrame().contentWindow, {
      type: EMAILER_RESIZE_MESSAGE_TYPE,
      height: 500,
    })
    expect(getFrame().style.height).toBe("500px")

    // Changing html remounts the frame (key={html}): a fresh iframe at the
    // floor with the new document in srcdoc.
    rerender(<SafeEmailFrame html="<p>Two</p>" />)
    const remounted = getFrame()
    expect(remounted.style.height).toBe(`${MIN_EMAIL_FRAME_HEIGHT}px`)
    expect(remounted.getAttribute("srcdoc")).toContain("<p>Two</p>")
    expect(remounted.getAttribute("srcdoc")).not.toContain("<p>One</p>")

    // The fresh frame's own traffic is picked up by its listener.
    postFromSource(remounted.contentWindow, {
      type: EMAILER_RESIZE_MESSAGE_TYPE,
      height: 320,
    })
    expect(remounted.style.height).toBe("320px")
  })
})
