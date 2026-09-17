import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import { SHORTCUTS } from "@/constants/shortcuts"
import { useShortcutBindingsStore } from "@/hooks/shortcut-bindings"
import { getShortcutOverrides } from "@/services/settings/preferences"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { ShortcutsSection } from "../shortcuts-section"

/**
 * Shortcuts settings editor tests (task 20.1, design D15). Same
 * executor-injection pattern as the other settings suites: the executor
 * module is mocked to hand every consumer the shared node:sqlite
 * executor, so rebind/reset writes are asserted against the REAL
 * persistence (getShortcutOverrides reads the same settings table back).
 * Key captures are dispatched on window — the section listens on the
 * window capture phase while a row is being rebound.
 */

const executorHolder = vi.hoisted(() => ({
  current: null as import("@/services/db/executor").SqlExecutor | null,
}))

vi.mock("@/services/db/executor", () => ({
  getExecutor: () => {
    const executor = executorHolder.current
    if (!executor) throw new Error("test executor not set")
    return executor
  },
}))

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
  useShortcutBindingsStore.setState({ overrides: {}, captureActive: false })
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  executor.close()
})

function pressKey(key: string, init: Partial<KeyboardEventInit> = {}): void {
  fireEvent.keyDown(window, { key, bubbles: true, cancelable: true, ...init })
}

async function storedOverrides(): Promise<Record<string, string>> {
  const stored = await getShortcutOverrides(executor)
  return stored as Record<string, string>
}

describe("ShortcutsSection — reference table", () => {
  it("renders every binding with its effective keys", () => {
    render(<ShortcutsSection />)
    for (const binding of SHORTCUTS) {
      expect(screen.getByTestId(`shortcut-${binding.id}`)).toBeTruthy()
      expect(
        screen.getByTestId(`shortcut-keys-${binding.id}`).textContent
      ).toBe(binding.keys)
    }
  })

  it("offers Change on the app-level groups but not on the fixed general ones", () => {
    render(<ShortcutsSection />)
    for (const id of ["archive", "compose", "next-thread", "focus-search"]) {
      expect(screen.getByTestId(`rebind-${id}`)).toBeTruthy()
    }
    for (const id of ["refresh", "help", "dismiss"]) {
      expect(screen.queryByTestId(`rebind-${id}`)).toBeNull()
    }
  })

  it("still filters the table by description and keys", () => {
    render(<ShortcutsSection />)
    fireEvent.change(screen.getByLabelText("Filter shortcuts"), {
      target: { value: "star" },
    })
    expect(screen.getByTestId("shortcut-toggle-star")).toBeTruthy()
    expect(screen.queryByTestId("shortcut-archive")).toBeNull()
  })
})

describe("ShortcutsSection — rebinding (spec: rebind archive)", () => {
  it("captures a key, applies it immediately and persists the override", async () => {
    render(<ShortcutsSection />)

    fireEvent.click(screen.getByTestId("rebind-archive"))
    expect(screen.getByTestId("shortcut-capture-hint")).toBeTruthy()

    // No conflict: archive moves from e to a (the spec scenario).
    pressKey("a")

    await waitFor(() =>
      expect(screen.getByTestId("shortcut-keys-archive").textContent).toBe("a")
    )
    expect(await storedOverrides()).toEqual({ archive: "a" })
    // The capture closed and the row now offers the per-binding reset.
    expect(screen.queryByTestId("shortcut-capture-hint")).toBeNull()
    expect(screen.getByTestId("reset-shortcut-archive")).toBeTruthy()
  })

  it("keeps a Shift+letter capture in the table's display format", async () => {
    render(<ShortcutsSection />)
    fireEvent.click(screen.getByTestId("rebind-compose"))
    pressKey("K", { shiftKey: true })
    await waitFor(() =>
      expect(screen.getByTestId("shortcut-keys-compose").textContent).toBe(
        "Shift+K"
      )
    )
    expect(await storedOverrides()).toEqual({ compose: "Shift+K" })
  })

  it("Escape cancels a capture without saving", async () => {
    render(<ShortcutsSection />)
    fireEvent.click(screen.getByTestId("rebind-archive"))
    pressKey("Escape")
    expect(screen.queryByTestId("shortcut-capture-hint")).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await storedOverrides()).toEqual({})
    expect(screen.getByTestId("shortcut-keys-archive").textContent).toBe("e")
  })

  it("re-capturing the binding's own key closes the capture unchanged", async () => {
    render(<ShortcutsSection />)
    fireEvent.click(screen.getByTestId("rebind-archive"))
    pressKey("e")
    expect(screen.queryByTestId("shortcut-capture-hint")).toBeNull()
    expect(await storedOverrides()).toEqual({})
  })
})

