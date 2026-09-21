import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Editor } from "@tiptap/react"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Composer batch C3: the toolbar rounding-out (Undo/Redo, Strikethrough,
 * inline Code, Blockquote — StarterKit affordances the editor already
 * enabled, now exposed) and the AI generative offers ("Draft from prompt"
 * + "Generate reply") riding the SAME pending-replacement flow as the
 * transforms. Same harness as composer.test.tsx: real TipTap under jsdom,
 * the executor module mocked to a seeded node:sqlite database, the AI
 * generate service mocked at its module boundary — the settings flags run
 * REAL against the seeded db so the gating is exercised end to end.
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

vi.mock("@/services/ai/compose-generate", () => ({
  generateDraftFromPrompt: vi.fn(),
  generateReplyForThread: vi.fn(),
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

import {
  createAccount,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { addProvider, setActiveProvider, setAiEnabled } from "@/services/ai/settings"
import {
  generateDraftFromPrompt,
  generateReplyForThread,
} from "@/services/ai/compose-generate"
import { matchShortcutEvent, SHORTCUTS } from "@/constants/shortcuts"
import { useComposerStore } from "@/stores/composer-store"
import { useUiStore } from "@/stores/ui-store"
import { Composer } from "../composer"

const generateDraftFromPromptMock = vi.mocked(generateDraftFromPrompt)
const generateReplyForThreadMock = vi.mocked(generateReplyForThread)

let executor: TestExecutor
let accountId: string

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

function getMountedEditor(): Editor {
  const element = document.querySelector(".tiptap") as
    | (HTMLElement & { editor?: Editor })
    | null
  if (!element?.editor) throw new Error("TipTap editor did not mount")
  return element.editor
}

/** Seed the real settings rows so isAiConfigured/isSurfaceEnabled pass. */
async function seedAiConfigured(): Promise<void> {
  await setAiEnabled(executor, true)
  const created = await addProvider(executor, {
    kind: "anthropic",
    label: "Work",
    model: "claude-x",
  })
  await setActiveProvider(executor, created.id)
}

async function openWithAiMenuAvailable(): Promise<Editor> {
  await seedAiConfigured()
  openComposer()
  render(<Composer />)
  await screen.findByRole("button", { name: "AI transform" })
  return getMountedEditor()
}

/** A pending generate call the test resolves/rejects manually. */
function deferGenerate(): {
  promise: Promise<{ text: string; cached: boolean }>
  resolve: (value: { text: string; cached: boolean }) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: { text: string; cached: boolean }) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<{ text: string; cached: boolean }>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function toggleByName(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement
}

/** Base UI menu items carry the disabled state as aria-disabled. */
function isMenuItemDisabled(item: HTMLElement): boolean {
  return (
    item.hasAttribute("disabled") ||
    item.getAttribute("aria-disabled") === "true"
  )
}

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  accountId = await createAccount(executor)
  generateDraftFromPromptMock.mockReset()
  generateReplyForThreadMock.mockReset()
})

afterEach(async () => {
  cleanup()
  useComposerStore.getState().cancelUndoSend()
  useComposerStore.getState().reset()
  useUiStore.setState({ composerOpen: false })
  await act(async () => {})
  executorHolder.current = null
  executor.close()
  vi.clearAllMocks()
})

// ---- Feature 1: toolbar rounding-out ------------------------------------

describe("Composer toolbar rounding-out (batch C3)", () => {
  it("exposes Undo/Redo with availability-gated disabled states", async () => {
    openComposer()
    render(<Composer />)
    const editor = getMountedEditor()

    // Nothing to undo yet.
    expect(toggleByName("Undo (Cmd/Ctrl+Z)").disabled).toBe(true)
    expect(toggleByName("Redo (Cmd/Ctrl+Shift+Z)").disabled).toBe(true)

    editor.commands.setContent("<p>typed</p>")
    await waitFor(() => {
      expect(toggleByName("Undo (Cmd/Ctrl+Z)").disabled).toBe(false)
    })

    fireEvent.click(toggleByName("Undo (Cmd/Ctrl+Z)"))
    expect(useComposerStore.getState().html).not.toContain("typed")
    await waitFor(() => {
      expect(toggleByName("Redo (Cmd/Ctrl+Shift+Z)").disabled).toBe(false)
    })

    fireEvent.click(toggleByName("Redo (Cmd/Ctrl+Shift+Z)"))
    expect(useComposerStore.getState().html).toContain("typed")
  })

  it("Strikethrough, inline Code and Blockquote apply, highlight and revert", async () => {
    openComposer()
    render(<Composer />)
    const editor = getMountedEditor()
    editor.commands.setContent("<p>plain words</p>")
    editor.commands.setTextSelection({ from: 1, to: 12 })

    fireEvent.click(toggleByName("Strikethrough (Cmd/Ctrl+Shift+S)"))
    expect(useComposerStore.getState().html).toContain("<s>")
    expect(toggleByName("Strikethrough (Cmd/Ctrl+Shift+S)").getAttribute("aria-pressed")).toBe(
      "true"
    )

    fireEvent.click(toggleByName("Inline code (Cmd/Ctrl+E)"))
    expect(useComposerStore.getState().html).toContain("<code>")

    // Blockquote wraps the selected paragraph.
    fireEvent.click(toggleByName("Blockquote (Cmd/Ctrl+Shift+B)"))
    expect(useComposerStore.getState().html).toContain("<blockquote>")
    expect(toggleByName("Blockquote (Cmd/Ctrl+Shift+B)").getAttribute("aria-pressed")).toBe(
      "true"
    )

    // Undo (the toolbar button, not the keyboard) reverts everything.
    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(toggleByName("Undo (Cmd/Ctrl+Z)"))
    }
    const html = useComposerStore.getState().html
    expect(html).not.toContain("<s>")
    expect(html).not.toContain("<code>")
    expect(html).not.toContain("<blockquote>")
    expect(html).toContain("plain words")
  })

  it("TipTap's native shortcuts are registered; the global registry leaves them alone", async () => {
    openComposer()
    render(<Composer />)
    const editor = getMountedEditor()
    editor.commands.setContent("<p>selectable</p>")
    editor.commands.setTextSelection({ from: 1, to: 11 })

    // Mod-Shift-s is TipTap v3's native strike binding: dispatch through
    // the view's keydown prop pipeline (the exact path a real keydown
    // takes) and expect the keymap to handle it.
    const handled = editor.view.someProp("handleKeyDown", (handler) =>
      handler(
        editor.view,
        new KeyboardEvent("keydown", {
          key: "s",
          shiftKey: true,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      )
    )
    expect(handled).toBe(true)
    expect(useComposerStore.getState().html).toContain("<s>")

    // The global shortcut table does NOT claim any of the new chords —
    // the composer's send/minimize bindings stay on different keys.
    for (const init of [
      { key: "s", shiftKey: true, ctrlKey: true },
      { key: "b", shiftKey: true, metaKey: true },
      { key: "e", ctrlKey: true },
      { key: "z", metaKey: true },
    ]) {
      const event = new KeyboardEvent("keydown", init)
      expect(matchShortcutEvent(event, SHORTCUTS)).toBeNull()
    }
    // Sanity: the matcher still recognizes a composer binding.
    expect(
      matchShortcutEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey: true }),
        SHORTCUTS
      )
    ).toBe("send-message")
  })
})

