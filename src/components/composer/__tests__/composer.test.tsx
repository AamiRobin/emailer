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

vi.mock("@/services/composer/send", async (importOriginal) => ({
  // sendComposerDraft is the module boundary under test here; the real
  // resolveMissingPgpRecipients stays live (pure settings reads — the
  // missing-key guard exercises the actual 18.4 lookup).
  ...(await importOriginal<object>()),
  sendComposerDraft: vi.fn(),
}))

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

import {
  createAccount,
  createThread,
  uid,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { upsertManualAlias } from "@/services/db/aliases"
import { setSetting } from "@/services/db/settings"
import {
  privateKeysSettingKey,
  publicKeysSettingKey,
} from "@/services/crypto/pgp-keys"
import { createSnippet } from "@/services/db/snippets"
import { insertMessage } from "@/services/db/messages"
import { listDrafts, saveDraft } from "@/services/composer/drafts"
import {
  sendComposerDraft,
  type SendComposerDraftResult,
} from "@/services/composer/send"
import {
  DRAFT_AUTOSAVE_DEBOUNCE_MS,
  DRAFT_AUTOSAVE_POLL_INTERVAL_MS,
} from "@/services/composer/use-draft-autosave"
import {
  attachmentGuardSettingKey,
  getAttachmentGuardSuppressed,
  sendDelaySettingKey,
} from "@/services/settings/preferences"
import { getComposerPayload, useComposerStore } from "@/stores/composer-store"
import { getScheduleSendPresets } from "@/components/layout/use-scheduled-sends"
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
  // Kill any leaked undo window (its timers) before dropping the draft.
  useComposerStore.getState().cancelUndoSend()
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
  // These tests exercise the IMMEDIATE send path, so undo send is turned
  // off for the account; the window itself has its own suites (5.1/5.2).
  beforeEach(async () => {
    await setSetting(executor, sendDelaySettingKey(accountId), 0)
  })

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
      fromAlias: null, // no alias chosen — the bare account identity
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

  it("a positive undo delay starts the pre-send window instead of sending (5.1/5.2)", async () => {
    await setSetting(executor, sendDelaySettingKey(accountId), 5)
    renderSendable()
    sendComposerDraftMock.mockResolvedValue(queuedResult())

    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    // Nothing transmitted: the store holds the window and the banner
    // state instead (expiry is the undo-send service/store suites' job).
    expect(sendComposerDraftMock).not.toHaveBeenCalled()
    const window = useComposerStore.getState().undoWindow
    expect(window).toMatchObject({
      accountId,
      subject: "Quarterly report",
      totalSeconds: 5,
      remainingSeconds: 5,
    })

    // Leave no live timer behind for later tests.
    expect(useComposerStore.getState().cancelUndoSend()).toBe(true)
    expect(useComposerStore.getState().open).toBe(true)
  })
})

