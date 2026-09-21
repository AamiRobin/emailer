import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import { EMAILER_FIND_COMMAND_TYPE } from "../find-session"
import { SourceViewDialog } from "../source-view-dialog"
import { toast } from "sonner"
import type { EmailAccount } from "@/services/email/types"
import type { MessageRow } from "@/services/db/messages"

/**
 * Raw message source tests (task 1.2, mail-reading spec "Raw message
 * source"). The source fetch is injected (deps), so every network
 * assertion is mock-level: the ONLY seam touched is the provider fetch —
 * global fetch stays cold, and the rendering cannot load or execute
 * anything because the source enters the sandboxed frame HTML-ESCAPED.
 */

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

const toastMock = vi.mocked(toast)

const account: EmailAccount = {
  id: "acc-1",
  type: "gmail",
  email: "me@example.com",
  status: "active",
  isActive: true,
  isPinned: false,
}

const RAW_SOURCE = [
  "From: Ada <ada@example.com>",
  "To: me@example.com",
  "Subject: Hello <b>world</b>",
  "Date: Sat, 19 Sep 2026 10:00:00 +0000",
  "Message-ID: <m-1@example.com>",
  "",
  "<script>window.__pwned = true</script>",
  '<img src="https://attacker.example/pixel" alt="x">',
  "Plaintext signature — Grüße ✓",
].join("\r\n")

/** Minimal stored row: the dialog reads identity fields only. */
function messageRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "m-1",
    thread_id: "t-1",
    account_id: "acc-1",
    gmail_message_id: "g-1",
    imap_uid: null,
    imap_folder: null,
    message_id_header: "<m-1@example.com>",
    in_reply_to: null,
    references_header: null,
    subject: "Hello <b>world</b>",
    from_name: "Ada",
    from_address: "ada@example.com",
    to_json: null,
    cc_json: null,
    bcc_json: null,
    date: 1_700_000_000,
    snippet: null,
    body_html: null,
    body_text: null,
    headers: null,
    size_estimate: null,
    is_read: 1,
    is_flagged: 0,
    has_attachments: 0,
    parts_json: null,
    created_at: 1_700_000_000,
    auth_results: null,
    ...overrides,
  }
}

function renderDialog(
  fetchSource: (account: EmailAccount, message: MessageRow) => Promise<string>,
  overrides: { account?: EmailAccount | null; message?: MessageRow } = {}
) {
  return render(
    <SourceViewDialog
      message={overrides.message ?? messageRow()}
      account={overrides.account === undefined ? account : overrides.account}
      open
      onOpenChange={() => {}}
      deps={{ fetchSource: fetchSource as never }}
    />
  )
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(navigator, "clipboard")
})

describe("SourceViewDialog", () => {
  it("renders the raw source inert: escaped, monospace, no controller", async () => {
    const fetchSource = vi.fn(async () => RAW_SOURCE)
    const fetchSpy = vi.fn()
    const previousFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      renderDialog(fetchSource)
    } finally {
      globalThis.fetch = previousFetch
    }

    await waitFor(() =>
      expect(
        (screen.getByTestId("source-view-copy") as HTMLButtonElement).disabled
      ).toBe(false)
    )

    const srcdoc =
      document.querySelector("iframe")?.getAttribute("srcdoc") ?? ""

    // The hostile payload exists ONLY as escaped text — no element can
    // execute or load anything (renderPlainTextAsHtml escapes every <, &,
    // quote before the sanitizer ever sees it).
    expect(srcdoc).toContain(
      "&lt;script&gt;window.__pwned = true&lt;/script&gt;"
    )
    expect(srcdoc).not.toContain("<script>window.__pwned")
    expect(srcdoc).not.toContain('<img src="https://attacker.example')
    // (sanitize's DOM round-trip normalizes `&quot;` in text to a literal
    // quote — the tag still never becomes an element.)
    expect(srcdoc).toContain('&lt;img src="')
    // Bare URLs ARE linkified (the reading pane's plain-text behavior — the
    // anchor is inert until explicitly clicked, then routed to the OS
    // browser by the opener plugin; nothing is fetched by rendering).

    // The message's own angle brackets fare the same.
    expect(srcdoc).toContain("Subject: Hello &lt;b&gt;world&lt;/b&gt;")

    // Source frames are monospace and carry no find controller (task 1.1's
    // session is a reading-pane concern, not a source-view one).
    expect(srcdoc).toContain("ui-monospace")
    expect(srcdoc).not.toContain(EMAILER_FIND_COMMAND_TYPE)

    // The fetch happened exactly once; globalThis.fetch never fired.
    expect(fetchSource).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("copies the EXACT fetched source (spec: copy diagnostics)", async () => {
    const clipboardWrite = vi.fn<(text: string) => Promise<void>>(
      async () => {}
    )
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWrite },
      configurable: true,
    })
    const fetchSource = vi.fn(async () => RAW_SOURCE)
    renderDialog(fetchSource)
    await waitFor(() =>
      expect(
        (screen.getByTestId("source-view-copy") as HTMLButtonElement).disabled
      ).toBe(false)
    )

    fireEvent.click(screen.getByTestId("source-view-copy"))

    // The clipboard receives the fetched string itself — byte for byte —
    // never the escaped/linkified rendering.
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1))
    expect(clipboardWrite.mock.calls[0]?.[0]).toBe(RAW_SOURCE)
    expect(clipboardWrite.mock.calls[0]?.[0]).not.toContain("&lt;")
    expect(toastMock.success).toHaveBeenCalled()
  })

  it("shows provider failures inline and keeps copy disabled", async () => {
    const fetchSource = vi.fn(async () => {
      throw new Error("Gmail GET messages/x failed with 404")
    })
    renderDialog(fetchSource)

    await waitFor(() =>
      expect(screen.getByTestId("source-view-error").textContent).toContain(
        "404"
      )
    )
    expect(
      (screen.getByTestId("source-view-copy") as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it("without an account it degrades to the error state without fetching", async () => {
    const fetchSource = vi.fn(async () => RAW_SOURCE)
    renderDialog(fetchSource, { account: null })

    await waitFor(() =>
      expect(screen.getByTestId("source-view-error")).toBeDefined()
    )
    expect(fetchSource).not.toHaveBeenCalled()
  })
})
