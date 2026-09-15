import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification"
import { getNotificationsEnabled, setSetting } from "../../db/settings"
import {
  notifyNewMail,
  resetNewMailNotifierForTests,
  setNotificationsEnabled,
} from "../new-mail-notifier"

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
}))

vi.mock("../../db/settings", () => ({
  SETTINGS_KEYS: { notificationsEnabled: "notifications.enabled" },
  getNotificationsEnabled: vi.fn(async () => true),
  setSetting: vi.fn(async () => {}),
}))

// The notifier resolves the executor to read the setting; production
// getExecutor() needs an initialized Tauri database, so hand it a dummy
// — the settings module above is mocked and never touches it.
vi.mock("../../db/executor", () => ({
  getExecutor: () => ({}),
}))

const sendMock = vi.mocked(sendNotification)
const permissionMock = vi.mocked(isPermissionGranted)
const requestPermissionMock = vi.mocked(requestPermission)
const enabledSettingMock = vi.mocked(getNotificationsEnabled)
const setSettingMock = vi.mocked(setSetting)

const EVENT = {
  accountId: "acc-1",
  accountEmail: "amy@example.com",
  count: 3,
}

describe("new-mail notifier", () => {
  beforeEach(() => {
    resetNewMailNotifierForTests()
    sendMock.mockClear()
    permissionMock.mockClear()
    requestPermissionMock.mockClear()
    enabledSettingMock.mockClear()
    setSettingMock.mockClear()
    enabledSettingMock.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("sends a plural notification with title New mail and no content", async () => {
    await notifyNewMail(EVENT)

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith({
      title: "New mail",
      body: "3 new messages for amy@example.com",
    })
  })

  it("uses the singular body for exactly one new message", async () => {
    await notifyNewMail({ ...EVENT, count: 1 })

    expect(sendMock).toHaveBeenCalledWith({
      title: "New mail",
      body: "1 new message for amy@example.com",
    })
  })

  it("does nothing when the count is zero", async () => {
    await notifyNewMail({ ...EVENT, count: 0 })
    await notifyNewMail({ ...EVENT, count: -1 })

    expect(sendMock).not.toHaveBeenCalled()
    expect(enabledSettingMock).not.toHaveBeenCalled()
  })

  it("does not send when the setting is disabled", async () => {
    enabledSettingMock.mockResolvedValue(false)

    await notifyNewMail(EVENT)

    expect(sendMock).not.toHaveBeenCalled()
    expect(enabledSettingMock).toHaveBeenCalledTimes(1)
  })

  it("caches the setting briefly instead of reading it per notification", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)

    await notifyNewMail(EVENT)
    vi.setSystemTime(1_000_000 + 29_000)
    await notifyNewMail({ ...EVENT, accountId: "acc-2" })
    expect(enabledSettingMock).toHaveBeenCalledTimes(1)

    // Past the TTL the setting is read again.
    vi.setSystemTime(1_000_000 + 31_000)
    await notifyNewMail({ ...EVENT, accountId: "acc-3" })
    expect(enabledSettingMock).toHaveBeenCalledTimes(2)
  })

  it("coalesces to one notification per account per 60s", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)

    await notifyNewMail(EVENT)
    expect(sendMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(2_000_000 + 30_000)
    await notifyNewMail(EVENT)
    expect(sendMock).toHaveBeenCalledTimes(1)

    // A different account is never coalesced away by this one.
    await notifyNewMail({ ...EVENT, accountId: "acc-2" })
    expect(sendMock).toHaveBeenCalledTimes(2)

    vi.setSystemTime(2_000_000 + 60_001)
    await notifyNewMail(EVENT)
    expect(sendMock).toHaveBeenCalledTimes(3)
  })

  it("never reserves the coalesce slot when a gate suppressed the send", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_000_000)
    enabledSettingMock.mockResolvedValue(false)

    await notifyNewMail(EVENT)
    expect(sendMock).not.toHaveBeenCalled()

    // The setting flips on (cache invalidated) — the next attempt sends.
    await setNotificationsEnabled(true)
    await notifyNewMail(EVENT)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it("setNotificationsEnabled persists and takes effect without a DB re-read", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(4_000_000)
    enabledSettingMock.mockResolvedValue(false)

    await notifyNewMail(EVENT)
    expect(sendMock).not.toHaveBeenCalled()

    await setNotificationsEnabled(true)
    expect(setSettingMock).toHaveBeenCalledWith(
      expect.anything(),
      "notifications.enabled",
      true
    )

    // Still inside the cache TTL, yet the flip is already live.
    await notifyNewMail(EVENT)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(enabledSettingMock).toHaveBeenCalledTimes(1)
  })

  it("requests permission once and remembers a denial", async () => {
    permissionMock.mockResolvedValue(false)
    requestPermissionMock.mockResolvedValue("denied")

    await notifyNewMail(EVENT)
    await notifyNewMail({ ...EVENT, accountId: "acc-2" })

    expect(sendMock).not.toHaveBeenCalled()
    expect(requestPermissionMock).toHaveBeenCalledTimes(1)
  })

  it("requests when the permission is not yet granted and sends on grant", async () => {
    permissionMock.mockResolvedValue(false)
    requestPermissionMock.mockResolvedValue("granted")

    await notifyNewMail(EVENT)

    expect(requestPermissionMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it("fails open when the settings read throws", async () => {
    enabledSettingMock.mockRejectedValue(new Error("no database"))

    await notifyNewMail(EVENT)

    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it("swallows send failures", async () => {
    sendMock.mockImplementation(() => {
      throw new Error("no notification center")
    })

    await expect(notifyNewMail(EVENT)).resolves.toBeUndefined()
  })
})
