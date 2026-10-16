import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Desktop settings section tests (task 1.2/1.4/1.5/1.6, spec
 * desktop-integration). The executor module is mocked to hand the
 * section the shared node:sqlite executor, so the close action, the
 * mailto bookkeeping and the compose shortcut round-trip through the
 * REAL preferences/mailto services. The OS-facing Tauri bridges are
 * mocked at their module seams (tray, mailto invoke-side): `isTrayAvailable`
 * drives the spec's hide-when-no-tray behavior — both branches of that
 * gate are pinned, plus the autostart toggle wiring (with rollback when
 * the OS refuses), the mailto takeover's displaced-handler recording,
 * and the shortcut save/clear with the Rust-side rejection surfacing
 * inline. The tray module's own event listener is stubbed so the seam
 * resolves to a no-op unsubscribe.
 */

const trayHolder = vi.hoisted(() => ({
  isTrayAvailable: vi.fn(),
  isAutostartEnabled: vi.fn(),
  setAutostartEnabled: vi.fn(),
}))

vi.mock("@/services/desktop/tray", () => ({
  isTrayAvailable: trayHolder.isTrayAvailable,
  isAutostartEnabled: trayHolder.isAutostartEnabled,
  setAutostartEnabled: trayHolder.setAutostartEnabled,
  onComposeRequest: vi.fn(async () => () => {}),
}))

const invokeHolder = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeHolder.invoke,
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

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  getCloseAction,
  getComposeShortcut,
  getMailtoPreviousHandler,
  setComposeShortcutPreference,
} from "@/services/settings/preferences"
import { DesktopSection } from "../desktop-section"

let executor: TestExecutor

/** Canned mailto_default_state answer (mirrors desktop.rs). */
function mailtoState(
  is_default: boolean,
  current_handler: string | null
): { is_default: boolean; current_handler: string | null } {
  return { is_default, current_handler }
}

/** The service seam for every mailto command in this suite: the section
 * reads/writes through getMailtoDefaultState / setMailtoDefault, which
 * call invoke. */
function stubMailtoInvoke(
  state: { is_default: boolean; current_handler: string | null } | null
): void {
  invokeHolder.invoke.mockImplementation((command: string, args?: unknown) => {
    if (command === "mailto_default_state") {
      return Promise.resolve(state)
    }
    if (command === "mailto_set_default") {
      const payload = args as { enabled: boolean; restoreTo: string | null }
      state = payload.enabled
        ? mailtoState(true, null)
        : mailtoState(false, payload.restoreTo)
      return Promise.resolve(undefined)
    }
    return Promise.resolve(undefined)
  })
}

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
  invokeHolder.invoke.mockReset()
  invokeHolder.invoke.mockResolvedValue(undefined)
  trayHolder.isTrayAvailable.mockResolvedValue(true)
  trayHolder.isAutostartEnabled.mockResolvedValue(false)
  trayHolder.setAutostartEnabled.mockResolvedValue(undefined)
  invokeHolder.invoke.mockImplementation((command: string) => {
    if (command === "mailto_default_state") {
      return Promise.resolve(mailtoState(false, "com.apple.mail"))
    }
    return Promise.resolve(undefined)
  })
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  executor.close()
  vi.clearAllMocks()
})

describe("DesktopSection tray gate (task 1.2)", () => {
  it("shows the close-action picker when a tray exists", async () => {
    trayHolder.isTrayAvailable.mockResolvedValue(true)

    render(<DesktopSection />)

    expect(
      await screen.findByRole("combobox", { name: "When closing the window" })
    ).toBeTruthy()
    expect(
      screen.queryByText(/Tray integration is not available/)
    ).toBeNull()
  })

  it("hides the tray-dependent rows and states why when there is no tray", async () => {
    trayHolder.isTrayAvailable.mockResolvedValue(false)

    render(<DesktopSection />)

    expect(
      await screen.findByText(/Tray integration is not available/)
    ).toBeTruthy()
    expect(
      screen.queryByRole("combobox", { name: "When closing the window" })
    ).toBeNull()

    // The tray-independent controls stay put.
    expect(
      screen.getByRole("switch", { name: "Default mail client" })
    ).toBeTruthy()
    expect(
      screen.getByRole("switch", { name: "Launch at login" })
    ).toBeTruthy()
    expect(
      screen.getByLabelText("Global compose shortcut")
    ).toBeTruthy()
  })

  it("reflects the persisted close action and round-trips a change", async () => {
    render(<DesktopSection />)
    const trigger = await screen.findByRole("combobox", {
      name: "When closing the window",
    })
    await waitFor(() => expect(trigger.textContent).toContain("Quit Emailer"))
    expect(await getCloseAction(executor)).toBe("quit")

    fireEvent.click(trigger)
    const listbox = (await screen.findAllByRole("listbox")).at(-1)
    if (!listbox) throw new Error("select listbox did not open")
    const option = within(listbox).getByRole("option", { name: "Hide to tray" })
    fireEvent.pointerDown(option)
    fireEvent.click(option)

    await waitFor(async () =>
      expect(await getCloseAction(executor)).toBe("hide")
    )
    await waitFor(() => expect(trigger.textContent).toContain("Hide to tray"))
    // The explanation follows the live value.
    expect(
      screen.getByText(/keeps running in the system tray/)
    ).toBeTruthy()
    // The Rust close-request handler receives the new value too.
    expect(invokeHolder.invoke).toHaveBeenCalledWith("set_close_action", {
      action: "hide",
    })
  })
})

