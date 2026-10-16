import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { invoke } from "@tauri-apps/api/core"
import { listen, type Event, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event"

import {
  isAutostartEnabled,
  isTrayAvailable,
  onComposeRequest,
  setAutostartEnabled,
} from "../tray"

/**
 * Desktop-integration bridge (task 1.2, spec desktop-integration). Every
 * wrapper is best-effort: outside the Tauri runtime the commands/events
 * reject and the wrappers must degrade — tray reported unavailable,
 * autostart read reported disabled, compose subscription resolved to a
 * no-op unsubscribe — because the settings UI wires them
 * fire-and-forget.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }))

const invokeMock = vi.mocked(invoke)
const listenMock = vi.mocked(listen)

beforeEach(() => {
  invokeMock.mockReset()
  listenMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("tray availability", () => {
  it("reports the Rust command's answer", async () => {
    invokeMock.mockResolvedValueOnce(true)
    expect(await isTrayAvailable()).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("tray_available")
  })

  it("degrades to unavailable when the command rejects (no tray platform)", async () => {
    invokeMock.mockRejectedValueOnce(new Error("command not found"))
    expect(await isTrayAvailable()).toBe(false)
  })
})

describe("autostart", () => {
  it("reads the OS registration state", async () => {
    invokeMock.mockResolvedValueOnce(true)
    expect(await isAutostartEnabled()).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("autostart_is_enabled")
  })

  it("reads disabled when the command rejects", async () => {
    invokeMock.mockRejectedValueOnce(new Error("not supported"))
    expect(await isAutostartEnabled()).toBe(false)
  })

  it("registers with the enabled flag carried through", async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await setAutostartEnabled(true)
    expect(invokeMock).toHaveBeenCalledWith("autostart_set_enabled", {
      enabled: true,
    })
  })

  it("rethrows a failed registration after warning — the toggle must reflect reality", async () => {
    invokeMock.mockRejectedValueOnce(new Error("registration failed"))
    await expect(setAutostartEnabled(false)).rejects.toThrow(
      "registration failed"
    )
  })
})

describe("compose request subscription", () => {
  it("subscribes to the compose-request event name", async () => {
    listenMock.mockResolvedValue(vi.fn() as unknown as UnlistenFn)
    await onComposeRequest(() => {})
    expect(listenMock).toHaveBeenCalledWith(
      "compose-request",
      expect.any(Function)
    )
  })

  it("delivers desktop compose requests to the handler and unsubscribes", async () => {
    let captured: EventCallback<unknown> | null = null
    let unlisten: UnlistenFn | null = null
    listenMock.mockImplementationOnce(
      async (_event: string, handler: EventCallback<unknown>) => {
        captured = handler
        unlisten = () => {
          captured = null
        }
        return unlisten
      }
    )

    let calls = 0
    const off = await onComposeRequest(() => {
      calls += 1
    })
    captured?.({} as Event<unknown>)
    expect(calls).toBe(1)
    off()
    expect(captured).toBeNull()
    expect(unlisten).not.toBeNull()
  })

  it("resolves to a no-op unsubscribe outside the Tauri runtime", async () => {
    listenMock.mockRejectedValueOnce(new Error("window.__TAURI__ missing"))
    const unlisten = await onComposeRequest(() => {})
    expect(typeof unlisten).toBe("function")
    expect(() => unlisten()).not.toThrow()
  })
})
