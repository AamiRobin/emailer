import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import type { Editor } from "@tiptap/react"
import { readFile } from "@tauri-apps/plugin-fs"
import { open } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Composer view (tasks 8.1 + 8.2 + 8.3 + 8.6 + 8.7). Real TipTap runs
 * under jsdom: the editor instance is reachable through its DOM element
 * (`dom.editor`, attached by tiptap core), so formatting commands and
 * their serialized HTML are exercised end to end — including the
 * toolbar→store sync.
 *
 * Service boundary (same executor-injection pattern as
 * mail-shell-integrations.test.tsx): the executor module is mocked to
 * hand every consumer the seeded node:sqlite executor, so autosave saves,
 * discard/send draft deletions and contact autocomplete run the real
 * service SQL. The send service itself is mocked at its module boundary —
 * the full enqueue/filing flow is send.test.ts's job; here we assert what
 * the composer passes to it and how the UI reacts to its outcomes.
 */

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

vi.mock("@/services/composer/send", () => ({ sendComposerDraft: vi.fn() }))

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

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }))
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }))

const openMock = vi.mocked(open)
const readFileMock = vi.mocked(readFile)
const sendComposerDraftMock = vi.mocked(sendComposerDraft)
const toastMock = vi.mocked(toast)

import { createAccount } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { listDrafts, saveDraft } from "@/services/composer/drafts"
import {
  sendComposerDraft,
  type SendComposerDraftResult,
} from "@/services/composer/send"
import {
  DRAFT_AUTOSAVE_DEBOUNCE_MS,
  DRAFT_AUTOSAVE_POLL_INTERVAL_MS,
} from "@/services/composer/use-draft-autosave"
import { getComposerPayload, useComposerStore } from "@/stores/composer-store"
import { getAttachmentBytes } from "../attachment-bytes"
import {
  AttachmentTooLargeError,
  AttachmentTotalSizeError,
  MAX_SINGLE_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "../attachment-input"
import { Composer } from "../composer"

let executor: TestExecutor
let accountId: string

function openComposer(): void {
  useComposerStore.getState().openNew(accountId)
}

/** A queued result shaped like the send service's success value. */
function queuedResult(): Extract<
  SendComposerDraftResult,
  { status: "queued" }
> {
  return {
    status: "queued",
    accountId,
    opId: "op-1",
    threadId: "thread-1",
    messageId: "<sent@example.com>",
    queuedOffline: false,
  }
}

/** Seed an autosaved row under `draftKey` (what an earlier autosave would
 * have written), so discard/send deletion has something to remove. */
async function seedDraftRow(draftKey: string): Promise<void> {
  await saveDraft(executor, {
    accountId,
    draftKey,
    draft: {
      to: [],
      cc: [],
      bcc: [],
      subject: "autosaved earlier",
      bodyHtml: "",
    },
  })
}

/** Ranked-suggestion fixtures need explicit counts, so rows are seeded
 * directly (same approach as contacts.test.ts). */
async function seedContact(
  email: string,
  options?: { name?: string; interactionCount?: number }
): Promise<void> {
  await executor.execute(
    `INSERT INTO contacts (id, account_id, email, name, interaction_count,
       last_interaction_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      crypto.randomUUID(),
      accountId,
      email,
      options?.name ?? null,
      options?.interactionCount ?? 0,
      null,
    ]
  )
}

function getMountedEditor(): Editor {
  const element = document.querySelector(".tiptap") as
    (HTMLElement & { editor?: Editor }) | null
  if (!element?.editor) throw new Error("TipTap editor did not mount")
  return element.editor
}

function typeInto(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } })
}

function pressKey(input: HTMLElement, key: string): void {
  fireEvent.keyDown(input, { key })
}

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  accountId = await createAccount(executor)
})

afterEach(async () => {
  cleanup()
  useComposerStore.getState().reset()
  vi.useRealTimers()
  // Let the unmount autosave flush settle before closing the database.
  await act(async () => {})
  executorHolder.current = null
  executor.close()
  vi.clearAllMocks()
})

describe("Composer", () => {
  it("renders nothing while the composer store is closed", () => {
    const { container } = render(<Composer />)
    expect(container.firstChild).toBeNull()
  })

  it("opens with focus in the To field and shows subject and body", () => {
    openComposer()
    render(<Composer />)

    const toInput = screen.getByLabelText("To")
    expect(document.activeElement).toBe(toInput)
    expect(screen.getByLabelText("Subject")).toBeTruthy()
    expect(document.querySelector(".tiptap")).toBeTruthy()
    // Body placeholder (TipTap Placeholder extension).
    expect(
      document.querySelector('[data-placeholder="Write your message…"]')
    ).toBeTruthy()
  })

  it("Send enables only for a sendable draft (recipients + subject or body)", () => {
    openComposer()
    render(<Composer />)

    const send = screen.getByRole("button", {
      name: "Send",
    }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy()

    // A subject alone is not enough.
    typeInto(screen.getByLabelText("Subject"), "Hello")
    expect(send.disabled).toBe(true)

    // An invalid recipient still blocks.
    const toInput = screen.getByLabelText("To")
    typeInto(toInput, "not-an-email")
    pressKey(toInput, "Enter")
    expect(send.disabled).toBe(true)

    // Removing the invalid chip and adding a valid recipient + subject
    // enables (body alone works the same).
    pressKey(toInput, "Backspace")
    typeInto(toInput, "ada@example.com")
    pressKey(toInput, "Enter")
    expect(send.disabled).toBe(false)
  })

  it("Cc and Bcc text buttons reveal their fields", () => {
    openComposer()
    render(<Composer />)

    expect(screen.queryByLabelText("Cc")).toBeNull()
    expect(screen.queryByLabelText("Bcc")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Cc" }))
    expect(screen.getByLabelText("Cc")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Bcc" }))
    expect(screen.getByLabelText("Bcc")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Cc" }))
    expect(screen.queryByLabelText("Cc")).toBeNull()
  })

  it("parses typed addresses into chips on Enter and syncs the store", () => {
    openComposer()
    render(<Composer />)

    const toInput = screen.getByLabelText("To")
    typeInto(toInput, "ada@example.com, Ada L <ada@lovelace.dev>")
    pressKey(toInput, "Enter")

    expect(useComposerStore.getState().to).toEqual([
      { email: "ada@example.com" },
      { name: "Ada L", email: "ada@lovelace.dev" },
    ])
    expect(screen.getByText("ada@example.com")).toBeTruthy()
    expect(screen.getByText("Ada L")).toBeTruthy()
    // Input clears after commit.
    expect((toInput as HTMLInputElement).value).toBe("")
  })

  it("flags invalid chips with destructive styling before send", () => {
    openComposer()
    render(<Composer />)

    const toInput = screen.getByLabelText("To")
    typeInto(toInput, "not-an-email")
    pressKey(toInput, "Enter")

    // Raw input is kept in the store; validity is a UI-layer flag.
    expect(useComposerStore.getState().to).toEqual([{ email: "not-an-email" }])
    const chip = screen.getByText("not-an-email").closest("[data-invalid]")
    expect(chip).toBeTruthy()
    expect(chip?.className).toContain("border-destructive")
    // Native-tooltip + sr-only hint text.
    expect(
      screen.getByText("(invalid address)", { selector: ".sr-only" })
    ).toBeTruthy()
  })

  it("Backspace on an empty input removes the last chip", () => {
    openComposer()
    render(<Composer />)

    const toInput = screen.getByLabelText("To")
    typeInto(toInput, "a@x.com")
    pressKey(toInput, "Enter")
    expect(useComposerStore.getState().to).toHaveLength(1)

    pressKey(toInput, "Backspace")
    expect(useComposerStore.getState().to).toEqual([])
    expect(screen.queryByText("a@x.com")).toBeNull()
  })

  it("chip remove button drops that recipient", () => {
    openComposer()
    render(<Composer />)

    const toInput = screen.getByLabelText("To")
    typeInto(toInput, "a@x.com, b@x.com")
    pressKey(toInput, "Enter")
    expect(useComposerStore.getState().to).toHaveLength(2)

    fireEvent.click(screen.getByRole("button", { name: "Remove a@x.com" }))
    expect(useComposerStore.getState().to).toEqual([{ email: "b@x.com" }])
  })

  it("subject input syncs into the store", () => {
    openComposer()
    render(<Composer />)

    typeInto(screen.getByLabelText("Subject"), "Quarterly report")
    expect(useComposerStore.getState().subject).toBe("Quarterly report")
  })

  it("toolbar bold applies to selected text and serializes into store html", () => {
    openComposer()
    render(<Composer />)
    const editor = getMountedEditor()

    editor.commands.setContent("<p>hello world</p>")
    const bold = screen.getByRole("button", { name: "Bold" })
    expect(bold.getAttribute("aria-pressed")).toBe("false")

    editor.commands.selectAll()
    fireEvent.click(bold)

    expect(useComposerStore.getState().html).toContain(
      "<strong>hello world</strong>"
    )
    expect(bold.getAttribute("aria-pressed")).toBe("true")

    fireEvent.click(bold)
    expect(useComposerStore.getState().html).not.toContain("<strong>")
    expect(bold.getAttribute("aria-pressed")).toBe("false")
  })

  it("underline and bullet list commands reach the store html", () => {
    openComposer()
    render(<Composer />)
    const editor = getMountedEditor()

    editor.commands.setContent("<p>point one</p>")
    editor.commands.selectAll()
    fireEvent.click(screen.getByRole("button", { name: "Underline" }))
    expect(useComposerStore.getState().html).toContain("<u>")

    editor.commands.setContent("<ul><li><p>item</p></li></ul>")
    editor.commands.selectAll()
    fireEvent.click(screen.getByRole("button", { name: "Numbered list" }))
    expect(useComposerStore.getState().html).toContain("<ol>")
  })

  it("link popover applies a normalized href to the selection", () => {
    openComposer()
    render(<Composer />)
    const editor = getMountedEditor()

    editor.commands.setContent("<p>click here</p>")
    editor.commands.selectAll()

    fireEvent.click(screen.getByRole("button", { name: "Insert link" }))
    const urlInput = screen.getByLabelText("Link URL")
    typeInto(urlInput, "example.com/page")
    fireEvent.click(screen.getByRole("button", { name: "Apply link" }))

    expect(useComposerStore.getState().html).toContain(
      'href="https://example.com/page"'
    )
    // Popover closes after applying; the link toggle reflects the mark.
    expect(screen.queryByLabelText("Link URL")).toBeNull()
    expect(
      screen
        .getByRole("button", { name: "Insert link" })
        .getAttribute("aria-pressed")
    ).toBe("true")
  })

  it("typing in the editor body syncs html into the store", () => {
    openComposer()
    render(<Composer />)
    const editor = getMountedEditor()

    editor.commands.setContent("<p>Synced body</p>")
    expect(useComposerStore.getState().html).toBe("<p>Synced body</p>")
  })

  it("Discard of an empty draft is immediate (no confirmation)", async () => {
    openComposer()
    render(<Composer />)

    fireEvent.click(screen.getByRole("button", { name: "Discard" }))

    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    const state = useComposerStore.getState()
    expect(state.subject).toBe("")
    expect(state.to).toEqual([])
    expect(state.html).toBe("")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("Discard of a non-empty draft confirms, then deletes the row and resets", async () => {
    openComposer()
    render(<Composer />)
    const draftKey = useComposerStore.getState().draftKey
    expect(draftKey).toEqual(expect.any(String))
    await seedDraftRow(draftKey ?? "")

    typeInto(screen.getByLabelText("Subject"), "draft")
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))

    // Confirmation dialog for the non-empty draft.
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText("Discard draft?")).toBeTruthy()
    expect(
      within(dialog).getByText("Your message will be deleted.")
    ).toBeTruthy()

    // Cancel keeps the composer and its content.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(useComposerStore.getState().open).toBe(true)
    expect(useComposerStore.getState().subject).toBe("draft")

    // Confirming deletes the autosaved row and resets the composer.
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Discard",
      })
    )
    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    const state = useComposerStore.getState()
    expect(state.subject).toBe("")
    expect(state.to).toEqual([])
    expect(await listDrafts(executor, accountId)).toHaveLength(0)
  })

  it("reopening after close (fields kept) restores the stored body", () => {
    openComposer()
    const { unmount } = render(<Composer />)
    getMountedEditor().commands.setContent("<p>saved body</p>")
    useComposerStore.getState().close()
    unmount()

    // Draft-resume seam (task 8.6): the store still holds the body, and a
    // fresh mount picks it up as the editor's initial content.
    useComposerStore.setState({ open: true })
    render(<Composer />)

    expect(useComposerStore.getState().html).toBe("<p>saved body</p>")
    expect(document.querySelector(".tiptap p")?.textContent).toBe("saved body")
  })
})

describe("Composer attachments (task 8.5)", () => {
  function renderOpen(): void {
    openComposer()
    render(<Composer />)
  }

  function composerSection(): HTMLElement {
    const section = document.querySelector("section")
    if (!section) throw new Error("composer section did not mount")
    return section
  }

  function dropFiles(files: File[]): void {
    fireEvent.drop(composerSection(), { dataTransfer: { files } })
  }

  function fileOf(name: string, bytes: number[], type?: string): File {
    return new File([new Uint8Array(bytes)], name, type ? { type } : undefined)
  }

  it("Attach file opens the system picker (multiple) and adds chips with name and size", async () => {
    renderOpen()
    openMock.mockResolvedValue([
      "/Users/me/Downloads/report.pdf",
      "/tmp/notes.txt",
    ])
    readFileMock.mockImplementation(async (path) =>
      String(path).endsWith(".pdf")
        ? new Uint8Array([1, 2, 3, 4])
        : new Uint8Array([9, 9])
    )

    fireEvent.click(screen.getByRole("button", { name: "Attach file" }))
    await waitFor(() => {
      expect(screen.getByText("report.pdf")).toBeTruthy()
    })
    expect(screen.getByText("notes.txt")).toBeTruthy()
    expect(screen.getByText("4 B")).toBeTruthy()

    // Metadata + resolved MIME types (extension map) in the store.
    expect(useComposerStore.getState().attachments).toEqual([
      {
        id: expect.any(String),
        name: "report.pdf",
        size: 4,
        mimeType: "application/pdf",
      },
      {
        id: expect.any(String),
        name: "notes.txt",
        size: 2,
        mimeType: "text/plain",
      },
    ])
    // The payload carries the bytes base64-encoded.
    expect(getComposerPayload().attachments).toEqual([
      {
        filename: "report.pdf",
        mimeType: "application/pdf",
        contentBase64: btoa(String.fromCharCode(1, 2, 3, 4)),
      },
      {
        filename: "notes.txt",
        mimeType: "text/plain",
        contentBase64: btoa(String.fromCharCode(9, 9)),
      },
    ])
  })

  it("cancelling the picker adds nothing", async () => {
    renderOpen()
    openMock.mockResolvedValue(null)
    fireEvent.click(screen.getByRole("button", { name: "Attach file" }))
    await waitFor(() => expect(openMock).toHaveBeenCalled())
    expect(useComposerStore.getState().attachments).toEqual([])
    // The strip renders nothing without attachments.
    expect(screen.queryByText(/files? ·/)).toBeNull()
  })

  it("dropped OS files are read at drop time; the surface highlights while dragging", async () => {
    renderOpen()

    fireEvent.dragEnter(composerSection())
    expect(composerSection().className).toContain("ring-2")
    // Nested dragleave (entering a child) keeps the highlight.
    fireEvent.dragLeave(composerSection())
    fireEvent.dragEnter(composerSection())
    expect(composerSection().className).toContain("ring-2")

    dropFiles([fileOf("photo.png", [10, 20, 30], "image/png")])
    await waitFor(() => {
      expect(screen.getByText("photo.png")).toBeTruthy()
    })
    expect(composerSection().className).not.toContain("ring-2")
    expect(useComposerStore.getState().attachments).toEqual([
      {
        id: expect.any(String),
        name: "photo.png",
        size: 3,
        mimeType: "image/png",
      },
    ])
    // Dropping a non-file drag (no items) changes nothing.
    dropFiles([])
    expect(useComposerStore.getState().attachments).toHaveLength(1)
  })

  it("chip remove drops the metadata and the registered bytes", async () => {
    renderOpen()
    dropFiles([fileOf("gone.txt", [1], "text/plain")])
    await waitFor(() => {
      expect(screen.getByText("gone.txt")).toBeTruthy()
    })
    const attachment = useComposerStore.getState().attachments[0]
    expect(getAttachmentBytes(attachment.id)).toBeDefined()

    fireEvent.click(screen.getByRole("button", { name: "Remove gone.txt" }))
    expect(useComposerStore.getState().attachments).toEqual([])
    expect(getAttachmentBytes(attachment.id)).toBeUndefined()
    expect(screen.queryByText("gone.txt")).toBeNull()
  })

  it("shows a total size indicator against the cap", async () => {
    renderOpen()
    dropFiles([
      fileOf("one.txt", new Array(1500).fill(1), "text/plain"),
      fileOf("two.txt", new Array(10).fill(2), "text/plain"),
    ])
    await waitFor(() => {
      expect(screen.getByText(/2 files/)).toBeTruthy()
    })
    // 1500 B + 10 B = 1510 B → "1 KB" (rounded); cap label is "25 MB".
    expect(screen.getByText(/2 files · 1 KB \/ 25 MB/)).toBeTruthy()
  })

  it("rejects an over-cap single file with a visible inline error", async () => {
    renderOpen()
    // Uint8Array keeps the over-cap payload cheap to build.
    const oversized = new File(
      [new Uint8Array(MAX_SINGLE_ATTACHMENT_BYTES + 1)],
      "huge.bin",
      { type: "application/octet-stream" }
    )
    dropFiles([oversized])
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/huge\.bin/)
    expect(alert.textContent).toContain("20 MB")
    // Nothing was added, nothing leaked into the registry or the payload.
    expect(useComposerStore.getState().attachments).toEqual([])
    expect(getComposerPayload().attachments).toBeUndefined()
  })

  it("enforces the total cap: fitting files are added, the overflowing one is rejected", async () => {
    renderOpen()
    const half = new Uint8Array(MAX_TOTAL_ATTACHMENT_BYTES / 2) // 12.5 MB each
    const asFile = (name: string) => new File([half], name)
    dropFiles([
      asFile("a.bin"),
      asFile("b.bin"),
      asFile("c.bin"), // would push the total past 25 MB
    ])
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/c\.bin/)
    expect(useComposerStore.getState().attachments.map((a) => a.name)).toEqual([
      "a.bin",
      "b.bin",
    ])
  })

  it("reports total-cap breaches with the typed error text", () => {
    // Pure check of the rejection classes used for the inline error.
    expect(
      new AttachmentTooLargeError("f", 21 * 1024 * 1024).message
    ).toContain("20 MB")
    expect(new AttachmentTotalSizeError("g").message).toContain("25 MB")
  })
})

describe("Composer draft key (task 8.6)", () => {
  it("every open gets a fresh key; close keeps it, reset clears it", () => {
    useComposerStore.getState().openNew(accountId)
    const first = useComposerStore.getState().draftKey
    expect(first).toEqual(expect.any(String))

    useComposerStore.getState().reset()
    expect(useComposerStore.getState().draftKey).toBeNull()

    useComposerStore.getState().openWith({ kind: "new" }, accountId)
    const second = useComposerStore.getState().draftKey
    expect(second).toEqual(expect.any(String))
    expect(second).not.toBe(first)

    // close() keeps the fields — and the key that addresses the autosaved
    // row — for a later resume.
    useComposerStore.getState().close()
    expect(useComposerStore.getState().draftKey).toBe(second)
  })
})

describe("Composer send wiring (task 8.7)", () => {
  function renderSendable(): string {
    openComposer()
    render(<Composer />)
    const toInput = screen.getByLabelText("To")
    typeInto(toInput, "ada@example.com")
    pressKey(toInput, "Enter")
    typeInto(screen.getByLabelText("Subject"), "Quarterly report")
    const draftKey = useComposerStore.getState().draftKey
    expect(draftKey).toEqual(expect.any(String))
    return draftKey ?? ""
  }

  it("Send calls sendComposerDraft with the payload and draft key, toasts and resets", async () => {
    const draftKey = renderSendable()
    await seedDraftRow(draftKey)
    sendComposerDraftMock.mockResolvedValue(queuedResult())

    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    expect(sendComposerDraftMock).toHaveBeenCalledTimes(1)
    expect(sendComposerDraftMock).toHaveBeenCalledWith({
      accountId,
      draftKey,
      mode: { kind: "new" },
      payload: expect.objectContaining({
        to: [{ email: "ada@example.com" }],
        subject: "Quarterly report",
      }),
    })
    expect(toastMock.success).toHaveBeenCalledWith("Message sent")

    // The store is fully reset and the autosaved row is gone (send
    // removes the draft).
    const state = useComposerStore.getState()
    expect(state.to).toEqual([])
    expect(state.subject).toBe("")
    expect(await listDrafts(executor, accountId)).toHaveLength(0)
  })

  it("an offline send toasts 'Message queued' via the returned status", async () => {
    renderSendable()
    sendComposerDraftMock.mockResolvedValue({
      ...queuedResult(),
      queuedOffline: true,
    })

    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    expect(toastMock.info).toHaveBeenCalledWith("Message queued")
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it("a thrown send error keeps the composer open, shows the error and Retry re-invokes", async () => {
    renderSendable()
    sendComposerDraftMock.mockRejectedValue(new Error("database is locked"))

    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("database is locked")
    expect(useComposerStore.getState().open).toBe(true)
    expect(toastMock.success).not.toHaveBeenCalled()

    sendComposerDraftMock.mockResolvedValue(queuedResult())
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    expect(sendComposerDraftMock).toHaveBeenCalledTimes(2)
    expect(toastMock.success).toHaveBeenCalledWith("Message sent")
    expect(await listDrafts(executor, accountId)).toHaveLength(0)
  })

  it("a {status: failed} result surfaces the sanitized error without closing", async () => {
    renderSendable()
    sendComposerDraftMock.mockResolvedValue({
      status: "failed",
      error: "unable to reach local storage",
    })

    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("unable to reach local storage")
    expect(useComposerStore.getState().open).toBe(true)
    // The composer keeps its content for a retry.
    expect(useComposerStore.getState().subject).toBe("Quarterly report")
  })

  it("the sent payload carries registered attachment bytes (8.5 + 8.7)", async () => {
    openComposer()
    render(<Composer />)
    const toInput = screen.getByLabelText("To")
    typeInto(toInput, "ada@example.com")
    pressKey(toInput, "Enter")
    typeInto(screen.getByLabelText("Subject"), "With attachment")
    const section = document.querySelector("section")
    if (!section) throw new Error("composer section did not mount")
    fireEvent.drop(section, {
      dataTransfer: {
        files: [new File([new Uint8Array([1, 2, 3])], "notes.txt")],
      },
    })
    await waitFor(() => {
      expect(screen.getByText("notes.txt")).toBeTruthy()
    })
    sendComposerDraftMock.mockResolvedValue(queuedResult())

    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })

    expect(sendComposerDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          attachments: [
            {
              filename: "notes.txt",
              mimeType: "text/plain",
              contentBase64: btoa(String.fromCharCode(1, 2, 3)),
            },
          ],
        }),
      })
    )
    // The attachment registry is cleared with the reset.
    expect(getComposerPayload().attachments).toBeUndefined()
  })
})

describe("Composer draft autosave (task 8.6)", () => {
  it("persists edits under the composer's draft key after the debounce window", async () => {
    vi.useFakeTimers()
    openComposer()
    render(<Composer />)
    const draftKey = useComposerStore.getState().draftKey
    expect(draftKey).toEqual(expect.any(String))

    // First poll primes the autosave baseline.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_POLL_INTERVAL_MS + 100)
    })
    typeInto(screen.getByLabelText("Subject"), "autosaved subject")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        DRAFT_AUTOSAVE_POLL_INTERVAL_MS + DRAFT_AUTOSAVE_DEBOUNCE_MS + 500
      )
    })

    const drafts = await listDrafts(executor, accountId)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].draftKey).toBe(draftKey)
    expect(drafts[0].subject).toBe("autosaved subject")
  })

  it("flushes the pending snapshot when the composer unmounts via reset", async () => {
    vi.useFakeTimers()
    openComposer()
    render(<Composer />)
    const draftKey = useComposerStore.getState().draftKey ?? ""

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_POLL_INTERVAL_MS + 100)
    })
    typeInto(screen.getByLabelText("Subject"), "unmount flush")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_POLL_INTERVAL_MS + 100)
    })

    // Closing without discard: the last observed snapshot lands in Drafts
    // (cleanup flush), and the key survives for a resume.
    act(() => {
      useComposerStore.getState().close()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const drafts = await listDrafts(executor, accountId)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].subject).toBe("unmount flush")
    expect(drafts[0].draftKey).toBe(draftKey)
  })
})

describe("Recipient autocomplete (task 8.3)", () => {
  it("suggests contacts ranked by interaction frequency; click accepts", async () => {
    await seedContact("alissa@x.com", { interactionCount: 2 })
    await seedContact("alice@example.com", {
      name: "Alice",
      interactionCount: 5,
    })

    openComposer()
    render(<Composer />)
    const toInput = screen.getByLabelText("To")
    typeInto(toInput, "al")

    const options = await screen.findAllByRole("option")
    expect(options).toHaveLength(2)
    // Service ranking: most-contacted first (both prefix-match "al").
    expect(options[0].textContent).toContain("alice@example.com")
    expect(options[0].textContent).toContain("Alice")
    expect(options[1].textContent).toContain("alissa@x.com")
    expect(options[0].getAttribute("aria-selected")).toBe("true")

    fireEvent.click(options[0])
    expect(useComposerStore.getState().to).toEqual([
      { name: "Alice", email: "alice@example.com" },
    ])
    // The chip fills, the pending text is gone, the list closes.
    expect((toInput as HTMLInputElement).value).toBe("")
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("ArrowDown moves the highlight and Enter accepts that suggestion", async () => {
    await seedContact("alice@example.com", {
      name: "Alice",
      interactionCount: 5,
    })
    await seedContact("alissa@x.com", { interactionCount: 2 })

    openComposer()
    render(<Composer />)
    const toInput = screen.getByLabelText("To")
    typeInto(toInput, "al")

    const options = await screen.findAllByRole("option")
    expect(options).toHaveLength(2)
    expect(options[0].getAttribute("aria-selected")).toBe("true")

    pressKey(toInput, "ArrowDown")
    expect(options[1].getAttribute("aria-selected")).toBe("true")

    pressKey(toInput, "Enter")
    expect(useComposerStore.getState().to).toEqual([{ email: "alissa@x.com" }])
    expect((toInput as HTMLInputElement).value).toBe("")
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("Escape closes the suggestion list without committing", async () => {
    await seedContact("alice@example.com", { name: "Alice" })

    openComposer()
    render(<Composer />)
    const toInput = screen.getByLabelText("To")
    typeInto(toInput, "al")
    await screen.findByRole("listbox", { name: "Contact suggestions" })

    pressKey(toInput, "Escape")
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(useComposerStore.getState().to).toEqual([])
    expect((toInput as HTMLInputElement).value).toBe("al")
  })

  it("offers nothing for a complete address or unmatched text", async () => {
    await seedContact("alice@example.com", { name: "Alice" })

    openComposer()
    render(<Composer />)
    const toInput = screen.getByLabelText("To")

    // A complete, valid address is a finished chip — no popover.
    typeInto(toInput, "alice@example.com")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(screen.queryByRole("listbox")).toBeNull()

    // Text matching no contact: no list either.
    typeInto(toInput, "zz@nowhere")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(screen.queryByRole("listbox")).toBeNull()
  })
})