describe("DesktopSection default mail client (task 1.4)", () => {
  it("reflects the OS state and records the displaced handler when taking over", async () => {
    const state = mailtoState(false, "com.apple.mail")
    stubMailtoInvoke(state)
    render(<DesktopSection />)
    const toggle = screen.getByRole("switch", { name: "Default mail client" })
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    )

    fireEvent.click(toggle)
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    )

    // The displaced client was recorded BEFORE the takeover, and the OS
    // was asked to register Emailer.
    expect(
      invokeHolder.invoke.mock.calls.some(
        ([command, args]) =>
          command === "mailto_set_default" &&
          (args as { enabled: boolean }).enabled === true
      )
    ).toBe(true)
    expect(await getMailtoPreviousHandler(executor)).toBe("com.apple.mail")

    // Unsetting restores the recorded handler and clears the row.
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    )
    expect(await getMailtoPreviousHandler(executor)).toBeNull()
    await waitFor(() => {
      const unset = invokeHolder.invoke.mock.calls.find(
        ([command, args]) =>
          command === "mailto_set_default" &&
          (args as { enabled: boolean }).enabled === false
      )
      expect(
        (unset?.[1] as { restoreTo: string | null } | undefined)?.restoreTo
      ).toBe("com.apple.mail")
    })
  })

  it("keeps the toggle functional when the OS reports no state at all", async () => {
    stubMailtoInvoke(null)
    render(<DesktopSection />)
    const toggle = screen.getByRole("switch", { name: "Default mail client" })
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    )

    fireEvent.click(toggle)
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    )
    expect(await getMailtoPreviousHandler(executor)).toBeNull()
  })
})

describe("DesktopSection launch at login (task 1.6)", () => {
  it("reflects the OS registration and wires the toggle to the setter", async () => {
    trayHolder.isAutostartEnabled.mockResolvedValue(true)
    render(<DesktopSection />)
    const toggle = screen.getByRole("switch", { name: "Launch at login" })
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    )

    fireEvent.click(toggle)
    await waitFor(() =>
      expect(trayHolder.setAutostartEnabled).toHaveBeenCalledWith(false)
    )
    expect(toggle.getAttribute("aria-checked")).toBe("false")

    fireEvent.click(toggle)
    await waitFor(() =>
      expect(trayHolder.setAutostartEnabled).toHaveBeenCalledWith(true)
    )
    expect(toggle.getAttribute("aria-checked")).toBe("true")
  })

  it("rolls the toggle back when the OS refuses the registration", async () => {
    trayHolder.setAutostartEnabled.mockRejectedValue(
      new Error("launch agent refused")
    )
    render(<DesktopSection />)
    const toggle = screen.getByRole("switch", { name: "Launch at login" })
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    )

    fireEvent.click(toggle)
    await waitFor(() =>
      expect(trayHolder.setAutostartEnabled).toHaveBeenCalledTimes(1)
    )
    // The OS refused: the section rolls the toggle back to the OS state
    // (the toggle always reflects the actual registration).
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    )
  })
})

describe("DesktopSection global compose shortcut (task 1.5)", () => {
  it("loads the stored accelerator, shows it as registered, and saves a new one", async () => {
    // The stored row only lands when the Rust registration accepted it.
    await setComposeShortcutPreference(executor, "CmdOrCtrl+Shift+E")
    render(<DesktopSection />)

    const input = await screen.findByLabelText<HTMLInputElement>(
      "Global compose shortcut"
    )
    await waitFor(() => expect(input.value).toBe("CmdOrCtrl+Shift+E"))
    expect(
      screen.getByText(/Registered — pressing it in any application/)
    ).toBeTruthy()
    // Save is a no-op while the draft matches the registered value.
    expect(
      screen.getByRole("button", { name: "Save" })
    ).toHaveProperty("disabled", true)

    fireEvent.change(input, { target: { value: "CmdOrCtrl+Shift+K" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    // The Rust command validated (resolved) before the row persisted.
    expect(invokeHolder.invoke).toHaveBeenCalledWith(
      "set_global_compose_shortcut",
      { accelerator: "CmdOrCtrl+Shift+K" }
    )
    await waitFor(async () =>
      expect(await getComposeShortcut(executor)).toBe("CmdOrCtrl+Shift+K")
    )
    expect(input.value).toBe("CmdOrCtrl+Shift+K")
  })

  it("surfaces the Rust rejection inline and persists nothing", async () => {
    render(<DesktopSection />)
    const input = await screen.findByLabelText<HTMLInputElement>(
      "Global compose shortcut"
    )
    await waitFor(() => expect(input.value).toBe(""))

    invokeHolder.invoke.mockRejectedValue(
      "accelerator is already registered by another application"
    )
    fireEvent.change(input, {
      target: { value: "CmdOrCtrl+Shift+E" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("already registered")
    // Nothing persisted — the saved value never disagrees with the OS.
    expect(await getComposeShortcut(executor)).toBeNull()
  })

  it("clears the registered shortcut and unregisters", async () => {
    await setComposeShortcutPreference(executor, "CmdOrCtrl+Shift+E")
    render(<DesktopSection />)
    await screen.findByText(/Registered — pressing it in any application/)

    fireEvent.click(screen.getByRole("button", { name: "Clear" }))

    expect(invokeHolder.invoke).toHaveBeenCalledWith(
      "set_global_compose_shortcut",
      { accelerator: null }
    )
    await waitFor(async () =>
      expect(await getComposeShortcut(executor)).toBeNull()
    )
    await screen.findByText(/No global shortcut registered/)
  })
})
