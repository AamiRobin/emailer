import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useOnlineStore } from "../../stores/online-store"
import {
  initOnlineTracking,
  isOnline,
  onBackOnline,
  onOnlineChange,
  resetOnlineTrackingForTests,
} from "../online"

/**
 * Event-driven connectivity detection over the jsdom window (Tauri 2
 * webview exposes the same navigator.onLine + window events).
 */

function goOnline(): void {
  window.dispatchEvent(new Event("online"))
}

function goOffline(): void {
  window.dispatchEvent(new Event("offline"))
}

describe("online tracking", () => {
  beforeEach(() => {
    resetOnlineTrackingForTests()
  })

  afterEach(() => {
    resetOnlineTrackingForTests()
  })

  it("mirrors window online/offline events into the shared store", () => {
    expect(useOnlineStore.getState().online).toBe(true) // jsdom default

    initOnlineTracking()
    goOffline()
    expect(isOnline()).toBe(false)
    expect(useOnlineStore.getState().online).toBe(false)

    goOnline()
    expect(isOnline()).toBe(true)
    expect(useOnlineStore.getState().online).toBe(true)
  })

  it("notifies subscribers only on transitions", () => {
    initOnlineTracking()
    const changes: boolean[] = []
    const unsubscribe = onOnlineChange((online) => changes.push(online))

    goOffline()
    goOffline() // no transition — no duplicate notification
    goOnline()
    expect(changes).toEqual([false, true])

    unsubscribe()
    goOffline()
    expect(changes).toEqual([false, true])
  })

  it("fires back-online listeners once per offline → online transition", () => {
    initOnlineTracking()
    const backOnline = vi.fn()
    onBackOnline(backOnline)

    goOnline() // already online — no transition
    expect(backOnline).not.toHaveBeenCalled()

    goOffline()
    goOnline()
    goOffline()
    goOnline()
    expect(backOnline).toHaveBeenCalledTimes(2)
  })

  it("is idempotent — double init does not duplicate handling", () => {
    initOnlineTracking()
    initOnlineTracking()
    const changes: boolean[] = []
    onOnlineChange((online) => changes.push(online))

    goOffline()
    expect(changes).toEqual([false])
  })

  it("reports online() false when the store was seeded offline", () => {
    // Services read the store directly (e.g. processor offline gate) even
    // before any window event fired.
    useOnlineStore.getState().setOnline(false)
    expect(isOnline()).toBe(false)
  })
})