// ---- Feature 3: AI compose-from-prompt + generate reply ------------------

describe("Composer AI generative offers (batch C3)", () => {
  it("hides the AI menu when AI is not configured", async () => {
    openComposer()
    render(<Composer />)
    await act(async () => {})
    expect(screen.queryByRole("button", { name: "AI transform" })).toBeNull()
  })

  it("offers Draft from prompt in a new compose and no Generate reply", async () => {
    await openWithAiMenuAvailable()

    fireEvent.click(screen.getByRole("button", { name: "AI transform" }))
    const menu = await screen.findByTestId("compose-transform-menu")
    const draftItem = screen.getByTestId("ai-draft-from-prompt")
    expect(draftItem.hasAttribute("disabled")).toBe(false)
    expect(screen.queryByTestId("ai-generate-reply")).toBeNull()
    expect(menu.textContent).toContain("Draft from prompt…")
  })

  it("disables Draft from prompt and offers Generate reply in a reply", async () => {
    await seedAiConfigured()
    const threadId = await createThread(executor, accountId, {
      subject: "Kickoff",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromAddress: "alice@example.com",
      bodyText: "Can we move the review?",
    })
    openReplyComposer(threadId)
    render(<Composer />)
    await screen.findByRole("button", { name: "AI transform" })

    fireEvent.click(screen.getByRole("button", { name: "AI transform" }))
    await screen.findByTestId("compose-transform-menu")
    expect(
      isMenuItemDisabled(screen.getByTestId("ai-draft-from-prompt"))
    ).toBe(true)
    expect(screen.getByTestId("ai-generate-reply")).toBeTruthy()
  })

  it("draft-from-prompt: dialog → pending bar → Accept writes the body", async () => {
    const editor = await openWithAiMenuAvailable()
    editor.commands.setContent("<p></p>")
    const deferred = deferGenerate()
    generateDraftFromPromptMock.mockReturnValueOnce(deferred.promise)

    fireEvent.click(screen.getByRole("button", { name: "AI transform" }))
    fireEvent.click(await screen.findByTestId("ai-draft-from-prompt"))

    const field = await screen.findByLabelText("Draft instruction")
    fireEvent.change(field, {
      target: { value: "  A two-paragraph note about Friday  " },
    })
    fireEvent.click(screen.getByRole("button", { name: "Generate" }))

    // The dialog hands the TRIMMED instruction to the service, never the
    // provider directly into the draft.
    await waitFor(() => {
      expect(generateDraftFromPromptMock).toHaveBeenCalledWith({
        prompt: "A two-paragraph note about Friday",
        accountId,
        regenerate: false,
      })
    })
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull()
    const bar = screen.getByTestId("compose-transform-bar")
    expect(bar.textContent).toContain("Draft from prompt")
    expect(bar.textContent).toContain("transforming")
    // Nothing has entered the draft while the request runs.
    expect(useComposerStore.getState().html).not.toContain("Line one")

    await act(async () => {
      deferred.resolve({ text: "Line one.\n\nLine two.", cached: false })
    })
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }))
    expect(useComposerStore.getState().html).toBe(
      "<p>Line one.</p><p>Line two.</p>"
    )
    expect(screen.queryByTestId("compose-transform-bar")).toBeNull()
  })

  it("draft-from-prompt: Discard leaves the body untouched", async () => {
    const editor = await openWithAiMenuAvailable()
    editor.commands.setContent("<p>Existing words</p>")
    generateDraftFromPromptMock.mockResolvedValue({
      text: "Ignored draft",
      cached: false,
    })

    fireEvent.click(screen.getByRole("button", { name: "AI transform" }))
    fireEvent.click(await screen.findByTestId("ai-draft-from-prompt"))
    fireEvent.change(await screen.findByLabelText("Draft instruction"), {
      target: { value: "Replace it" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    await screen.findByTestId("compose-transform-bar")

    const bar = screen.getByTestId("compose-transform-bar")
    fireEvent.click(within(bar).getByRole("button", { name: "Discard" }))

    expect(useComposerStore.getState().html).toBe("<p>Existing words</p>")
    expect(screen.queryByTestId("compose-transform-bar")).toBeNull()
  })

  it("Retry of a failed draft re-runs with regenerate: true", async () => {
    const editor = await openWithAiMenuAvailable()
    editor.commands.setContent("<p></p>")
    generateDraftFromPromptMock
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce({ text: "Fresh draft", cached: false })

    fireEvent.click(screen.getByRole("button", { name: "AI transform" }))
    fireEvent.click(await screen.findByTestId("ai-draft-from-prompt"))
    fireEvent.change(await screen.findByLabelText("Draft instruction"), {
      target: { value: "Try me" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Generate" }))

    const bar = await screen.findByTestId("compose-transform-bar")
    expect(bar.textContent).toContain("rate limited")
    fireEvent.click(within(bar).getByRole("button", { name: "Retry" }))

    await waitFor(() => {
      expect(generateDraftFromPromptMock).toHaveBeenLastCalledWith({
        prompt: "Try me",
        accountId,
        regenerate: true,
      })
    })
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }))
    expect(useComposerStore.getState().html).toBe("<p>Fresh draft</p>")
  })

  it("generate-reply: offers the generated draft over the whole body", async () => {
    await seedAiConfigured()
    const threadId = await createThread(executor, accountId, {
      subject: "Kickoff",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromAddress: "alice@example.com",
      bodyText: "Can we move the review?",
    })
    openReplyComposer(threadId)
    render(<Composer />)
    await screen.findByRole("button", { name: "AI transform" })
    const editor = getMountedEditor()
    editor.commands.setContent("<p>Old quoted draft</p>")

    const deferred = deferGenerate()
    generateReplyForThreadMock.mockReturnValueOnce(deferred.promise)

    fireEvent.click(screen.getByRole("button", { name: "AI transform" }))
    fireEvent.click(await screen.findByTestId("ai-generate-reply"))

    await waitFor(() => {
      expect(generateReplyForThreadMock).toHaveBeenCalledWith({
        accountId,
        threadId,
        regenerate: false,
      })
    })
    const bar = await screen.findByTestId("compose-transform-bar")
    expect(bar.textContent).toContain("Generated reply")
    expect(useComposerStore.getState().html).toBe("<p>Old quoted draft</p>")

    await act(async () => {
      deferred.resolve({ text: "Thursday works for me.", cached: true })
    })
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }))
    expect(useComposerStore.getState().html).toBe(
      "<p>Thursday works for me.</p>"
    )
  })
})
