import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"

import { AddAccountDialog } from "../add-account-dialog"

/**
 * The chooser and the first step of each flow. Deeper interactions
 * (consent round-trip, connection tests) are covered by the orchestrator
 * tests in src/services/account-flows/__tests__.
 */

vi.mock("@tauri-apps/api/core")
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.mocked(invoke).mockReset()
  vi.mocked(openUrl).mockReset()
})

function renderDialog(onOpenChange = vi.fn()): ReturnType<typeof render> {
  return render(<AddAccountDialog open={true} onOpenChange={onOpenChange} />)
}

describe("AddAccountDialog", () => {
  it("offers the Gmail and IMAP/SMTP paths plus the Client-ID help link", () => {
    renderDialog()

    expect(screen.getByRole("button", { name: /Gmail/ })).toBeTruthy()
    expect(
      screen.getByRole("button", { name: /Other email \(IMAP\/SMTP\)/ })
    ).toBeTruthy()
    const help = screen.getByRole("link", { name: /What do I need/ })
    expect(help.getAttribute("href")).toBe(
      "https://developers.google.com/gmail/api/quickstart/js"
    )
  })

  it("the Gmail flow validates an empty Client ID before starting anything", () => {
    renderDialog()

    fireEvent.click(screen.getByRole("button", { name: /Gmail/ }))

    expect(screen.getByLabelText("Client ID")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Continue in browser" }))

    // Inline validation error; no browser opened, no server started.
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter your Google OAuth Client ID"
    )
    expect(vi.mocked(openUrl)).not.toHaveBeenCalled()
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })

  it("the IMAP flow prefills known providers", () => {
    renderDialog()

    fireEvent.click(
      screen.getByRole("button", { name: /Other email \(IMAP\/SMTP\)/ })
    )
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "user@yahoo.com" },
    })
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    expect(screen.getByText("Server settings")).toBeTruthy()
    const imapHost = screen.getByLabelText("IMAP server") as HTMLInputElement
    expect(imapHost.value).toBe("imap.mail.yahoo.com")
  })

  it("the IMAP flow presents empty manual fields for unknown domains", () => {
    renderDialog()

    fireEvent.click(
      screen.getByRole("button", { name: /Other email \(IMAP\/SMTP\)/ })
    )
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "user@small-provider.example" },
    })
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    expect(screen.getByText("Server settings")).toBeTruthy()
    expect(screen.getByText(/not in the known list/i)).toBeTruthy()
    const imapHost = screen.getByLabelText("IMAP server") as HTMLInputElement
    expect(imapHost.value).toBe("")
    // Saving requires passing tests — the button starts disabled.
    const connect = screen.getByRole("button", {
      name: /Test and save/,
    }) as HTMLButtonElement
    expect(connect.disabled).toBe(true)
  })
})

describe("AddAccountDialog — Microsoft 365 (parity-round-2, task 3.5)", () => {
  function renderMicrosoftDialog(): void {
    render(<AddAccountDialog open={true} onOpenChange={vi.fn()} />)
    fireEvent.click(
      screen.getByRole("button", { name: /Microsoft 365 \/ Outlook\.com/ })
    )
  }

  it("offers the Microsoft 365 path and opens the registration-help step", () => {
    renderMicrosoftDialog()

    // The "needs-registration" state: no built-in registration exists, so
    // the flow explains the one-time app registration before the sign-in.
    expect(screen.getByText(/one-time personal registration/i)).toBeTruthy()
    expect(screen.getByText(/localhost:17248/)).toBeTruthy()
    expect(
      screen.getByText(/admin approval/i, { exact: false })
    ).toBeTruthy()
    expect(screen.getByLabelText(/Application \(client\) ID/)).toBeTruthy()
  })

  it("validates an empty Client ID before starting anything", () => {
    renderMicrosoftDialog()

    fireEvent.click(screen.getByRole("button", { name: "Continue in browser" }))

    expect(screen.getByRole("alert").textContent).toContain(
      "Enter your Microsoft app registration"
    )
    expect(vi.mocked(openUrl)).not.toHaveBeenCalled()
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })

  it("shows the connecting state, then a retryable consent-denied error", async () => {
    vi.mocked(invoke).mockImplementation(((command: string) => {
      if (command === "find_free_loopback_port") {
        return Promise.resolve(17248)
      }
      if (command !== "start_oauth_server") {
        return Promise.reject(new Error(`unexpected command: ${command}`))
      }
      return new Promise<{
        port: number
        code: string | null
        state: string | null
        error: string | null
        errorDescription: string | null
      }>((resolve) => {
        void vi
          .waitFor(() => {
            expect(vi.mocked(openUrl)).toHaveBeenCalledTimes(1)
          })
          .then(() => {
            const url = new URL(vi.mocked(openUrl).mock.calls[0][0] as string)
            resolve({
              port: 17248,
              code: null,
              state: url.searchParams.get("state"),
              error: "access_denied",
              errorDescription: "admin consent required",
            })
          })
      })
    }) as typeof invoke)

    renderMicrosoftDialog()
    fireEvent.change(
      screen.getByLabelText(/Application \(client\) ID/),
      { target: { value: "ms-client-1" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Continue in browser" }))

    // The connecting state while the loopback wait is pending.
    await screen.findByText(/Waiting for you to finish in the browser/)

    // Consent denial: an inline retryable error, no account created, and
    // the flow returns to the Client ID step.
    await screen.findByRole("alert")
    expect(screen.getByRole("alert").textContent).toContain(
      "Microsoft reported"
    )
    expect(screen.getByLabelText(/Application \(client\) ID/)).toBeTruthy()
  })
})
