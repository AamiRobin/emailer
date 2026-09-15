import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { SqlExecutor } from "@/services/db/executor"
import {
  applyBootPreferences,
  applyDensity,
  applyFontScale,
  getAccentPreference,
  getDensity,
  getFontScale,
  getReadingPanePreference,
  getThemeModePreference,
  setAccentPreference,
  setDensityPreference,
  setFontScalePreference,
  setReadingPanePreference,
  setThemeModePreference,
} from "../preferences"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"

/**
 * Preferences service tests (tasks 11.2/11.3): persistence round-trips
 * against the real v1 schema (node:sqlite) plus the live-application and
 * boot-apply side effects on the document root and the ui-store.
 */

function resetDocument(): void {
  document.documentElement.removeAttribute("data-accent")
  document.documentElement.style.removeProperty("--density")
  document.documentElement.style.removeProperty("--font-scale")
}

function resetStore(): void {
  localStorage.clear()
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
    previousView: DEFAULT_VIEW,
  })
}

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
  resetDocument()
  resetStore()
})

afterEach(() => {
  resetDocument()
  resetStore()
  executor.close()
})

describe("density", () => {
  it("defaults to the default preset and round-trips", async () => {
    expect(await getDensity(executor)).toBe("default")

    await setDensityPreference(executor, "compact")
    expect(await getDensity(executor)).toBe("compact")
    expect(document.documentElement.style.getPropertyValue("--density")).toBe(
      "0.85"
    )

    await setDensityPreference(executor, "relaxed")
    expect(document.documentElement.style.getPropertyValue("--density")).toBe(
      "1.25"
    )
  })

  it("falls back to the default when the stored value is unknown", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["appearance.density", JSON.stringify("gigantic")]
    )
    expect(await getDensity(executor)).toBe("default")
  })

  it("applyDensity maps every preset to its token value", () => {
    applyDensity("compact")
    expect(document.documentElement.style.getPropertyValue("--density")).toBe(
      "0.85"
    )
    applyDensity("default")
    expect(document.documentElement.style.getPropertyValue("--density")).toBe(
      "1"
    )
  })
})

describe("font scale", () => {
  it("defaults to 1 and round-trips, applying the --font-scale token", async () => {
    expect(await getFontScale(executor)).toBe(1)

    await setFontScalePreference(executor, 1.25)
    expect(await getFontScale(executor)).toBe(1.25)
    expect(
      document.documentElement.style.getPropertyValue("--font-scale")
    ).toBe("1.25")
  })

  it("ignores unknown scales on write and read", async () => {
    await setFontScalePreference(executor, 3)
    expect(await getFontScale(executor)).toBe(1)
    expect(
      document.documentElement.style.getPropertyValue("--font-scale")
    ).toBe("")

    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["appearance.fontScale", JSON.stringify(9)]
    )
    expect(await getFontScale(executor)).toBe(1)
  })

  it("applyFontScale ignores unknown scales", () => {
    applyFontScale(0.9)
    expect(
      document.documentElement.style.getPropertyValue("--font-scale")
    ).toBe("0.9")
    applyFontScale(4.2)
    expect(
      document.documentElement.style.getPropertyValue("--font-scale")
    ).toBe("0.9")
  })
})

describe("reading pane position", () => {
  it("defaults to right and round-trips into the ui-store", async () => {
    expect(await getReadingPanePreference(executor)).toBe("right")
    expect(useUiStore.getState().readingPane).toBe("right")

    await setReadingPanePreference(executor, "bottom")
    expect(await getReadingPanePreference(executor)).toBe("bottom")
    expect(useUiStore.getState().readingPane).toBe("bottom")
  })

  it("falls back to right when the stored value is unknown", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.readingPane", JSON.stringify("floating")]
    )
    expect(await getReadingPanePreference(executor)).toBe("right")
  })
})

describe("accent + theme-mode mirrors", () => {
  it("accent defaults to neutral and round-trips the mirrored id", async () => {
    expect(await getAccentPreference(executor)).toBe("default")

    await setAccentPreference(executor, "teal")
    expect(await getAccentPreference(executor)).toBe("teal")
  })

  it("theme mode defaults to system and round-trips the mirrored mode", async () => {
    expect(await getThemeModePreference(executor)).toBe("system")

    await setThemeModePreference(executor, "dark")
    expect(await getThemeModePreference(executor)).toBe("dark")
  })
})

describe("applyBootPreferences", () => {
  it("sets the tokens and feeds the reading pane into the ui-store", async () => {
    await setDensityPreference(executor, "compact")
    await setFontScalePreference(executor, 1.1)
    await setReadingPanePreference(executor, "hidden")
    // Return the store to the default so the boot apply has work to do.
    useUiStore.setState({ readingPane: "right" })

    await applyBootPreferences(executor)

    expect(document.documentElement.style.getPropertyValue("--density")).toBe(
      "0.85"
    )
    expect(
      document.documentElement.style.getPropertyValue("--font-scale")
    ).toBe("1.1")
    expect(useUiStore.getState().readingPane).toBe("hidden")
  })

  it("re-applies the accent only when a mirror row exists", async () => {
    // No mirror row: the localStorage choice initAccent() applied (simulated
    // here by a direct attribute set) must survive the boot apply.
    document.documentElement.setAttribute("data-accent", "rose")
    await applyBootPreferences(executor)
    expect(document.documentElement.getAttribute("data-accent")).toBe("rose")

    // With a mirrored row the boot apply restores it (e.g. cleared
    // localStorage).
    await setAccentPreference(executor, "amber")
    await applyBootPreferences(executor)
    expect(document.documentElement.getAttribute("data-accent")).toBe("amber")
  })

  it("keeps the defaults when the executor fails", async () => {
    const failing: SqlExecutor = {
      select: () => Promise.reject(new Error("no database")),
      execute: () => Promise.reject(new Error("no database")),
    }
    // Must not throw.
    await applyBootPreferences(failing)
    expect(useUiStore.getState().readingPane).toBe("right")
    expect(document.documentElement.style.getPropertyValue("--density")).toBe(
      ""
    )
  })
})
