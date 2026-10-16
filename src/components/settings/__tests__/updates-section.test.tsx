import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { relaunch } from "@tauri-apps/plugin-process"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Updates settings section tests (task 20.5, docs/releases.md). The
 * executor module is mocked to hand the section the shared node:sqlite
 * executor, so the release channel round-trips through the REAL updater
 * service (settings row in, settings row out); only the process
 * boundaries are faked: `@tauri-apps/api/core` invoke (the check/install
 * commands), the download-progress event listener, and the relaunch.
 * The suite pins the manual check's state machine — idle → checking →
 * up-to-date / available / error — plus the download → ready → restart
 * flow and the stale-load guard on the channel picker.
 *
 * `IS_DESKTOP_APP` is evaluated at module scope from
 * `__TAURI_INTERNALS__`, so the flag is planted in `vi.hoisted` BEFORE
 * the component module evaluates (the whole file runs in desktop mode;
 * the non-desktop branch has its own suite).
 */

// jsdom's window lacks the Tauri injection; the component reads it at
// module scope, so the flag must exist before the import below.
type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown }

vi.hoisted(() => {
  ;(window as TauriWindow).__TAURI_INTERNALS__ = {}
})

const invokeHolder = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

const listenHolder = vi.hoisted(() => ({
  handler: null as
    | ((event: { payload: { received: number; total: number | null } }) => void)
    | null,
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeHolder.invoke,
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, handler: (typeof listenHolder)["handler"]) => {
    listenHolder.handler = handler
    return Promise.resolve(() => {})
  }),
}))

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}))

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

import { createTestExecutor, type TestExecutor } from "@/services/db/__tests__/test-executor"
import {
  getUpdateChannel,
  setUpdateChannel,
} from "@/services/updates/updater"
import { UpdatesSection } from "../updates-section"

const relaunchMock = vi.mocked(relaunch)

const BETA_OPTION = "Beta — prereleases as soon as they build"

let executor: TestExecutor

function channelSelect(): HTMLElement {
  return screen.getByRole("combobox", { name: "Release channel" })
}

/** An executor whose `settings` reads after the first block until
 * released, so a test can change the channel while the initial load is
 * still pending (the stale-load guard's race). */
function gateFirstSettingsRead(target: TestExecutor): {
  executor: SqlExecutor
  release: () => void
} {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let seen = 0
  return {
    executor: {
      async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        const isSettingsRead = sql.includes("FROM settings")
        if (isSettingsRead && seen++ > 0) await gate
        return target.select<T>(sql, params)
      },
      execute: (sql, params) => target.execute(sql, params),
    },
    release,
  }
}

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
  invokeHolder.invoke.mockReset()
  invokeHolder.invoke.mockResolvedValue(undefined)
  listenHolder.handler = null
})

afterEach(() => {
  cleanup()
  delete (window as TauriWindow).__TAURI_INTERNALS__
  executorHolder.current = null
  executor.close()
  vi.clearAllMocks()
})

describe("UpdatesSection release channel", () => {
  it("defaults to stable and round-trips a beta pick through the settings row", async () => {
    render(<UpdatesSection />)
    const trigger = await screen.findByRole("combobox", {
      name: "Release channel",
    })
    await waitFor(() => expect(trigger.textContent).toContain("Stable"))
    expect(await getUpdateChannel(executor)).toBe("stable")
    expect(screen.queryByText(/on the beta channel/)).toBeNull()

    fireEvent.click(trigger)
    const listbox = (await screen.findAllByRole("listbox")).at(-1)
    if (!listbox) throw new Error("select listbox did not open")
    const option = within(listbox).getByRole("option", { name: BETA_OPTION })
    fireEvent.pointerDown(option)
    fireEvent.click(option)

    await waitFor(async () =>
      expect(await getUpdateChannel(executor)).toBe("beta")
    )
    await waitFor(() => expect(trigger.textContent).toContain("Beta"))
    expect(screen.getByText(/on the beta channel/)).toBeTruthy()
  })

  it("shows the persisted channel on a fresh mount", async () => {
    await setUpdateChannel(executor, "beta")
    render(<UpdatesSection />)
    const trigger = await screen.findByRole("combobox", {
      name: "Release channel",
    })
    await waitFor(() => expect(trigger.textContent).toContain("Beta"))
  })

  it("does not let the initial load clobber a change made before it resolves", async () => {
    const gated = gateFirstSettingsRead(executor)
    executorHolder.current = gated.executor
    render(<UpdatesSection />)

    // The initial DB read is still parked on the gate; switch anyway.
    fireEvent.click(channelSelect())
    const listbox = (await screen.findAllByRole("listbox")).at(-1)
    if (!listbox) throw new Error("select listbox did not open")
    const option = within(listbox).getByRole("option", { name: BETA_OPTION })
    fireEvent.pointerDown(option)
    fireEvent.click(option)
    gated.release()

    await waitFor(() => expect(channelSelect().textContent).toContain("Beta"))
    await waitFor(async () =>
      expect(await getUpdateChannel(executor)).toBe("beta")
    )
  })
})

