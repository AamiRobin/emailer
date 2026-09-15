import { beforeEach, describe, expect, it, vi } from "vitest"

import { ensureNotificationPermission } from "../new-mail-notifier"
import { initNotificationSystem } from "../init-notifications"

vi.mock("../new-mail-notifier", () => ({
  ensureNotificationPermission: vi.fn(async () => true),
}))

const permissionMock = vi.mocked(ensureNotificationPermission)

describe("initNotificationSystem", () => {
  beforeEach(() => {
    permissionMock.mockClear()
  })

  it("prechecks the permission exactly once (idempotent)", () => {
    initNotificationSystem()
    initNotificationSystem()
    initNotificationSystem()

    expect(permissionMock).toHaveBeenCalledTimes(1)
  })
})
