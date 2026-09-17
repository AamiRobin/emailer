import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { getAutoArchiveSetting } from "@/services/email-actions/auto-archive"
import { AutoArchiveSection } from "../auto-archive-section"

/**
 * Auto-archive settings section tests (task 12.3). Same executor-injection
 * pattern as the other settings suites: the executor module is mocked to
 * hand the section a seeded node:sqlite executor (the REAL auto-archive
 * service runs against it, so the global mail.autoArchive round-trip is
 * exercised for real).
 */

const executorHolder = vi.hoisted(() => ({
  current: null as SqlExecutor | null,
}))

vi.mock("@/services/db/executor", () => ({
  getExecutor: () => {
    const executor = executorHolder.current
    if (!executor) throw new Error("test executor not set")
    return executor
  },
  placeholders: (count: number, firstIndex = 1): string =>
    Array.from({ length: count }, (_, index) => `$${index + firstIndex}`).join(
      ", "
    ),
}))

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  executor.close()
})

describe("AutoArchiveSection", () => {
  it("renders the disabled default (off, 30 days)", async () => {
    render(<AutoArchiveSection />)

    const toggle = await screen.findByRole("switch", {
      name: "Auto-archive old mail",
    })
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    })
    expect(
      screen.getByRole("combobox", { name: "Archive after" }).textContent
    ).toContain("30 days")
  })

  it("persists the toggle and the day threshold", async () => {
    render(<AutoArchiveSection />)

    const toggle = await screen.findByRole("switch", {
      name: "Auto-archive old mail",
    })
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    })
    fireEvent.click(toggle)

    await waitFor(async () => {
      const setting = await getAutoArchiveSetting(executor)
      expect(setting.enabled).toBe(true)
    })

    // Pick another threshold — the combobox opens a listbox with the
    // options; choose 90 days.
    const daysSelect = screen.getByRole("combobox", { name: "Archive after" })
    fireEvent.pointerDown(daysSelect)
    fireEvent.click(daysSelect)
    const option = await screen.findByRole("option", { name: "90 days" })
    fireEvent.pointerDown(option)
    fireEvent.click(option)

    await waitFor(async () => {
      const setting = await getAutoArchiveSetting(executor)
      expect(setting.days).toBe(90)
      expect(setting.enabled).toBe(true)
    })
  })

  it("renders a persisted opt-in as on at load", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.autoArchive", JSON.stringify({ enabled: true, days: 14 })]
    )
    render(<AutoArchiveSection />)

    const toggle = await screen.findByRole("switch", {
      name: "Auto-archive old mail",
    })
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    })
    expect(
      screen.getByRole("combobox", { name: "Archive after" }).textContent
    ).toContain("14 days")
  })

  it("turning the toggle off again persists the disabled state", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.autoArchive", JSON.stringify({ enabled: true, days: 30 })]
    )
    render(<AutoArchiveSection />)

    const toggle = await screen.findByRole("switch", {
      name: "Auto-archive old mail",
    })
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    })
    fireEvent.click(toggle)

    await waitFor(async () => {
      expect((await getAutoArchiveSetting(executor)).enabled).toBe(false)
    })
  })
})
