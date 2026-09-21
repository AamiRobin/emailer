import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { Titlebar } from "@/components/layout/titlebar"
import { isTauriRuntime } from "@/services/desktop/popout"

/**
 * Titlebar tests (task 1.8): platform-conditional rendering — the drag
 * region always exists inside the Tauri runtime, the min/max/close
 * controls only on non-macOS (macOS keeps the native traffic lights over
 * the overlay titlebar), and nothing at all outside the Tauri runtime.
 * Close/minimize/maximize route through the Tauri window handle, which
 * the mock records; close honors the tray setting Rust-side (lib.rs
 * CloseRequested), which the component-level contract here guarantees by
 * going through window.close().
 */

const windowCalls: string[] = []

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: () => {
      windowCalls.push("minimize")
    },
    toggleMaximize: () => {
      windowCalls.push("toggleMaximize")
    },
    close: () => {
      windowCalls.push("close")
    },
  }),
}))

function stubPlatform(platform: string): void {
  Object.defineProperty(window, "navigator", {
    value: { platform },
    writable: true,
    configurable: true,
  })
}

function stubTauriRuntime(present: boolean): void {
  if (present) {
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  } else {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  }
}

beforeEach(() => {
  windowCalls.length = 0
})

afterEach(() => {
  cleanup()
  stubTauriRuntime(false)
  stubPlatform("")
  vi.restoreAllMocks()
})

describe("Titlebar", () => {
  it("renders nothing outside the Tauri runtime", () => {
    stubTauriRuntime(false)
    const { container } = render(<Titlebar />)
    expect(container.firstChild).toBeNull()
    expect(isTauriRuntime()).toBe(false)
  })

  it("renders window controls on a non-mac platform", () => {
    stubTauriRuntime(true)
    stubPlatform("Win32")
    render(<Titlebar />)
    expect(screen.getByLabelText("Minimize")).not.toBeNull()
    expect(screen.getByLabelText("Maximize")).not.toBeNull()
    expect(screen.getByLabelText("Close")).not.toBeNull()
  })

  it("hides the window controls on macOS (native traffic lights)", () => {
    stubTauriRuntime(true)
    stubPlatform("MacIntel")
    render(<Titlebar />)
    expect(screen.queryByLabelText("Minimize")).toBeNull()
    expect(screen.queryByLabelText("Maximize")).toBeNull()
    expect(screen.queryByLabelText("Close")).toBeNull()
  })

  it("routes the controls through the window handle", () => {
    stubTauriRuntime(true)
    stubPlatform("Win32")
    render(<Titlebar />)
    screen.getByLabelText("Minimize").click()
    screen.getByLabelText("Maximize").click()
    screen.getByLabelText("Close").click()
    expect(windowCalls).toEqual(["minimize", "toggleMaximize", "close"])
  })

  it("marks the bar (and its fillers) as the drag region", () => {
    stubTauriRuntime(true)
    stubPlatform("Linux x86_64")
    const { container } = render(<Titlebar />)
    const regions = container.querySelectorAll("[data-tauri-drag-region]")
    // The bar itself plus the flex filler; the buttons area is
    // intentionally NOT draggable so clicks reach the controls.
    expect(regions.length).toBeGreaterThanOrEqual(2)
  })

  it("keeps the control buttons out of the drag region", () => {
    stubTauriRuntime(true)
    stubPlatform("Win32")
    const { container } = render(<Titlebar />)
    const closeButton = screen.getByLabelText("Close")
    expect(closeButton.hasAttribute("data-tauri-drag-region")).toBe(false)
    expect(container.querySelector("button")).not.toBeNull()
  })
})