describe("ShortcutsSection — conflict blocking (spec: conflict is blocked)", () => {
  it("names both actions and does not save until a free key is chosen", async () => {
    render(<ShortcutsSection />)

    fireEvent.click(screen.getByTestId("rebind-archive"))
    // "s" is toggle-star's key: the editor shows both actions…
    pressKey("s")

    const conflict = screen.getByTestId("shortcut-conflict-archive")
    expect(conflict.textContent).toContain("Toggle star")
    expect(conflict.textContent).toContain("Archive the selected thread")
    // …and saves nothing while the conflict stands (the row keeps
    // capturing instead of writing the override).
    expect(await storedOverrides()).toEqual({})
    expect(screen.getByTestId("shortcut-capture-hint")).toBeTruthy()

    // Resolving by pressing an unbound key saves the rebind.
    pressKey("a")
    await waitFor(() =>
      expect(screen.getByTestId("shortcut-keys-archive").textContent).toBe("a")
    )
    expect(await storedOverrides()).toEqual({ archive: "a" })
  })

  it("rejects a multi-alias collision, not just exact strings", async () => {
    render(<ShortcutsSection />)
    fireEvent.click(screen.getByTestId("rebind-open-thread"))
    // "↓" is an alias of next-thread ("j / ↓") — canonical comparison
    // must catch it even though no display string equals another.
    pressKey("ArrowDown")
    expect(
      screen.getByTestId("shortcut-conflict-open-thread").textContent
    ).toContain("Select next thread")
    expect(await storedOverrides()).toEqual({})
  })
})

describe("ShortcutsSection — resets", () => {
  it("resets a single binding to its default", async () => {
    render(<ShortcutsSection />)
    fireEvent.click(screen.getByTestId("rebind-archive"))
    pressKey("a")
    await waitFor(() =>
      expect(screen.getByTestId("reset-shortcut-archive")).toBeTruthy()
    )

    fireEvent.click(screen.getByTestId("reset-shortcut-archive"))

    await waitFor(() =>
      expect(screen.getByTestId("shortcut-keys-archive").textContent).toBe("e")
    )
    expect(await storedOverrides()).toEqual({})
    expect(screen.queryByTestId("reset-shortcut-archive")).toBeNull()
  })

  it("resets every binding at once (global reset-to-defaults)", async () => {
    render(<ShortcutsSection />)
    fireEvent.click(screen.getByTestId("rebind-archive"))
    pressKey("a")
    await waitFor(() =>
      expect(screen.getByTestId("shortcut-keys-archive").textContent).toBe("a")
    )
    fireEvent.click(screen.getByTestId("rebind-toggle-read"))
    pressKey("n")
    await waitFor(() =>
      expect(screen.getByTestId("shortcut-keys-toggle-read").textContent).toBe(
        "n"
      )
    )

    fireEvent.click(screen.getByTestId("reset-all-shortcuts"))

    await waitFor(() =>
      expect(screen.getByTestId("shortcut-keys-archive").textContent).toBe("e")
    )
    expect(screen.getByTestId("shortcut-keys-toggle-read").textContent).toBe(
      "m"
    )
    expect(await storedOverrides()).toEqual({})
    expect(screen.queryByTestId("reset-all-shortcuts")).toBeNull()
  })
})