describe("Composer send guards (task 5.3)", () => {
  // Guards are verified against the IMMEDIATE send path; the undo-send
  // window itself has its own suites (5.1/5.2) and starts only after the
  // prompts are answered.
  beforeEach(async () => {
    await setSetting(executor, sendDelaySettingKey(accountId), 0)
  })

  /** Open the composer with a recipient and a body; the subject stays
   * empty unless given. */
  function renderWithBody(bodyHtml: string, subject?: string): void {
    openComposer()
    render(<Composer />)
    const toInput = screen.getByLabelText("To")
    typeInto(toInput, "ada@example.com")
    pressKey(toInput, "Enter")
    // Wrapped in act: setContent syncs the store outside a React event,
    // and the Send button's canSend gate reads the subscribed html.
    act(() => {
      getMountedEditor().commands.setContent(bodyHtml)
    })
    if (subject !== undefined) {
      typeInto(screen.getByLabelText("Subject"), subject)
    }
  }

  it("prompts the forgotten-attachment reminder before sending", async () => {
    renderWithBody("<p>I attached the report</p>", "Quarterly report")
    sendComposerDraftMock.mockResolvedValue(queuedResult())

    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Missing attachment?")).toBeTruthy()
    expect(
      within(dialog).getByRole("button", { name: "Send anyway" })
    ).toBeTruthy()
    // A guard prompt is not a send: nothing was transmitted.
    expect(sendComposerDraftMock).not.toHaveBeenCalled()
    expect(useComposerStore.getState().open).toBe(true)
  })

  it("'Attach a file' goes back and opens the picker without sending", async () => {
    renderWithBody("<p>I attached the report</p>", "Quarterly report")
    sendComposerDraftMock.mockResolvedValue(queuedResult())
    openMock.mockResolvedValue(null)

    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Attach a file",
      })
    )

    await waitFor(() => expect(openMock).toHaveBeenCalled())
    // The attempt is aborted: the prompt closes, the composer keeps the
    // draft and nothing was sent.
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(sendComposerDraftMock).not.toHaveBeenCalled()
    expect(useComposerStore.getState().open).toBe(true)
  })

  it("'Send anyway' proceeds with the send", async () => {
    renderWithBody("<p>I attached the report</p>", "Quarterly report")
    sendComposerDraftMock.mockResolvedValue(queuedResult())

    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Send anyway",
      })
    )

    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    expect(sendComposerDraftMock).toHaveBeenCalledTimes(1)
  })

  it("queues the empty-subject confirmation after the attachment guard, each once per attempt", async () => {
    renderWithBody("<p>I attached the report</p>") // no subject
    sendComposerDraftMock.mockResolvedValue(queuedResult())

    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    // First prompt: the attachment reminder.
    const attachmentDialog = await screen.findByRole("dialog")
    expect(
      within(attachmentDialog).getByText("Missing attachment?")
    ).toBeTruthy()

    // Confirming it advances to the NEXT guard — never the same one twice.
    fireEvent.click(
      within(attachmentDialog).getByRole("button", { name: "Send anyway" })
    )
    const subjectDialog = await screen.findByRole("dialog")
    expect(
      within(subjectDialog).getByText("Send without a subject?")
    ).toBeTruthy()

    // The second answer sends; each guard fired exactly once.
    fireEvent.click(
      within(subjectDialog).getByRole("button", { name: "Send anyway" })
    )
    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    expect(sendComposerDraftMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("confirms sending with an empty subject; 'Add a subject' goes back", async () => {
    renderWithBody("<p>Here is the update</p>") // no wording, no subject
    sendComposerDraftMock.mockResolvedValue(queuedResult())

    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Send without a subject?")).toBeTruthy()
    expect(sendComposerDraftMock).not.toHaveBeenCalled()

    // Going back aborts the attempt and focuses the subject field.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add a subject" })
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(sendComposerDraftMock).not.toHaveBeenCalled()
    expect(useComposerStore.getState().open).toBe(true)
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Subject"))
    })
  })

  it("a suppressed guard does not fire for the account", async () => {
    await setSetting(executor, attachmentGuardSettingKey(accountId), true)
    renderWithBody("<p>I attached the report</p>", "Quarterly report")
    sendComposerDraftMock.mockResolvedValue(queuedResult())

    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    expect(sendComposerDraftMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("'Don't ask again' persists the suppression for the account", async () => {
    renderWithBody("<p>I attached the report</p>", "Quarterly report")
    sendComposerDraftMock.mockResolvedValue(queuedResult())

    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    const dialog = await screen.findByRole("dialog")
    // The prompt's one checkbox: "Don't ask again for this account".
    fireEvent.click(within(dialog).getByRole("checkbox"))
    fireEvent.click(within(dialog).getByRole("button", { name: "Send anyway" }))
    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    expect(sendComposerDraftMock).toHaveBeenCalledTimes(1)
    expect(await getAttachmentGuardSuppressed(executor, accountId)).toBe(true)
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

describe("Composer snippets (task 6.2)", () => {
  /** Seed one snippet with a shortcut (menu + keyboard paths) and one
   * without (menu-only). */
  async function seedSnippets(): Promise<void> {
    await createSnippet(executor, {
      name: "Thanks",
      body: "Thanks so much!\n\nThe Team",
      shortcut: "thx",
    })
    await createSnippet(executor, {
      name: "Signature",
      body: "Signed,\nTest User",
    })
    await createSnippet(executor, {
      name: "Be right back",
      body: "Be right back soon",
      shortcut: "brb",
    })
  }

  /** Open the composer and block until the snippet list round-trip
   * finished (opening the picker awaits an entry, then closes it). */
  async function openWithSnippetsLoaded(): Promise<void> {
    openComposer()
    render(<Composer />)
    fireEvent.click(screen.getByRole("button", { name: "Insert snippet" }))
    await screen.findByRole("listbox", { name: "Snippets" })
    fireEvent.click(screen.getByRole("button", { name: "Insert snippet" }))
    expect(screen.queryByRole("listbox", { name: "Snippets" })).toBeNull()
  }

  it("picker lists snippets by name with shortcut and body preview", async () => {
    await seedSnippets()
    await openWithSnippetsLoaded()

    fireEvent.click(screen.getByRole("button", { name: "Insert snippet" }))
    const list = await screen.findByRole("listbox", { name: "Snippets" })

    const thanks = within(list).getByRole("button", { name: "Insert Thanks" })
    expect(within(thanks).getByText("thx")).toBeTruthy()
    expect(thanks.textContent).toContain("Thanks so much!")
    expect(thanks.textContent).toContain("The Team")
    const signature = within(list).getByRole("button", {
      name: "Insert Signature",
    })
    expect(signature.textContent).toContain("Signed,")
    // No shortcut kbd on the shortcut-less snippet (menu-only).
    expect(signature.querySelector("kbd")).toBeNull()
  })

  it("picking a snippet inserts its body at the cursor, after existing text", async () => {
    await seedSnippets()
    await openWithSnippetsLoaded()
    const editor = getMountedEditor()

    editor.commands.setContent("<p>Before: </p>")
    editor.commands.focus("end")

    fireEvent.click(screen.getByRole("button", { name: "Insert snippet" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Insert Thanks" })
    )

    const html = useComposerStore.getState().html
    // Inserted at the caret (end of "Before: "), not appended or replacing
    // the draft; the multi-paragraph body lands as proper paragraphs.
    expect(html).toContain("Before:")
    expect(html.indexOf("Before:")).toBeLessThan(
      html.indexOf("Thanks so much!")
    )
    expect(html).toContain("<p>The Team</p>")

    // The picker closes after insertion.
    expect(screen.queryByRole("listbox", { name: "Snippets" })).toBeNull()
  })

  it("typing a shortcut then Space expands it to the body at the cursor", async () => {
    await seedSnippets()
    await openWithSnippetsLoaded()
    const editor = getMountedEditor()
    const editorDom = document.querySelector(".tiptap") as HTMLElement

    // Simulate the typed text: "Hello " already there, "brb" typed last.
    editor.commands.setContent("<p>Hello brb</p>")
    editor.commands.focus("end")
    expect(useComposerStore.getState().html).toBe("<p>Hello brb</p>")

    fireEvent.keyDown(editorDom, { key: " " })

    // The typed shortcut is replaced in place by the single-block body
    // (inline merge, no paragraph split); the trigger space is consumed.
    expect(useComposerStore.getState().html).toBe(
      "<p>Hello Be right back soon</p>"
    )

    // A multi-paragraph body expands as proper paragraphs, replacing only
    // the shortcut word.
    editor.commands.setContent("<p>Go thx</p>")
    editor.commands.focus("end")
    fireEvent.keyDown(editorDom, { key: " " })

    expect(useComposerStore.getState().html).toBe(
      "<p>Go </p><p>Thanks so much!</p><p>The Team</p>"
    )
  })

  it("space after text without a matching shortcut inserts nothing", async () => {
    await seedSnippets()
    await openWithSnippetsLoaded()
    const editor = getMountedEditor()

    editor.commands.setContent("<p>Hello there</p>")
    editor.commands.focus("end")

    fireEvent.keyDown(document.querySelector(".tiptap") as HTMLElement, {
      key: " ",
    })

    expect(useComposerStore.getState().html).toBe("<p>Hello there</p>")
  })

  it("does not expand during IME composition (isComposing / keyCode 229)", async () => {
    await seedSnippets()
    await openWithSnippetsLoaded()
    const editor = getMountedEditor()
    const editorDom = document.querySelector(".tiptap") as HTMLElement

    editor.commands.setContent("<p>Hello brb</p>")
    editor.commands.focus("end")

    // Asian IME: the keydown that commits a candidate fires with
    // isComposing set (or the legacy keyCode 229) — expanding then would
    // corrupt the composing text, so the space must pass through.
    fireEvent.keyDown(editorDom, { key: " ", isComposing: true })
    expect(useComposerStore.getState().html).toBe("<p>Hello brb</p>")

    fireEvent.keyDown(editorDom, { key: " ", keyCode: 229 })
    expect(useComposerStore.getState().html).toBe("<p>Hello brb</p>")

    // Control: the same space without composition expands normally.
    fireEvent.keyDown(editorDom, { key: " " })
    expect(useComposerStore.getState().html).toBe(
      "<p>Hello Be right back soon</p>"
    )
  })
})

describe("Composer From picker (task 16.2, design D10)", () => {
  const DEFAULT_ALIAS = "team-default@example.com"
  const OTHER_ALIAS = "work-alias@example.com"

  function fromSelect(): HTMLSelectElement {
    return screen.getByLabelText("From address") as HTMLSelectElement
  }

  async function seedAliases(options?: {
    defaultEmail?: string
  }): Promise<void> {
    // Written through the CRUD layer: isDefault sweeps the account.
    await upsertManualAlias(executor, accountId, {
      email: OTHER_ALIAS,
      displayName: "Work Alias",
    })
    await upsertManualAlias(executor, accountId, {
      email: options?.defaultEmail ?? DEFAULT_ALIAS,
      displayName: "Default Alias",
      isDefault: true,
    })
  }

  /** Seed a received message whose To list was addressed to `toEmails`. */
  async function seedIncomingMessage(
    toEmails: string[],
    ccEmails: string[] = []
  ): Promise<string> {
    const threadId = await createThread(executor, accountId, {
      subject: "Thread about aliases",
    })
    const id = uid("msg")
    await insertMessage(executor, {
      id,
      threadId,
      accountId,
      messageIdHeader: `<${id}@sender.example>`,
      subject: "Thread about aliases",
      fromAddress: "ada@example.com",
      to: toEmails.map((email) => ({ email })),
      cc: ccEmails.map((email) => ({ email })),
      date: Math.floor(Date.now() / 1000),
      snippet: "hello",
      bodyText: "hello",
    })
    return id
  }

  it("renders the account identity plus every alias (default first)", async () => {
    // No default alias here: the picker must show the bare identity as
    // the visible value when nothing was preselected.
    await upsertManualAlias(executor, accountId, {
      email: OTHER_ALIAS,
      displayName: "Work Alias",
    })
    await upsertManualAlias(executor, accountId, {
      email: DEFAULT_ALIAS,
      displayName: "Default Alias",
    })
    openComposer()
    render(<Composer />)

    const select = await screen.findByLabelText("From address")
    const labels = Array.from(select.querySelectorAll("option")).map(
      (option) => option.textContent
    )
    expect(labels).toEqual([
      expect.stringMatching(/Account address/),
      "Default Alias <team-default@example.com>",
      "Work Alias <work-alias@example.com>",
    ])
    // Without a selection the bare identity is the visible value.
    expect((select as HTMLSelectElement).value).toBe("")
  })

  it("renders nothing without aliases", () => {
    openComposer()
    render(<Composer />)
    expect(screen.queryByLabelText("From address")).toBeNull()
  })

  it("choosing an alias stores it; choosing the account identity clears it", async () => {
    await seedAliases()
    openComposer()
    render(<Composer />)
    await screen.findByLabelText("From address")

    fireEvent.change(fromSelect(), { target: { value: OTHER_ALIAS } })
    expect(useComposerStore.getState().fromAlias).toEqual({
      email: OTHER_ALIAS,
      name: "Work Alias",
    })

    fireEvent.change(fromSelect(), { target: { value: "" } })
    expect(useComposerStore.getState().fromAlias).toBeNull()
  })

  it("preselects the account's default alias on open", async () => {
    await seedAliases()
    openComposer()
    render(<Composer />)

    await waitFor(() => {
      expect(useComposerStore.getState().fromAlias).toEqual({
        email: DEFAULT_ALIAS,
        name: "Default Alias",
      })
    })
    expect(fromSelect().value).toBe(DEFAULT_ALIAS)
  })

  it("a reply preselects the alias the original message was addressed to", async () => {
    await seedAliases()
    const messageId = await seedIncomingMessage([
      "other@example.com",
      "WORK-alias@example.com", // case-insensitive match
    ])

    useComposerStore.getState().openWith(
      {
        kind: "reply",
        replyAll: false,
        sourceMessageId: messageId,
      },
      accountId
    )
    render(<Composer />)

    await waitFor(() => {
      expect(useComposerStore.getState().fromAlias).toEqual({
        email: OTHER_ALIAS,
        name: "Work Alias",
      })
    })
    // The addressed alias wins over the account's default.
    expect(useComposerStore.getState().fromAlias?.email).toBe(OTHER_ALIAS)
  })

  it("a reply matches the original Cc list too", async () => {
    await seedAliases()
    const messageId = await seedIncomingMessage(
      ["someone-else@example.com"],
      [DEFAULT_ALIAS]
    )

    useComposerStore
      .getState()
      .openWith(
        { kind: "reply", replyAll: false, sourceMessageId: messageId },
        accountId
      )
    render(<Composer />)

    await waitFor(() => {
      expect(useComposerStore.getState().fromAlias?.email).toBe(DEFAULT_ALIAS)
    })
  })

  it("a reply to a message addressed to no alias falls back to the default", async () => {
    await seedAliases()
    const messageId = await seedIncomingMessage(["unrelated@example.com"])

    useComposerStore
      .getState()
      .openWith(
        { kind: "reply", replyAll: false, sourceMessageId: messageId },
        accountId
      )
    render(<Composer />)

    await waitFor(() => {
      expect(useComposerStore.getState().fromAlias).toEqual({
        email: DEFAULT_ALIAS,
        name: "Default Alias",
      })
    })
  })
})

describe("Composer PGP send (task 18.5)", () => {
  // The PGP send-path tests run against the IMMEDIATE send path (no undo
  // window); key rows are seeded directly into the 18.4 settings storage —
  // armor strings only, no openpgp under jsdom.
  const FINGERPRINT = "a".repeat(40)

  beforeEach(async () => {
    await setSetting(executor, sendDelaySettingKey(accountId), 0)
  })

  function renderSendable(): string {
    openComposer()
    render(<Composer />)
    const toInput = screen.getByLabelText("To")
    typeInto(toInput, "ada@example.com")
    pressKey(toInput, "Enter")
    typeInto(screen.getByLabelText("Subject"), "Quarterly report")
    return useComposerStore.getState().draftKey ?? ""
  }

  async function seedRecipientKey(email = "ada@example.com"): Promise<void> {
    await setSetting(executor, publicKeysSettingKey(accountId), [
      {
        id: FINGERPRINT,
        armor: "-----BEGIN PGP PUBLIC KEY BLOCK-----",
        email,
        source: "imported",
        createdAt: Math.floor(Date.now() / 1000),
      },
    ])
  }

  async function seedDefaultPrivateKey(): Promise<void> {
    await setSetting(executor, privateKeysSettingKey(accountId), [
      {
        id: FINGERPRINT,
        armor: "-----BEGIN PGP PRIVATE KEY BLOCK-----",
        wrappedArmor: "v1.wrapped",
        name: "Me User",
        email: "me@example.com",
        createdAt: Math.floor(Date.now() / 1000),
        isDefault: true,
      },
    ])
  }

  it("toolbar toggles set the per-message PGP intent in the store", () => {
    openComposer()
    render(<Composer />)

    const sign = screen.getByRole("button", { name: "Sign (PGP)" })
    const encrypt = screen.getByRole("button", { name: "Encrypt (PGP)" })
    expect(sign.getAttribute("aria-pressed")).toBe("false")
    expect(encrypt.getAttribute("aria-pressed")).toBe("false")

    fireEvent.click(sign)
    fireEvent.click(encrypt)
    expect(useComposerStore.getState().pgpSign).toBe(true)
    expect(useComposerStore.getState().pgpEncrypt).toBe(true)
    expect(sign.getAttribute("aria-pressed")).toBe("true")

    fireEvent.click(sign)
    expect(useComposerStore.getState().pgpSign).toBe(false)
  })

  it("a fresh compose starts with both toggles off", () => {
    useComposerStore.getState().togglePgpSign()
    openComposer()
    expect(useComposerStore.getState().pgpSign).toBe(false)
    expect(useComposerStore.getState().pgpEncrypt).toBe(false)
  })

  it("encrypt without a key for a recipient blocks, naming them, and offers to disable encryption", async () => {
    renderSendable()
    sendComposerDraftMock.mockResolvedValue(queuedResult())
    fireEvent.click(screen.getByRole("button", { name: "Encrypt (PGP)" }))

    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByText(
        /No PGP public key is known for: ada@example\.com/
      )
    ).toBeTruthy()
    expect(sendComposerDraftMock).not.toHaveBeenCalled()

    // "Keep editing" aborts the attempt, keeping draft and toggle.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep editing" })
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(useComposerStore.getState().open).toBe(true)
    expect(useComposerStore.getState().pgpEncrypt).toBe(true)

    // The spec's offer: disabling encryption for this draft lets it send.
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Disable encryption and send",
      })
    )
    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    expect(sendComposerDraftMock).toHaveBeenCalledTimes(1)
    expect(sendComposerDraftMock.mock.calls[0][0].pgp).toBeUndefined()
    expect(useComposerStore.getState().pgpEncrypt).toBe(false)
  })

  it("encrypt with a known key for every recipient sends without prompting", async () => {
    await seedRecipientKey()
    renderSendable()
    sendComposerDraftMock.mockResolvedValue(queuedResult())
    fireEvent.click(screen.getByRole("button", { name: "Encrypt (PGP)" }))

    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(sendComposerDraftMock).toHaveBeenCalledTimes(1)
    expect(sendComposerDraftMock.mock.calls[0][0].pgp).toEqual({
      mode: "encrypt",
    })
  })

  it("sign asks for the passphrase at send time and rides it to the send", async () => {
    await seedDefaultPrivateKey()
    renderSendable()
    sendComposerDraftMock.mockResolvedValue(queuedResult())
    fireEvent.click(screen.getByRole("button", { name: "Sign (PGP)" }))

    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("PGP passphrase")).toBeTruthy()

    typeInto(within(dialog).getByLabelText("PGP passphrase"), "secret-pass")
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Sign and send" })
    )
    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    expect(sendComposerDraftMock).toHaveBeenCalledTimes(1)
    expect(sendComposerDraftMock.mock.calls[0][0].pgp).toEqual({
      mode: "sign",
      passphrase: "secret-pass",
    })
  })

  it("cancelling the passphrase prompt aborts the attempt without sending", async () => {
    await seedDefaultPrivateKey()
    renderSendable()
    fireEvent.click(screen.getByRole("button", { name: "Sign (PGP)" }))

    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Cancel",
      })
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(sendComposerDraftMock).not.toHaveBeenCalled()
    expect(useComposerStore.getState().open).toBe(true)
    // The draft keeps the sign intent for the next attempt.
    expect(useComposerStore.getState().pgpSign).toBe(true)
  })

  it("sign without a private key surfaces an inline error and does not send", async () => {
    renderSendable()
    fireEvent.click(screen.getByRole("button", { name: "Sign (PGP)" }))

    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Add a PGP private key")
    expect(sendComposerDraftMock).not.toHaveBeenCalled()
  })

  it("scheduling is refused while a PGP mode is active", async () => {
    renderSendable()
    fireEvent.click(screen.getByRole("button", { name: "Encrypt (PGP)" }))

    fireEvent.click(screen.getByRole("button", { name: "Schedule send" }))
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: getScheduleSendPresets().presets[0]!.label,
      })
    )

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Scheduled sends don't support PGP")
    expect(useComposerStore.getState().open).toBe(true)
    expect(sendComposerDraftMock).not.toHaveBeenCalled()
  })
})
