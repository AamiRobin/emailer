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
import { toast } from "sonner"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Composer text transform (task 4.6, ai-assistance spec "Compose text
 * transform"). Same harness as composer.test.tsx (real TipTap under
 * jsdom, executor injected), with the AI seams mocked at their module
 * boundaries: settings (the configured/surface flags → the gating) and
 * the transform service (the provider call). Asserted here: the
 * affordance HIDES when AI is unconfigured or the surface is disabled,
 * the pending-replacement bar's Transforming→Accept/Discard states, the
 * draft staying byte-identical until Accept, replacement scoped to the
 * selection (or whole body), inline error + Retry, and undo (toast
 * action AND the editor's native history).
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

vi.mock("@/services/ai/settings", () => ({
  isAiConfigured: vi.fn(),
  isSurfaceEnabled: vi.fn(),
}))

vi.mock("@/services/ai/compose-transform", () => ({
  transformDraftText: vi.fn(),
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

import { createAccount } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  isAiConfigured,
  isSurfaceEnabled,
} from "@/services/ai/settings"
import { transformDraftText } from "@/services/ai/compose-transform"
import { useComposerStore } from "@/stores/composer-store"
import { Composer } from "../composer"

const isAiConfiguredMock = vi.mocked(isAiConfigured)
const isSurfaceEnabledMock = vi.mocked(isSurfaceEnabled)
const transformDraftTextMock = vi.mocked(transformDraftText)
const toastMock = vi.mocked(toast)

let executor: TestExecutor
let accountId: string

function openComposer(): void {
  useComposerStore.getState().openNew(accountId)
}

function getMountedEditor(): Editor {
  const element = document.querySelector(".tiptap") as
    (HTMLElement & { editor?: Editor }) | null
  if (!element?.editor) throw new Error("TipTap editor did not mount")
  return element.editor
}

/** Open the composer with AI configured + the surface enabled, and wait
 * until the AI menu affordance has appeared (the flags round-trip). */
async function renderWithTransformAvailable(): Promise<Editor> {
  isAiConfiguredMock.mockResolvedValue(true)
  isSurfaceEnabledMock.mockResolvedValue(true)
  openComposer()
  render(<Composer />)
  await screen.findByRole("button", { name: "AI transform" })
  return getMountedEditor()
}

/** A pending transformDraftText call the test resolves/rejects manually. */
function deferTransform(): {
  promise: Promise<string>
  resolve: (value: string) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: string) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The Undo action of the accept toast (spec: the action SHALL be
 * undoable — the explicit affordance beside the editor's native undo). */
function toastUndoAction(): (() => void) | undefined {
  const call = toastMock.success.mock.calls.find(
    ([, options]) =>
      typeof options === "object" &&
      options !== null &&
      "action" in (options as Record<string, unknown>)
  )
  const options = call?.[1] as
    | { action?: { onClick: () => void } }
    | undefined
  return options?.action?.onClick
}

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  accountId = await createAccount(executor)
  isAiConfiguredMock.mockReset()
  isSurfaceEnabledMock.mockReset()
  transformDraftTextMock.mockReset()
  transformDraftTextMock.mockResolvedValue("transformed")
})

afterEach(async () => {
  cleanup()
  useComposerStore.getState().cancelUndoSend()
  useComposerStore.getState().reset()
  await act(async () => {})
  executorHolder.current = null
  executor.close()
  vi.clearAllMocks()
})

describe("Composer text transform (task 4.6)", () => {
  it("hides the AI affordance when AI is unconfigured", async () => {
    isAiConfiguredMock.mockResolvedValue(false)
    isSurfaceEnabledMock.mockResolvedValue(false)
    openComposer()
    render(<Composer />)

    // Let the best-effort flags load settle before asserting.
    await act(async () => {})
    expect(screen.queryByRole("button", { name: "AI transform" })).toBeNull()
  })

  it("hides the AI affordance when the composeTransform surface is disabled", async () => {
    isAiConfiguredMock.mockResolvedValue(true)
    isSurfaceEnabledMock.mockResolvedValue(false)
    openComposer()
    render(<Composer />)

    await act(async () => {})
    expect(screen.queryByRole("button", { name: "AI transform" })).toBeNull()
  })

  it("shows the AI menu with the three modes when configured and enabled", async () => {
    await renderWithTransformAvailable()

    fireEvent.click(screen.getByRole("button", { name: "AI transform" }))
    expect(
      await screen.findByTestId("compose-transform-menu")
    ).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: "Improve writing" }))
    expect(screen.getByRole("menuitem", { name: "Shorten" }))
    expect(screen.getByRole("menuitem", { name: "Formalize" }))
  })

  it("Shorten on a selection offers a pending replacement and leaves the draft untouched until Accept", async () => {
    const editor = await renderWithTransformAvailable()
    editor.commands.setContent("<p>First para words</p><p>Second para</p>")
    editor.commands.setTextSelection({ from: 1, to: 17 })

    const deferred = deferTransform()
    transformDraftTextMock.mockReturnValueOnce(deferred.promise)

    fireEvent.click(screen.getByRole("button", { name: "AI transform" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Shorten" }))

    // The request carries exactly the selected text (consent boundary).
    await waitFor(() => {
      expect(transformDraftTextMock).toHaveBeenCalledWith({
        text: "First para words",
        mode: "shorten",
      })
    })

    // Busy state, no Accept yet, one-at-a-time (trigger disabled)…
    const bar = screen.getByTestId("compose-transform-bar")
    expect(bar.textContent).toContain("transforming")
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull()
    expect(
      (screen.getByRole("button", { name: "AI transform" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)

    // …and the draft is byte-identical while the request runs.
    expect(useComposerStore.getState().html).toBe(
      "<p>First para words</p><p>Second para</p>"
    )

    await act(async () => {
      deferred.resolve("Condensed words")
    })
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }))

    // The replacement lands ONLY in the captured range; the rest survives.
    expect(useComposerStore.getState().html).toBe(
      "<p>Condensed words</p><p>Second para</p>"
    )
    expect(screen.queryByTestId("compose-transform-bar")).toBeNull()
  })

  it("with no selection the whole body is the target; the offer can be discarded harmlessly", async () => {
    const editor = await renderWithTransformAvailable()
    editor.commands.setContent("<p>Long winded body</p>")

    const deferred = deferTransform()
    transformDraftTextMock.mockReturnValueOnce(deferred.promise)

    fireEvent.click(screen.getByRole("button", { name: "AI transform" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Improve writing" }))

    await waitFor(() => {
      expect(transformDraftTextMock).toHaveBeenCalledWith({
        text: "Long winded body",
        mode: "improve",
      })
    })

    await act(async () => {
      deferred.resolve("Ignored replacement")
    })
    await screen.findByRole("button", { name: "Accept" })
    // Scope to the bar: the composer footer has its own "Discard".
    const bar = screen.getByTestId("compose-transform-bar")
    fireEvent.click(within(bar).getByRole("button", { name: "Discard" }))

    // Discard drops the offer; the original body was never touched.
    expect(useComposerStore.getState().html).toBe("<p>Long winded body</p>")
    expect(screen.queryByTestId("compose-transform-bar")).toBeNull()
  })

  it("a multi-paragraph result inserts as paragraphs", async () => {
    const editor = await renderWithTransformAvailable()
    editor.commands.setContent("<p>Whole thing</p>")
    transformDraftTextMock.mockResolvedValueOnce("Para one.\n\nPara two.")

    fireEvent.click(screen.getByRole("button", { name: "AI transform" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Formalize" }))
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }))

    expect(useComposerStore.getState().html).toBe(
      "<p>Para one.</p><p>Para two.</p>"
    )
  })

  it("a provider failure shows inline with Retry re-running the same request", async () => {
    const editor = await renderWithTransformAvailable()
    editor.commands.setContent("<p>Some draft text</p>")

    const deferred = deferTransform()
    transformDraftTextMock.mockReturnValueOnce(deferred.promise)

    fireEvent.click(screen.getByRole("button", { name: "AI transform" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Shorten" }))
    await waitFor(() => {
      expect(transformDraftTextMock).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      deferred.reject(new Error("provider unreachable"))
    })
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.getByRole("alert").textContent).toContain(
      "provider unreachable"
    )

    // Retry re-runs the SAME request (text frozen at capture time)…
    transformDraftTextMock.mockResolvedValueOnce("Shortened text")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(transformDraftTextMock).toHaveBeenLastCalledWith({
      text: "Some draft text",
      mode: "shorten",
    })

    // …and a successful retry resolves into an acceptable offer.
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }))
    expect(useComposerStore.getState().html).toBe("<p>Shortened text</p>")
  })

  it("accepting is undoable — the toast's Undo action restores the original", async () => {
    const editor = await renderWithTransformAvailable()
    editor.commands.setContent("<p>Original words</p>")
    transformDraftTextMock.mockResolvedValueOnce("Replaced words")

    fireEvent.click(screen.getByRole("button", { name: "AI transform" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Shorten" }))
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }))
    expect(useComposerStore.getState().html).toBe("<p>Replaced words</p>")

    // The explicit affordance: the accept toast's Undo restores the
    // captured original over the transformed extent.
    const undo = toastUndoAction()
    expect(undo).toBeTruthy()
    await act(async () => {
      undo!()
    })
    expect(useComposerStore.getState().html).toBe("<p>Original words</p>")
  })

  it("the editor's native undo also covers an accepted replacement", async () => {
    const editor = await renderWithTransformAvailable()
    editor.commands.setContent("<p>Original words</p>")
    // prosemirror-history merges steps within its 500ms new-group window
    // into ONE undo unit — separate the seed content from the replacement
    // so a single undo step reverts exactly the accepted transform.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    transformDraftTextMock.mockResolvedValueOnce("Replaced words")

    fireEvent.click(screen.getByRole("button", { name: "AI transform" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Shorten" }))
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }))
    expect(useComposerStore.getState().html).toBe("<p>Replaced words</p>")

    // insertContentAt dispatches a regular transaction, so Cmd/Ctrl+Z —
    // the editor's own history — undoes the acceptance too.
    editor.commands.undo()
    expect(useComposerStore.getState().html).toBe("<p>Original words</p>")
  })
})
