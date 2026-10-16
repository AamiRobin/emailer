import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Editor } from "@tiptap/react"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Composer dictation (parity-round-3 task 7.2, spec ai-assistance "Voice
 * dictation in the composer"). Same harness as compose-transform.test.tsx
 * (real TipTap under jsdom, executor injected) with the voice seams
 * mocked at their module boundaries: the dictation session (mic/record/
 * transcribe), the whisper model catalog (present / first-use download),
 * and the language setting. Asserted here: the happy path STOPS
 * recording and inserts the transcript AT THE CURSOR through the editor's
 * own command pipeline (text typed around the caret stays in order), the
 * cancel path discards (cancel() on the session, composer text
 * unchanged, nothing inserted), the first-use download consent states
 * the model size BEFORE downloading and starts recording only after, and
 * the control hides entirely where the platform cannot dictate.
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

const dictationMock = vi.hoisted(() => {
  return {
    supported: true,
    beginDictation: vi.fn(),
  }
})

/** Stable idle download snapshot for the store mock (see below). */
const idleDownloadSnapshot = {
  state: "idle",
  received: 0,
  total: null,
  error: null,
}

vi.mock("@/services/voice/dictation", () => {
  class DictationCancelledError extends Error {
    constructor() {
      super("Dictation cancelled")
      this.name = "DictationCancelledError"
    }
  }
  return {
    DictationCancelledError,
    dictationSupported: () => dictationMock.supported,
    beginDictation: dictationMock.beginDictation,
  }
})

vi.mock("@/services/voice/model", () => ({
  WHISPER_TOTAL_BYTES: 147951465,
  whisperModelPresent: vi.fn(),
  downloadWhisperModel: vi.fn(),
  getWhisperModelDir: vi.fn(async () => "/mock/appdata/models/ggml-base"),
  // useSyncExternalStore demands a STABLE snapshot object (a fresh
  // literal per call would re-render forever).
  getWhisperDownloadSnapshot: vi.fn(() => idleDownloadSnapshot),
  subscribeWhisperDownload: vi.fn(() => () => {}),
}))

vi.mock("@/services/voice/settings", () => ({
  getDictationLanguage: vi.fn(async () => "en"),
  DICTATION_LANGUAGES: [{ code: "", label: "Auto-detect" }],
}))

vi.mock("@/services/ai/settings", () => ({
  isAiConfigured: vi.fn(async () => false),
  isSurfaceEnabled: vi.fn(async () => false),
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
  downloadWhisperModel,
  whisperModelPresent,
} from "@/services/voice/model"
// The MOCKED module's class — the component's silent-discard branch
// checks instanceof against exactly this.
import { DictationCancelledError } from "@/services/voice/dictation"
import { useComposerStore } from "@/stores/composer-store"
import { Composer } from "../composer"

const whisperModelPresentMock = vi.mocked(whisperModelPresent)
const downloadWhisperModelMock = vi.mocked(downloadWhisperModel)

let executor: TestExecutor
let accountId: string

function getMountedEditor(): Editor {
  const element = document.querySelector(".tiptap") as
    | (HTMLElement & { editor?: Editor })
    | null
  if (!element?.editor) throw new Error("TipTap editor did not mount")
  return element.editor
}

/** A fake ActiveDictation whose stop() resolves `text` (or rejects). */
function fakeSession(result: { text?: string; reject?: Error }) {
  return {
    stop: vi.fn(async () => {
      if (result.reject) throw result.reject
      return result.text ?? ""
    }),
    cancel: vi.fn(async () => {}),
  }
}

/** Open the composer, render it, and return the mounted editor. */
async function openComposer(): Promise<Editor> {
  useComposerStore.getState().openNew(accountId)
  render(<Composer />)
  await screen.findByLabelText("Message body")
  return getMountedEditor()
}

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  accountId = await createAccount(executor)
  dictationMock.supported = true
  dictationMock.beginDictation.mockReset()
  whisperModelPresentMock.mockResolvedValue(true)
  downloadWhisperModelMock.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  executor.close()
})

describe("dictation happy path", () => {
  it("inserts the transcript at the cursor through the editor pipeline", async () => {
    const editor = await openComposer()
    // Typed text around the caret proves the insertion is at-cursor, not
    // a whole-body replacement. The transcript carries its own trailing
    // space (spoken punctuation does), so the insertion reads naturally.
    editor.commands.setContent("<p>Hello world</p>")
    editor.commands.setTextSelection(7) // after "Hello ", before "world"
    const session = fakeSession({ text: "beautiful " })
    dictationMock.beginDictation.mockResolvedValue(session)

    // Stop → transcribe → insert.
    fireEvent.click(screen.getByTestId("dictation-button"))
    await screen.findByTestId("dictation-recording-dot")
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }))
    await waitFor(() => {
      expect(getMountedEditor().getText()).toBe("Hello beautiful world")
    })
    // The language setting was consulted at transcribe time and the
    // session was the ONE beginDictation product.
    expect(session.stop).toHaveBeenCalledWith("en")
    expect(dictationMock.beginDictation).toHaveBeenCalledTimes(1)
  })

  it("returns to the idle mic after the insertion", async () => {
    await openComposer()
    const session = fakeSession({ text: "note to self" })
    dictationMock.beginDictation.mockResolvedValue(session)

    fireEvent.click(screen.getByTestId("dictation-button"))
    await screen.findByTestId("dictation-recording-dot")
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }))
    await waitFor(() => {
      expect(getMountedEditor().getText()).toContain("note to self")
    })
    await waitFor(() => {
      expect(
        screen.getByTestId("dictation-button").getAttribute("aria-pressed")
      ).toBe("false")
    })
    // The cancel affordance disappears with the recording state.
    expect(screen.queryByTestId("dictation-cancel")).toBeNull()
  })
})

