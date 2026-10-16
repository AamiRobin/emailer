import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Settings → AI "Voice" section (parity-round-3 tasks 7.2/7.3). The
 * module seams are mocked (executor, whisper model catalog, dictation
 * settings, the voice-profile service, the AI gate) so the BLOCK's states
 * are what's under test: the dictation model's first-use download copy
 * with the size stated before, progress + cancel, the language picker's
 * persistence, and the writing-voice profile's learn gate (disabled
 * without a provider or enough sent mail, with the reason stated),
 * learn/refresh flows reporting inline, the review display, and delete.
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

const modelMock = vi.hoisted(() => {
  // The module REPLACES the snapshot object per set (never mutates), so
  // useSyncExternalStore sees reference changes; tests drive it through
  // setDownloadState the same way.
  let snapshot = {
    state: "idle",
    received: 0,
    total: null,
    error: null,
  }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    setDownloadState(next: Partial<typeof snapshot>): void {
      snapshot = { ...snapshot, ...next }
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
})

vi.mock("@/services/voice/model", () => ({
  WHISPER_TOTAL_BYTES: 147951465,
  whisperModelPresent: vi.fn(),
  downloadWhisperModel: vi.fn(),
  cancelWhisperModelDownload: vi.fn(),
  getWhisperModelDir: vi.fn(async () => "/mock/appdata/models/ggml-base"),
  getWhisperDownloadSnapshot: () => modelMock.getSnapshot(),
  subscribeWhisperDownload: modelMock.subscribe,
}))

vi.mock("@/services/voice/settings", () => ({
  DICTATION_LANGUAGES: [
    { code: "", label: "Auto-detect" },
    { code: "en", label: "English" },
    { code: "de", label: "German" },
    { code: "tr", label: "Turkish" },
  ],
  getDictationLanguage: vi.fn(),
  setDictationLanguage: vi.fn(),
}))

vi.mock("@/services/ai/settings", () => ({
  isAiConfigured: vi.fn(),
}))

vi.mock("@/services/ai/voice-profile", () => ({
  MIN_SENT_SAMPLES: 3,
  countSentMessages: vi.fn(),
  deleteVoiceProfile: vi.fn(),
  getVoiceProfile: vi.fn(),
  learnWritingVoiceProfile: vi.fn(),
}))

import { isAiConfigured } from "@/services/ai/settings"
import {
  countSentMessages,
  deleteVoiceProfile,
  getVoiceProfile,
  learnWritingVoiceProfile,
} from "@/services/ai/voice-profile"
import {
  downloadWhisperModel,
  whisperModelPresent,
} from "@/services/voice/model"
import {
  getDictationLanguage,
  setDictationLanguage,
} from "@/services/voice/settings"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { VoiceSection } from "../voice-section"

const isAiConfiguredMock = vi.mocked(isAiConfigured)
const countSentMessagesMock = vi.mocked(countSentMessages)
const getVoiceProfileMock = vi.mocked(getVoiceProfile)
const learnWritingVoiceProfileMock = vi.mocked(learnWritingVoiceProfile)
const deleteVoiceProfileMock = vi.mocked(deleteVoiceProfile)
const whisperModelPresentMock = vi.mocked(whisperModelPresent)
const downloadWhisperModelMock = vi.mocked(downloadWhisperModel)
const getDictationLanguageMock = vi.mocked(getDictationLanguage)
const setDictationLanguageMock = vi.mocked(setDictationLanguage)

const SAMPLE_PROFILE = {
  profile: {
    version: 1 as const,
    tone: "warm, direct",
    formality: "business-casual",
    length: "short",
    vocabulary: "plain words",
    quirks: ["dash asides"],
    greetingStyle: "Hi {name},",
    signoffStyle: "Best,",
  },
  learnedAt: Math.floor(Date.now() / 1000) - 60,
  messageCount: 5,
}

function seedState(input: {
  aiReady?: boolean
  sentCount?: number
  profile?: typeof SAMPLE_PROFILE | null
  modelPresent?: boolean
  language?: string
}): void {
  isAiConfiguredMock.mockResolvedValue(input.aiReady ?? true)
  countSentMessagesMock.mockResolvedValue(input.sentCount ?? 10)
  getVoiceProfileMock.mockResolvedValue(
    input.profile === undefined ? SAMPLE_PROFILE : (input.profile ?? null)
  )
  whisperModelPresentMock.mockResolvedValue(input.modelPresent ?? true)
  getDictationLanguageMock.mockResolvedValue(input.language ?? "")
}

async function renderSection(): Promise<void> {
  render(<VoiceSection />)
  await screen.findByTestId("voice-section")
  // The initial Promise.all read resolves on the next microtask tick.
  await waitFor(() => {
    expect(
      screen.queryByText((_, element) => element?.textContent === "Loading…")
    ).toBeNull()
  })
}

beforeEach(() => {
  executorHolder.current = createTestExecutor()
  vi.clearAllMocks()
  modelMock.setDownloadState({
    state: "idle",
    received: 0,
    total: null,
    error: null,
  })
  downloadWhisperModelMock.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  ;(executorHolder.current as TestExecutor | null)?.close()
  executorHolder.current = null
})

describe("dictation block", () => {
  it("shows the downloaded model line when present", async () => {
    seedState({ modelPresent: true })
    await renderSection()
    expect(screen.getByTestId("dictation-model-ready").textContent).toContain(
      "148 MB"
    )
  })

  it("offers the download with the size stated before anything is fetched", async () => {
    seedState({ modelPresent: false })
    await renderSection()
    const start = screen.getByTestId("dictation-download-start")
    expect(start.textContent).toContain("148 MB")
    expect(downloadWhisperModelMock).not.toHaveBeenCalled()

    fireEvent.click(start)
    await waitFor(() => {
      expect(downloadWhisperModelMock).toHaveBeenCalledTimes(1)
    })
    // After the download settles (the hook re-reads), the ready line
    // replaces the offer.
    whisperModelPresentMock.mockResolvedValue(true)
    modelMock.setDownloadState({ state: "completed" })
    await screen.findByTestId("dictation-model-ready")
  })

  it("persists a language pick", async () => {
    seedState({ language: "" })
    await renderSection()
    const trigger = screen.getByTestId("dictation-language")
    expect(trigger.textContent).toContain("Auto-detect")
    // The base-ui select pattern (data-portability-section.test.tsx):
    // open the listbox, then pointerDown + click the option.
    fireEvent.click(trigger)
    const listbox = (await screen.findAllByRole("listbox")).at(-1)
    if (!listbox) throw new Error("select listbox did not open")
    const option = within(listbox).getByRole("option", { name: "Turkish" })
    fireEvent.pointerDown(option)
    fireEvent.click(option)
    await waitFor(() => {
      expect(setDictationLanguageMock).toHaveBeenCalledWith(
        executorHolder.current,
        "tr"
      )
    })
  })
})

describe("writing-voice block", () => {
  it("shows the learned profile with its review display and Refresh/Delete", async () => {
    seedState({ profile: SAMPLE_PROFILE })
    await renderSection()
    expect(screen.getByTestId("voice-profile-status").textContent).toContain(
      "5 messages"
    )
    const display = screen.getByTestId("voice-profile-display")
    expect(display.textContent).toContain("warm, direct")
    expect(display.textContent).toContain("business-casual")
    expect(display.textContent).toContain("dash asides")
    expect(screen.getByTestId("voice-profile-learn").textContent).toContain(
      "Refresh"
    )
    expect(screen.getByTestId("voice-profile-delete")).not.toBeNull()
  })

  it("disables learning without a configured provider, stating why", async () => {
    seedState({ aiReady: false, profile: null })
    await renderSection()
    const learn = screen.getByTestId("voice-profile-learn")
    expect((learn as HTMLButtonElement).disabled).toBe(true)
    expect(learn.getAttribute("title")).toContain("provider")
  })

  it("disables learning without enough sent mail, stating the floor", async () => {
    seedState({ aiReady: true, sentCount: 1, profile: null })
    await renderSection()
    const learn = screen.getByTestId("voice-profile-learn")
    expect((learn as HTMLButtonElement).disabled).toBe(true)
    expect(learn.getAttribute("title")).toContain("3 sent messages")
  })

  it("learning reports completion inline and shows the refreshed profile", async () => {
    seedState({ sentCount: 12, profile: null })
    await renderSection()
    expect(screen.getByTestId("voice-profile-status").textContent).toContain(
      "12 sent messages"
    )
    learnWritingVoiceProfileMock.mockResolvedValue({ ok: true, messageCount: 12 })
    // After the learn, the re-read finds the stored profile.
    getVoiceProfileMock.mockResolvedValue(SAMPLE_PROFILE)

    fireEvent.click(screen.getByTestId("voice-profile-learn"))
    const notice = await screen.findByTestId("voice-profile-notice")
    expect(notice.textContent).toContain("learned from 12 sent messages")
    await screen.findByTestId("voice-profile-display")
    expect(learnWritingVoiceProfileMock).toHaveBeenCalledTimes(1)
  })

  it("a typed learn failure surfaces as an alert with the reason", async () => {
    seedState({ sentCount: 12, profile: null })
    await renderSection()
    learnWritingVoiceProfileMock.mockResolvedValue({
      ok: false,
      reason: "parse" as const,
    })

    fireEvent.click(screen.getByTestId("voice-profile-learn"))
    const notice = await screen.findByTestId("voice-profile-notice")
    expect(notice.getAttribute("role")).toBe("alert")
    expect(notice.textContent).toContain("could not be read")
    expect(getVoiceProfileMock).toHaveBeenCalledTimes(1) // initial load only
  })

  it("delete removes the profile and returns to the empty state", async () => {
    seedState({ profile: SAMPLE_PROFILE })
    await renderSection()
    deleteVoiceProfileMock.mockResolvedValue(undefined)
    getVoiceProfileMock.mockResolvedValue(null)

    fireEvent.click(screen.getByTestId("voice-profile-delete"))
    await waitFor(() => {
      expect(deleteVoiceProfileMock).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(screen.getByTestId("voice-profile-status").textContent).toContain(
        "No writing voice learned yet"
      )
    })
    expect(screen.queryByTestId("voice-profile-display")).toBeNull()
  })
})