describe("UpdatesSection manual check state machine", () => {
  it("passes the selected channel to check_for_update", async () => {
    await setUpdateChannel(executor, "beta")
    invokeHolder.invoke.mockResolvedValue(null)

    render(<UpdatesSection />)
    await waitFor(() => expect(channelSelect().textContent).toContain("Beta"))

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }))
    await waitFor(() =>
      expect(invokeHolder.invoke).toHaveBeenCalledWith("check_for_update", {
        channel: "beta",
      })
    )
    await screen.findByText("Emailer is up to date.")
  })

  it("shows the up-to-date status when the check returns no update", async () => {
    invokeHolder.invoke.mockResolvedValue(null)
    render(<UpdatesSection />)
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }))

    const status = await screen.findByRole("status")
    expect(status.textContent).toContain("Emailer is up to date")
  })

  it("shows the available update with both versions and an install affordance", async () => {
    invokeHolder.invoke.mockResolvedValue({
      version: "0.2.0",
      currentVersion: "0.1.0",
      notes: null,
    })
    render(<UpdatesSection />)
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }))

    const status = await screen.findByRole("status")
    expect(status.textContent).toContain("Version 0.2.0")
    expect(status.textContent).toContain("you are on 0.1.0")
    expect(
      screen.getByRole("button", { name: "Download and install" })
    ).toBeTruthy()
  })

  it("disables the check while it is in flight and reports the channel", async () => {
    let resolveCheck: (value: null) => void = () => {}
    invokeHolder.invoke.mockReturnValue(
      new Promise<null>((resolve) => {
        resolveCheck = resolve
      })
    )
    render(<UpdatesSection />)
    const button = screen.getByRole("button", { name: "Check for updates" })

    fireEvent.click(button)
    await waitFor(() => expect(button).toHaveProperty("disabled", true))
    expect(screen.getByText(/Checking the stable channel/)).toBeTruthy()

    resolveCheck(null)
    await screen.findByText("Emailer is up to date.")
    await waitFor(() => expect(button).toHaveProperty("disabled", false))
  })

  it("surfaces a failed check as an alert with the specific reason", async () => {
    invokeHolder.invoke.mockRejectedValue(new Error("manifest unreachable"))
    render(<UpdatesSection />)
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe("manifest unreachable")
  })

  it("falls back to a generic message when the rejection is not an Error", async () => {
    invokeHolder.invoke.mockRejectedValue("boom")
    render(<UpdatesSection />)
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe("Could not check for updates.")
  })
})

describe("UpdatesSection install flow", () => {
  it("downloads with live progress, reports readiness, and restarts", async () => {
    let resolveInstall: () => void = () => {}
    invokeHolder.invoke.mockImplementation((command: string) => {
      if (command === "check_for_update") {
        return Promise.resolve({
          version: "0.2.0",
          currentVersion: "0.1.0",
          notes: null,
        })
      }
      if (command === "download_and_install_update") {
        return new Promise<void>((resolve) => {
          resolveInstall = resolve
        })
      }
      return Promise.resolve(undefined)
    })

    render(<UpdatesSection />)
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Download and install" })
    )

    // The install starts after the progress listener attaches (a microtask
    // later than the click).
    await waitFor(() =>
      expect(invokeHolder.invoke).toHaveBeenCalledWith(
        "download_and_install_update"
      )
    )
    // No total yet: the indeterminate line, and the check stays disabled.
    await screen.findByText("Downloading…")
    expect(
      screen.getByRole("button", { name: "Check for updates" })
    ).toHaveProperty("disabled", true)

    // The Rust side's updates://download-progress event moves the line.
    listenHolder.handler!({ payload: { received: 500_000, total: 1_000_000 } })
    await screen.findByText("Downloading — 50%")

    resolveInstall()
    await screen.findByText(/restart to apply it/)
    fireEvent.click(screen.getByRole("button", { name: "Restart" }))
    expect(relaunchMock).toHaveBeenCalledTimes(1)
  })
})
