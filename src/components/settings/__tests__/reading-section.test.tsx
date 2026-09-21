import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Reading settings section tests (task 1.4, settings spec). Same
 * executor-injection pattern as the notifications-section suite: the
 * executor module is mocked to hand every consumer the shared seeded
 * node:sqlite executor, and the section round-trips the
 * mark-as-read-on-open toggle through the real preferences service.
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

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  getMarkReadOnOpen,
  setMarkReadOnOpenPreference,
} from "@/services/settings/preferences"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { ReadingSection } from "../reading-section"

describe("ReadingSection mark-as-read-on-open (task 1.4)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    useUiStore.setState({
      view: DEFAULT_VIEW,
      readingPane: "right",
    })
    executor = createTestExecutor()
    executorHolder.current = executor
  })

  afterEach(() => {
    cleanup()
    executorHolder.current = null
    executor.close()
  })

  it("defaults to on and reflects a persisted off row", async () => {
    render(<ReadingSection />)
    const toggle = screen.getByRole("switch", {
      name: "Mark as read on open",
    })
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    })

    cleanup()
    await setMarkReadOnOpenPreference(executor, false)
    render(<ReadingSection />)
    const persisted = screen.getByRole("switch", {
      name: "Mark as read on open",
    })
    await waitFor(() => {
      expect(persisted.getAttribute("aria-checked")).toBe("false")
    })
  })

  it("persists the toggle", async () => {
    render(<ReadingSection />)
    const toggle = screen.getByRole("switch", {
      name: "Mark as read on open",
    })
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    })

    fireEvent.click(toggle)
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    })
    expect(await getMarkReadOnOpen(executor)).toBe(false)

    fireEvent.click(toggle)
    await waitFor(async () => {
      expect(await getMarkReadOnOpen(executor)).toBe(true)
    })
  })
})
