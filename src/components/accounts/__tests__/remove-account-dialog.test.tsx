import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { AccountInfo } from "@/stores/account-store"
import { removeAccount } from "@/services/account-flows"
import { RemoveAccountDialog } from "../remove-account-dialog"

/**
 * Confirmation flow of the removal dialog (task 5.5): it names the
 * account, warns about the local data loss, and only removes on the
 * destructive confirm. The cascade itself is covered by the
 * removeAccount orchestrator test.
 */

vi.mock("@/services/account-flows", () => ({
  removeAccount: vi.fn().mockResolvedValue(undefined),
}))

const removeAccountMock = vi.mocked(removeAccount)

function makeAccount(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id: "acc-1",
    type: "gmail",
    email: "gone@example.com",
    displayName: null,
    status: "active",
    unreadCount: 2,
    ...overrides,
  }
}

function renderDialog(
  account: AccountInfo | null,
  onOpenChange = vi.fn()
): ReturnType<typeof render> {
  return render(
    <RemoveAccountDialog
      account={account}
      open={account !== null}
      onOpenChange={onOpenChange}
    />
  )
}

beforeEach(() => {
  removeAccountMock.mockClear()
  removeAccountMock.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe("RemoveAccountDialog", () => {
  it("names the account and warns that all local mail is deleted", () => {
    renderDialog(makeAccount())

    expect(screen.getByText("gone@example.com")).toBeTruthy()
    const description = screen.getByText(/locally stored message/i)
    expect(description.textContent).toContain("deleted")
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeTruthy()
  })

  it("removes only after the destructive confirm, then closes", async () => {
    const onOpenChange = vi.fn()
    renderDialog(makeAccount(), onOpenChange)

    fireEvent.click(screen.getByRole("button", { name: /Remove account/ }))

    await waitFor(() => {
      expect(removeAccountMock).toHaveBeenCalledWith("acc-1")
    })
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it("cancel backs out without removing", () => {
    const onOpenChange = vi.fn()
    renderDialog(makeAccount(), onOpenChange)

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(removeAccountMock).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("a failed removal shows the error and keeps the dialog open", async () => {
    removeAccountMock.mockRejectedValueOnce(new Error("database is locked"))
    const onOpenChange = vi.fn()
    renderDialog(makeAccount(), onOpenChange)

    fireEvent.click(screen.getByRole("button", { name: /Remove account/ }))

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "database is locked"
      )
    })
    expect(onOpenChange).not.toHaveBeenCalled()
    // The dialog stays interactive for a retry.
    expect(
      (
        screen.getByRole("button", {
          name: /Remove account/,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  })
})