describe("dictation cancel path", () => {
  it("discards the recording: composer text unchanged, nothing inserted", async () => {
    const editor = await openComposer()
    editor.commands.setContent("<p>Draft body</p>")
    const session = fakeSession({ text: "SHOULD NOT APPEAR" })
    dictationMock.beginDictation.mockResolvedValue(session)

    fireEvent.click(screen.getByTestId("dictation-button"))
    await screen.findByTestId("dictation-recording-dot")

    // Cancel mid-dictation (spec "Cancel mid-dictation").
    fireEvent.click(screen.getByTestId("dictation-cancel"))
    await waitFor(() => {
      expect(session.cancel).toHaveBeenCalledTimes(1)
    })
    // The composer text is unchanged and the session's stop (which would
    // transcribe) never ran.
    expect(getMountedEditor().getText()).toBe("Draft body")
    expect(session.stop).not.toHaveBeenCalled()
    // The affordances reset to idle.
    await waitFor(() => {
      expect(
        screen.getByTestId("dictation-button").getAttribute("aria-pressed")
      ).toBe("false")
    })
    expect(screen.queryByTestId("dictation-cancel")).toBeNull()
  })

  it("cancel while transcribing still inserts nothing", async () => {
    const editor = await openComposer()
    editor.commands.setContent("<p>Draft body</p>")
    // stop() pending while the user cancels: the REAL session contract
    // rejects the pending stop with DictationCancelledError (the
    // service's cancelled flag), so the component's silent-discard path
    // is what runs — nothing may land in the draft.
    let rejectStop!: (error: Error) => void
    const session = {
      stop: vi.fn(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectStop = reject
          })
      ),
      cancel: vi.fn(async () => {}),
    }
    dictationMock.beginDictation.mockResolvedValue(session)

    fireEvent.click(screen.getByTestId("dictation-button"))
    await screen.findByTestId("dictation-recording-dot")
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }))
    // Transcribing state: the mic is disabled, cancel stays available.
    await vi.waitFor(() => expect(session.stop).toHaveBeenCalled())
    expect(
      (screen.getByTestId("dictation-button") as HTMLButtonElement).disabled
    ).toBe(true)
    fireEvent.click(screen.getByTestId("dictation-cancel"))
    await waitFor(() => {
      expect(session.cancel).toHaveBeenCalledTimes(1)
    })
    // The session honors the cancel the way the real one does.
    rejectStop(new DictationCancelledError())
    await waitFor(() => {
      expect(
        screen.getByTestId("dictation-button").getAttribute("aria-pressed")
      ).toBe("false")
    })
    expect(getMountedEditor().getText()).toBe("Draft body")
  })
})

describe("first-use download", () => {
  it("states the model size before downloading, then records after completion", async () => {
    await openComposer()
    whisperModelPresentMock.mockResolvedValue(false)
    const session = fakeSession({ text: "after download" })
    dictationMock.beginDictation.mockResolvedValue(session)

    // First press: no model → the consent popover, no download yet.
    fireEvent.click(screen.getByTestId("dictation-button"))
    const consent = await screen.findByTestId("dictation-consent")
    expect(consent.textContent).toContain("148 MB")
    expect(downloadWhisperModelMock).not.toHaveBeenCalled()
    expect(dictationMock.beginDictation).not.toHaveBeenCalled()

    // Explicit consent → download (spec: visible size before) → only
    // after completion does the recording start.
    fireEvent.click(screen.getByTestId("dictation-download-start"))
    await waitFor(() => {
      expect(downloadWhisperModelMock).toHaveBeenCalledTimes(1)
    })
    await screen.findByTestId("dictation-recording-dot")
    expect(dictationMock.beginDictation).toHaveBeenCalledTimes(1)
  })

  it("declining the consent downloads nothing", async () => {
    await openComposer()
    whisperModelPresentMock.mockResolvedValue(false)

    fireEvent.click(screen.getByTestId("dictation-button"))
    await screen.findByTestId("dictation-consent")
    fireEvent.click(screen.getByTestId("dictation-consent-cancel"))

    await waitFor(() => {
      expect(screen.queryByTestId("dictation-consent")).toBeNull()
    })
    expect(downloadWhisperModelMock).not.toHaveBeenCalled()
    expect(dictationMock.beginDictation).not.toHaveBeenCalled()
  })
})

describe("unsupported platforms", () => {
  it("hides the control entirely when dictation is unsupported", async () => {
    dictationMock.supported = false
    await openComposer()
    expect(screen.queryByTestId("dictation-button")).toBeNull()
  })
})
