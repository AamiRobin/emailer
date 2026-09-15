import { beforeEach, describe, expect, it, vi } from "vitest"

import { invoke } from "@tauri-apps/api/core"
import { updateUnreadBadge } from "../unread-badge"

vi.mock("@tauri-apps/api/core")

const invokeMock = vi.mocked(invoke)

describe("updateUnreadBadge", () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it("invokes the set_unread_badge command with the count", async () => {
    invokeMock.mockResolvedValue(undefined)

    await updateUnreadBadge(7)

    expect(invokeMock).toHaveBeenCalledWith("set_unread_badge", { count: 7 })
  })

  it("clears the badge by passing 0", async () => {
    invokeMock.mockResolvedValue(undefined)

    await updateUnreadBadge(0)

    expect(invokeMock).toHaveBeenCalledWith("set_unread_badge", { count: 0 })
  })

  it("resolves silently when the invoke fails (non-Tauri env)", async () => {
    invokeMock.mockRejectedValue(new Error("__TAURI_INTERNALS__ missing"))

    await expect(updateUnreadBadge(3)).resolves.toBeUndefined()
  })
})
