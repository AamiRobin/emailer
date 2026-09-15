import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { AccountInfo } from "@/stores/account-store"
import {
  ImapTestFailedError,
  OauthCancelledError,
  reauthGmailAccount,
  reauthImapPassword,
} from "@/services/account-flows"
import { ReauthDialog } from "../reauth-dialog"

/**
 * The re-auth dialog branches on the paused account's type (task 5.6):
 * gmail → Client ID + browser consent rerun; imap → new password with the
 * mandatory double connection test. The orchestrators behind it are
 * covered in src/services/account-flows/__tests__/reauth.test.ts; here we
 * verify the per-type rendering, validation, and the success/error
 * hand-back to the host.
 */

vi.mock("@/services/account-flows", () => ({
  reauthGmailAccount: vi.fn().mockResolvedValue({ accountId: "acc-1" }),
  reauthImapPassword: vi.fn().mockResolvedValue({ accountId: "acc-1" }),
  cancelOauthWait: vi.fn().mockResolvedValue(false),
  OauthCancelledError: class OauthCancelledError extends Error {
    constructor() {
      super("Sign-in was cancelled.")
      this.name = "OauthCancelledError"
    }
  },
  ImapTestFailedError: class ImapTestFailedError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "ImapTestFailedError"
    }
  },
  SmtpTestFailedError: class SmtpTestFailedError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "SmtpTestFailedError"
    }
  },
}))

const reauthGmailMock = vi.mocked(reauthGmailAccount)
const reauthImapMock = vi.mocked(reauthImapPassword)

function makeAccount(
  type: "gmail" | "imap",
  overrides: Partial<AccountInfo> = {}
): AccountInfo {
  return {
    id: "acc-1",
    type,
    email: "paused@example.com",
    displayName: null,
    status: "auth-error",
    unreadCount: 0,
    ...overrides,
  }
}

function renderDialog(
  account: AccountInfo | null,
  onOpenChange = vi.fn()
): ReturnType<typeof render> {
  return render(
    <ReauthDialog
      account={account}
      open={account !== null}
      onOpenChange={onOpenChange}
    />
  )
}

beforeEach(() => {
  reauthGmailMock.mockClear()
  reauthGmailMock.mockResolvedValue({ accountId: "acc-1", email: "x" })
  reauthImapMock.mockClear()
  reauthImapMock.mockResolvedValue({ accountId: "acc-1", email: "x" })
})

afterEach(() => {
  cleanup()
})

describe("ReauthDialog", () => {
  it("renders the gmail variant: Client ID entry with a consent rerun", async () => {
    const onOpenChange = vi.fn()
    renderDialog(makeAccount("gmail"), onOpenChange)

    // Per-type copy names the account and the gmail path.
    expect(screen.getByText("Sign in again")).toBeTruthy()
    expect(screen.getByText(/paused@example\.com/)).toBeTruthy()
    expect(screen.getByText(/Re-authorize/)).toBeTruthy()
    expect(reauthImapMock).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "client-id-9" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Continue in browser" }))

    await waitFor(() => {
      expect(reauthGmailMock).toHaveBeenCalledWith("acc-1", {
        clientId: "client-id-9",
        onProgress: expect.any(Function),
      })
    })
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it("the gmail variant validates an empty Client ID before starting", () => {
    renderDialog(makeAccount("gmail"))

    fireEvent.click(screen.getByRole("button", { name: "Continue in browser" }))

    expect(screen.getByRole("alert").textContent).toContain(
      "Enter your Google OAuth Client ID"
    )
    expect(reauthGmailMock).not.toHaveBeenCalled()
  })

  it("renders the imap variant: new password with a tested save", async () => {
    const onOpenChange = vi.fn()
    renderDialog(makeAccount("imap"), onOpenChange)

    expect(screen.getByText("Update password")).toBeTruthy()
    expect(screen.getByText(/paused@example\.com/)).toBeTruthy()
    expect(reauthGmailMock).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "brand-new-pass" },
    })
    fireEvent.click(screen.getByRole("button", { name: /Test and save/ }))

    await waitFor(() => {
      expect(reauthImapMock).toHaveBeenCalledWith("acc-1", "brand-new-pass")
    })
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it("the imap variant requires a password before submitting", () => {
    renderDialog(makeAccount("imap"))

    fireEvent.click(screen.getByRole("button", { name: /Test and save/ }))

    expect(screen.getByRole("alert").textContent).toContain(
      "Enter the new password"
    )
    expect(reauthImapMock).not.toHaveBeenCalled()
  })

  it("an imap test failure surfaces the failing side and keeps the dialog open", async () => {
    reauthImapMock.mockRejectedValueOnce(
      new ImapTestFailedError("LOGIN failed")
    )
    const onOpenChange = vi.fn()
    renderDialog(makeAccount("imap"), onOpenChange)

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "wrong" },
    })
    fireEvent.click(screen.getByRole("button", { name: /Test and save/ }))

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Incoming mail (IMAP): LOGIN failed"
      )
    })
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("a cancelled gmail consent is quiet and stays on the Client ID step", async () => {
    reauthGmailMock.mockRejectedValueOnce(new OauthCancelledError())
    const onOpenChange = vi.fn()
    renderDialog(makeAccount("gmail"), onOpenChange)

    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "client-id-9" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Continue in browser" }))

    await waitFor(() => {
      expect(reauthGmailMock).toHaveBeenCalled()
    })
    // Quiet cancel: no error banner, no close.
    expect(screen.queryByRole("alert")).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(
      screen.getByRole("button", { name: "Continue in browser" })
    ).toBeTruthy()
  })
})
