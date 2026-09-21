import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState } from "react"
import { readFile } from "@tauri-apps/plugin-fs"
import { open } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Composer batch C2: size modes + minimize-to-tray (+ the Tauri-only
 * pop-out button), inline body images (paste / drop / toolbar picker with
 * the 2 MB cap reroute) and the Send & Archive split button. Same harness
 * as composer.test.tsx: real TipTap under jsdom, the executor module
 * mocked to a seeded node:sqlite database, the send service mocked at its
 * module boundary.
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

import { createAccount } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { setSetting } from "@/services/db/settings"
import { sendDelaySettingKey } from "@/services/settings/preferences"
import {
  sendComposerDraft,
  type SendComposerDraftResult,
} from "@/services/composer/send"
import { useComposerStore } from "@/stores/composer-store"
import { useUiStore } from "@/stores/ui-store"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { getAttachmentBytes } from "../attachment-bytes"
import { MAX_INLINE_IMAGE_BYTES } from "../inline-image"
import { Composer } from "../composer"
import { ComposerTrayChip } from "../composer-tray-chip"

let executor: TestExecutor
let accountId: string

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

function openComposer(): void {
  useComposerStore.getState().openNew(accountId)
  useUiStore.getState().setComposerOpen(true)
}

function openReplyComposer(sourceThreadId: string): void {
  useComposerStore.getState().openWith(
    {
      kind: "reply",
      replyAll: false,
      inReplyTo: "<orig@example.com>",
      sourceThreadId,
    },
    accountId
  )
  useUiStore.getState().setComposerOpen(true)
}

function typeInto(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } })
}

function pressKey(input: HTMLElement, key: string): void {
  fireEvent.keyDown(input, { key })
}

function makeSendableDraft(): void {
  const toInput = screen.getByLabelText("To")
  typeInto(toInput, "ada@example.com")
  pressKey(toInput, "Enter")
  typeInto(screen.getByLabelText("Subject"), "Quarterly report")
}

/** Harness mounting the global shortcut hook exactly like App does. */
function ComposerWithShortcuts(): React.ReactNode {
  const [helpOpen, setHelpOpen] = useState(false)
  useKeyboardShortcuts({ helpOpen, setHelpOpen })
  return (
    <>
      <Composer />
      <ComposerTrayChip />
    </>
  )
}

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  accountId = await createAccount(executor)
  await setSetting(executor, sendDelaySettingKey(accountId), 0)
})

afterEach(async () => {
  cleanup()
  useComposerStore.getState().cancelUndoSend()
  useComposerStore.getState().reset()
  useUiStore.setState({ composerOpen: false, composerMode: "centered" })
  vi.useRealTimers()
  await act(async () => {})
  executorHolder.current = null
  executor.close()
  vi.clearAllMocks()
})

// ---- Feature 1: size modes + minimize ---------------------------------

