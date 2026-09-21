import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

import { HELP_CARDS } from "@/services/help/content"
import { useShortcutBindingsStore } from "@/hooks/shortcut-bindings"
import { useUiStore } from "@/stores/ui-store"
import { HelpCenter, HelpCenterDialog } from "../help-center"

/**
 * Help-center component tests (task 2.9). Light render tests against the
 * bundled catalog: the categorized grid browses with an empty query, a
 * keyword search filters and force-expands the matching cards, and the
 * shortcuts card renders the LIVE binding table (effective bindings per
 * D15 — an override saved in settings shows up here). No jest-dom:
 * toBeTruthy/toBeNull assertions, per project convention.
 *
 * The dialog test stubs ResizeObserver/Element.getAnimations because the
 * Base UI ScrollArea around the dialog body observes size/animations in
 * jsdom (same stubs as the settings-page suite).
 */

beforeAll(() => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.ResizeObserver ??=
    ResizeObserverStub as unknown as typeof ResizeObserver
  const elementProto = Element.prototype as unknown as {
    getAnimations?: () => unknown[]
  }
  elementProto.getAnimations ??= () => []
})

beforeEach(() => {
  useUiStore.setState({ helpCenterOpen: false })
})

afterEach(() => {
  cleanup()
  useShortcutBindingsStore.setState({ overrides: {}, captureActive: false })
  useUiStore.setState({ helpCenterOpen: false })
})

describe("HelpCenter", () => {
  it("browses every category with an empty query", () => {
    render(<HelpCenter />)

    for (const category of [
      "Getting started",
      "Reading & organizing",
      "Composing",
      "AI assistance",
      "Security & privacy",
      "Desktop integration",
    ]) {
      expect(screen.getByText(category)).toBeTruthy()
    }
    expect(
      screen.getByTestId("help-result-count").textContent
    ).toContain(`${HELP_CARDS.length} articles`)
    // Every card title is present, collapsed by default.
    expect(screen.getByText("Snooze a thread")).toBeTruthy()
    expect(screen.queryByTestId("help-card-body-snooze")).toBeNull()
  })

  it("searching “snooze” filters to the snooze cards, expanded", () => {
    render(<HelpCenter />)
    const input = screen.getByRole("textbox", {
      name: "Search help",
    }) as HTMLInputElement

    fireEvent.change(input, { target: { value: "snooze" } })

    expect(
      screen.getByTestId("help-result-count").textContent
    ).toContain(`3 of ${HELP_CARDS.length} articles match`)
    expect(screen.getByText("Snooze a thread")).toBeTruthy()
    expect(screen.getByText("Keyboard shortcuts")).toBeTruthy()
    expect(screen.queryByText("Encrypt with PGP")).toBeNull()

    // Matched cards render expanded: the snooze article is readable
    // without a click, and the shortcuts card carries the live table.
    expect(screen.getByText(/unsnooze one early/)).toBeTruthy()
    expect(screen.getByTestId("help-shortcuts-reference")).toBeTruthy()
    expect(screen.getByTestId("help-shortcut-archive").textContent).toContain(
      "e"
    )
  })

  it("the shortcuts card shows the effective bindings (overrides included)", () => {
    useShortcutBindingsStore.getState().setOverrides({ archive: "a" })
    render(<HelpCenter />)

    fireEvent.click(screen.getByTestId("help-card-toggle-keyboard-shortcuts"))

    expect(screen.getByTestId("help-shortcuts-reference")).toBeTruthy()
    expect(screen.getByTestId("help-shortcut-archive").textContent).toContain(
      "a"
    )
  })

  it("cards expand and collapse on click when browsing", () => {
    render(<HelpCenter />)

    const toggle = screen.getByTestId("help-card-toggle-snooze")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(toggle)
    expect(screen.getByTestId("help-card-body-snooze")).toBeTruthy()
    expect(
      screen.getByTestId("help-card-toggle-snooze").getAttribute("aria-expanded")
    ).toBe("true")
    fireEvent.click(screen.getByTestId("help-card-toggle-snooze"))
    expect(screen.queryByTestId("help-card-body-snooze")).toBeNull()
  })

  it("shows an empty state and restores the browse grid on clear", () => {
    render(<HelpCenter />)
    const input = screen.getByRole("textbox", {
      name: "Search help",
    }) as HTMLInputElement

    fireEvent.change(input, { target: { value: "zzzzzz" } })
    expect(screen.getByText("No matching help articles")).toBeTruthy()
    expect(screen.queryByText("Snooze a thread")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))
    expect(screen.getByText("Snooze a thread")).toBeTruthy()
    expect(input.value).toBe("")
  })

  it("the parity-round-2 surfaces are searchable from the bundled catalog", () => {
    // Task 5.1: the new surfaces are reachable by keyword and the article
    // body renders inline — with no network mock of any kind, because the
    // catalog ships in the bundle ("everything is stored in the app, no
    // network needed", the subtitle below).
    render(<HelpCenter />)

    expect(screen.getByText(/no network needed/)).toBeTruthy()

    const input = screen.getByRole("textbox", {
      name: "Search help",
    }) as HTMLInputElement

    // A keyword lands on its surface's card, force-expanded so the body
    // is readable without a click.
    fireEvent.change(input, { target: { value: "carddav" } })
    expect(screen.getByText("Sync contacts over CardDAV")).toBeTruthy()
    expect(screen.getByText(/sealed on this device/)).toBeTruthy()
    expect(screen.queryByText("Encrypt with PGP")).toBeNull()

    fireEvent.change(input, { target: { value: "chime" } })
    expect(screen.getByText("New-mail notifications")).toBeTruthy()
    expect(screen.getByText(/sent-message chime/)).toBeTruthy()

    fireEvent.change(input, { target: { value: "wipe" } })
    expect(screen.getByText("Storage and starting over")).toBeTruthy()
    expect(screen.getByText(/two-step confirmation/)).toBeTruthy()
  })
})

describe("HelpCenterDialog", () => {
  it("renders nothing until ui-store opens it; closing resets the flag", () => {
    render(<HelpCenterDialog />)
    expect(screen.queryByTestId("help-center-dialog")).toBeNull()

    act(() => {
      useUiStore.getState().setHelpCenterOpen(true)
    })
    expect(screen.getByTestId("help-center-dialog")).toBeTruthy()
    expect(screen.getByText("Help center")).toBeTruthy()
    expect(screen.getByTestId("help-center")).toBeTruthy()

    // The store flag is the contract (the palette suite's convention):
    // Base UI keeps the popup in the DOM through its exit animation in
    // jsdom, so DOM removal is not asserted.
    act(() => {
      useUiStore.getState().setHelpCenterOpen(false)
    })
    expect(useUiStore.getState().helpCenterOpen).toBe(false)
  })
})
