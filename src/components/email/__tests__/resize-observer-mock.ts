import { vi } from "vitest"

/**
 * jsdom has no ResizeObserver and no layout engine; @tanstack/react-virtual
 * and react-resizable-panels both need one to size their elements. The mock
 * reports a configurable height for observed scroll containers and a fixed
 * height for virtualized item nodes (which carry a data-index attribute),
 * so tests control how many virtual rows render.
 */

let viewportHeight = 0

const ITEM_HEIGHT = 64
const VIEWPORT_WIDTH = 1024

export function setMockViewportHeight(height: number): void {
  viewportHeight = height
}

export function installResizeObserverMock(): void {
  class MockResizeObserver {
    private callback: ResizeObserverCallback

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }

    observe(target: Element): void {
      const blockSize = target.hasAttribute("data-index")
        ? ITEM_HEIGHT
        : viewportHeight
      const entry = {
        target,
        contentRect: { width: VIEWPORT_WIDTH, height: blockSize },
        borderBoxSize: [{ inlineSize: VIEWPORT_WIDTH, blockSize }],
      } as unknown as ResizeObserverEntry
      this.callback([entry], this as unknown as ResizeObserver)
    }

    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", MockResizeObserver)
  // jsdom has no Web Animations; Base UI's ScrollArea viewport probes
  // element.getAnimations() on a timer (sidebar scroll areas in the shell).
  if (typeof Element !== "undefined" && !Element.prototype.getAnimations) {
    Element.prototype.getAnimations = () => []
  }
}

export function uninstallResizeObserverMock(): void {
  vi.unstubAllGlobals()
}