describe("Composer size modes + minimize (batch C2)", () => {
  it("the size toggle flips ui-store.composerMode between centered and full", () => {
    openComposer()
    render(<Composer />)
    // Centered is the default (persisted via the preferences service).
    expect(useUiStore.getState().composerMode).toBe("centered")

    fireEvent.click(screen.getByRole("button", { name: "Expand composer" }))
    expect(useUiStore.getState().composerMode).toBe("full")

    fireEvent.click(screen.getByRole("button", { name: "Collapse composer" }))
    expect(useUiStore.getState().composerMode).toBe("centered")
  })

  it("minimize keeps the composer open and the tray chip restores and closes it", async () => {
    openComposer()
    render(<ComposerWithShortcuts />)
    typeInto(screen.getByLabelText("Subject"), "tray draft")

    fireEvent.click(screen.getByRole("button", { name: "Minimize composer" }))
    await waitFor(() => {
      expect(useComposerStore.getState().minimized).toBe(true)
    })
    // Still open: autosave and the shortcut gates keep treating the
    // composer as open.
    expect(useComposerStore.getState().open).toBe(true)

    // The chip shows the draft's subject; restoring keeps every field.
    const restore = await screen.findByTestId("composer-tray-restore")
    expect(restore.textContent).toContain("Draft · tray draft")
    fireEvent.click(restore)
    await waitFor(() => {
      expect(useComposerStore.getState().minimized).toBe(false)
    })
    expect(useComposerStore.getState().open).toBe(true)
    expect(useComposerStore.getState().subject).toBe("tray draft")

    // The chip's × fully closes through the keep-draft save (scoped to
    // the chip — the hidden composer's own X button shares the label).
    fireEvent.click(screen.getByRole("button", { name: "Minimize composer" }))
    const chip = screen.getByTestId("composer-tray-chip")
    fireEvent.click(
      within(chip).getByRole("button", { name: "Close and save draft" })
    )
    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    expect(useComposerStore.getState().minimized).toBe(false)
  })

  it("Esc minimizes and `c` restores — the composer is never stacked", async () => {
    openComposer()
    render(<ComposerWithShortcuts />)
    makeSendableDraft()

    const pressKeyOn = (target: Element, key: string) =>
      fireEvent.keyDown(target, { key, bubbles: true, cancelable: true })

    pressKeyOn(screen.getByLabelText("Subject"), "Escape")
    await waitFor(() => {
      expect(useComposerStore.getState().minimized).toBe(true)
    })
    expect(useUiStore.getState().composerOpen).toBe(true)

    pressKeyOn(document.body, "c")
    await waitFor(() => {
      expect(useComposerStore.getState().minimized).toBe(false)
    })
    // Restored the SAME draft (a new compose would have reset the mode
    // and the fields).
    expect(useComposerStore.getState().subject).toBe("Quarterly report")
    expect(useComposerStore.getState().mode.kind).toBe("new")
  })

  it("an in-flight undo window survives a minimized composer; cancel restores visible", () => {
    openComposer()
    useComposerStore.getState().beginUndoWindow({
      delaySeconds: 10,
      sendArgs: { accountId, payload: {
        to: [], cc: [], bcc: [], subject: "", htmlBody: "", textBody: "",
      } },
      snapshot: {
        accountId,
        mode: { kind: "new" },
        draftKey: null,
        to: [],
        cc: [],
        bcc: [],
        showCc: false,
        showBcc: false,
        subject: "",
        html: "",
        attachments: [],
        fromAlias: null,
      },
    })
    // The undo window closed the composer (pre-send design); the state
    // stays consistent with minimize either way.
    useComposerStore.getState().minimize()
    expect(useComposerStore.getState().undoWindow).not.toBeNull()
    // A cancel from the banner restores the draft VISIBLE (un-minimized)
    // — the window survived the minimize/closed interlude untouched.
    expect(useComposerStore.getState().cancelUndoSend()).toBe(true)
    expect(useComposerStore.getState().minimized).toBe(false)
    expect(useComposerStore.getState().open).toBe(true)
  })
})

// ---- Feature 1: pop-out button -----------------------------------------

describe("Composer pop-out (batch C2)", () => {
  it("hidden without the Tauri runtime, shown when present", async () => {
    openComposer()
    render(<Composer />)
    expect(
      screen.queryByRole("button", { name: "Pop out composer" })
    ).toBeNull()

    const popout = await import("@/services/desktop/popout")
    const spy = vi
      .spyOn(popout, "isTauriRuntime")
      .mockReturnValue(true)
    // Re-render picks up the new module state (the check runs per render).
    cleanup()
    openComposer()
    render(<Composer />)
    expect(
      screen.getByRole("button", { name: "Pop out composer" })
    ).toBeTruthy()
    spy.mockRestore()
  })

  it("popping out persists the snapshot, hands the key to the window and closes the overlay", async () => {
    const popout = await import("@/services/desktop/popout")
    const runtimeSpy = vi.spyOn(popout, "isTauriRuntime").mockReturnValue(true)
    const openSpy = vi
      .spyOn(popout, "openComposerPopout")
      .mockResolvedValue(undefined)

    openComposer()
    render(<Composer />)
    typeInto(screen.getByLabelText("Subject"), "pop out draft")
    const draftKey = useComposerStore.getState().draftKey

    fireEvent.click(screen.getByRole("button", { name: "Pop out composer" }))

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(draftKey)
    })
    // The overlay closed; the draft key survives as the handoff.
    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    expect(useComposerStore.getState().draftKey).toBe(draftKey)
    runtimeSpy.mockRestore()
    openSpy.mockRestore()
  })
})

// ---- Feature 2: inline images ------------------------------------------

const TINY_PNG = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "pic.png", {
  type: "image/png",
})

function dropOnSection(files: File[]): void {
  const section = document.querySelector("section")
  if (!section) throw new Error("composer section did not mount")
  fireEvent.drop(section, { dataTransfer: { files } })
}

