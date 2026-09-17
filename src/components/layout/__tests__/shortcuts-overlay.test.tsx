import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { SHORTCUTS, SHORTCUT_GROUPS } from "@/constants/shortcuts"
import { useShortcutBindingsStore } from "@/hooks/shortcut-bindings"
import { ShortcutsOverlay } from "../shortcuts-overlay"

afterEach(() => {
  cleanup()
  useShortcutBindingsStore.setState({ overrides: {}, captureActive: false })
})

/**
 * Shortcuts help overlay (task 6.6; effective bindings per D15, task
 * 20.1): rows must render the binding table — defaults merged with the
 * persisted overrides via the shared useEffectiveShortcuts accessor, so
 * a rebind made in settings shows up here immediately and after a
 * restart.
 */
describe("ShortcutsOverlay", () => {
  it("renders nothing when closed", () => {
    render(<ShortcutsOverlay open={false} onOpenChange={vi.fn()} />)
    expect(screen.queryByTestId("shortcuts-overlay")).toBeNull()
  })

  it("renders every binding from the constants table when open", () => {
    render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />)
    expect(screen.getByTestId("shortcuts-overlay")).toBeTruthy()
    for (const binding of SHORTCUTS) {
      const row = screen.getByTestId(`shortcut-${binding.id}`)
      expect(row.textContent).toContain(binding.keys)
      expect(row.textContent).toContain(binding.description)
    }
  })

  it("renders a section per used group, in table order", () => {
    render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />)
    const usedGroups = SHORTCUT_GROUPS.filter((group) =>
      SHORTCUTS.some((binding) => binding.group === group.id)
    )
    const sections = usedGroups.map((group) =>
      screen.getByTestId(`shortcuts-group-${group.id}`)
    )
    expect(sections.length).toBeGreaterThan(0)
    for (const group of usedGroups) {
      expect(screen.getByText(group.label)).toBeTruthy()
    }
  })

  it("renders the effective binding when an override is set (D15)", () => {
    useShortcutBindingsStore.getState().setOverrides({ archive: "a" })
    render(<ShortcutsOverlay open={true} onOpenChange={vi.fn()} />)
    expect(screen.getByTestId("shortcut-keys-archive").textContent).toBe("a")
    // Untouched bindings keep their defaults.
    expect(screen.getByTestId("shortcut-keys-toggle-star").textContent).toBe(
      "s"
    )
  })
})

/** The fixed table contract: unique ids, known groups, nothing empty. */
describe("shortcuts constants", () => {
  it("has unique ids covering the required bindings", () => {
    const ids = SHORTCUTS.map((binding) => binding.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("only references declared groups, all of which are used", () => {
    const declared = new Set(SHORTCUT_GROUPS.map((group) => group.id))
    for (const binding of SHORTCUTS) {
      expect(declared.has(binding.group)).toBe(true)
    }
    const used = new Set(SHORTCUTS.map((binding) => binding.group))
    expect(used.size).toBe(SHORTCUT_GROUPS.length)
  })

  it("always documents keys and a description", () => {
    for (const binding of SHORTCUTS) {
      expect(binding.keys.length).toBeGreaterThan(0)
      expect(binding.description.length).toBeGreaterThan(0)
    }
  })
})