/** The body HTML once the (async) insertion pipeline settled. */
async function editorHtml(): Promise<string> {
  await waitFor(() => {
    expect(useComposerStore.getState().html).not.toBe("")
  })
  return useComposerStore.getState().html
}

/** Let the async attach/insert pipelines settle without waiting on any
 * particular outcome (negative-path assertions). */
async function flushAsync(): Promise<void> {
  await act(async () => {})
}

describe("Composer inline images (batch C2)", () => {
  it("a dropped image file is inserted inline as a data URL", async () => {
    openComposer()
    render(<Composer />)
    dropOnSection([TINY_PNG])
    const html = await editorHtml()
    expect(html).toMatch(/<img src="data:image\/png;base64,/)
  })

  it("an image over the 2 MB cap is NOT inlined — it routes to attachments with a toast", async () => {
    openComposer()
    render(<Composer />)
    const big = new File([new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1)], "big.png", {
      type: "image/png",
    })
    dropOnSection([big])
    await flushAsync()
    expect(useComposerStore.getState().html).not.toContain("<img")
    expect(toastMock.info).toHaveBeenCalledWith(
      expect.stringContaining("big.png")
    )
    await waitFor(() => {
      expect(useComposerStore.getState().attachments.map((a) => a.name)).toEqual(
        ["big.png"]
      )
    })
    expect(getAttachmentBytes(useComposerStore.getState().attachments[0].id)).toBeDefined()
  })

  it("a pasted image file is inserted inline at the cursor", async () => {
    openComposer()
    render(<Composer />)
    const editorEl = document.querySelector(".tiptap") as HTMLElement
    fireEvent.paste(editorEl, {
      clipboardData: { files: [TINY_PNG], getData: () => "" },
    })
    const html = await editorHtml()
    expect(html).toMatch(/<img src="data:image\/png;base64,/)
  })

  it("non-image files keep routing to attachments", async () => {
    openComposer()
    render(<Composer />)
    dropOnSection([
      new File([new Uint8Array([1, 2, 3])], "report.pdf", {
        type: "application/pdf",
      }),
    ])
    await flushAsync()
    expect(useComposerStore.getState().html).not.toContain("<img")
    await waitFor(() => {
      expect(screen.getByText("report.pdf")).toBeTruthy()
    })
  })

  it("the toolbar image button picks files and inserts them inline", async () => {
    openMock.mockResolvedValue(["/home/u/pictures/pic.png"])
    readFileMock.mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    openComposer()
    render(<Composer />)

    fireEvent.click(screen.getByRole("button", { name: "Insert image" }))

    const html = await editorHtml()
    expect(html).toMatch(/<img src="data:image\/png;base64,/)
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: true })
    )
  })
})

// ---- Feature 3: Send & Archive -----------------------------------------

describe("Composer Send & Archive (batch C2)", () => {
  it("the chevron menu only exists for a reply/forward bound to a thread", () => {
    openComposer()
    render(<Composer />)
    makeSendableDraft()
    expect(screen.queryByTestId("send-options")).toBeNull()

    cleanup()
    useComposerStore.getState().reset()
    openReplyComposer("thread-1")
    render(<Composer />)
    makeSendableDraft()
    expect(screen.getByTestId("send-options")).toBeTruthy()
  })

  it("Send & Archive passes the source thread to the send flow", async () => {
    sendComposerDraftMock.mockResolvedValue(queuedResult())
    openReplyComposer("thread-42")
    render(<Composer />)
    makeSendableDraft()

    fireEvent.click(screen.getByTestId("send-options"))
    fireEvent.click(await screen.findByTestId("send-and-archive"))

    await waitFor(() => {
      expect(sendComposerDraftMock).toHaveBeenCalledTimes(1)
    })
    expect(sendComposerDraftMock.mock.calls[0][0].archiveSourceThreadId).toBe(
      "thread-42"
    )
    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
  })

  it("plain Send does not carry the archive flag", async () => {
    sendComposerDraftMock.mockResolvedValue(queuedResult())
    openReplyComposer("thread-42")
    render(<Composer />)
    makeSendableDraft()

    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() => {
      expect(sendComposerDraftMock).toHaveBeenCalledTimes(1)
    })
    expect(
      sendComposerDraftMock.mock.calls[0][0].archiveSourceThreadId
    ).toBeUndefined()
  })
})
