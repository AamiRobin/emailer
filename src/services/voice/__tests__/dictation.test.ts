import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  beginDictation,
  DictationCancelledError,
  encodeWavF32Mono16k,
  type DictationDeps,
  type TranscriptionResult,
} from "../dictation"

// The temp-path default resolves through the Tauri path API (no mock-
// mode aliasing under vitest — the key-management tests' approach): a
// fixed appDataDir with POSIX joins.
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/mock/appdata",
  join: async (...parts: string[]) =>
    parts.filter((part) => part !== "").join("/"),
}))

/**
 * Dictation service tests (parity-round-3 task 7.2, design D3): the full
 * record → decode → WAV temp file → transcribe → cleanup pipeline driven
 * through injected fakes (the attachments-cache deps pattern — no Tauri,
 * no WebAudio, no mic). Asserted here: the happy path's temp-file
 * lifecycle (written, then deleted, whatever the outcome), the WAV bytes
 * matching the exact shape the Rust reader parses (RIFF/float32/mono/
 * 16 kHz), the language hint riding the transcribe call, the cancel
 * contract (discard, delete, nothing transcribed, mic released), and the
 * typed DictationCancelledError on a cancel that lands mid-processing.
 */

interface FakeRecorder {
  state: "inactive" | "recording"
  mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null
  onstop: (() => void) | null
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  emitChunk: (blob: Blob) => void
}

function fakeRecorder(): FakeRecorder {
  const recorder: FakeRecorder = {
    state: "inactive",
    mimeType: "audio/webm",
    ondataavailable: null,
    onstop: null,
    start: vi.fn(() => {
      recorder.state = "recording"
    }),
    stop: vi.fn(() => {
      if (recorder.state === "inactive") return
      recorder.state = "inactive"
      // The platform emits the final chunk, then onstop, off the click
      // handler — mirror that with a microtask.
      queueMicrotask(() => {
        recorder.ondataavailable?.({ data: new Blob(["recorded-bytes"]) })
        recorder.onstop?.()
      })
    }),
    emitChunk: (blob: Blob) => {
      recorder.ondataavailable?.({ data: blob })
    },
  }
  return recorder
}

interface Harness {
  recorder: FakeRecorder
  tracksStopped: number
  written: Array<{ path: string; data: Uint8Array }>
  removed: string[]
  transcribeCalls: Array<{
    modelDir: string
    path: string
    languageHint: string
  }>
  deps: Partial<DictationDeps>
}

function harness(
  overrides: {
    transcribe?: DictationDeps["transcribe"]
    decodeToMono16k?: DictationDeps["decodeToMono16k"]
  } = {}
): Harness {
  const recorder = fakeRecorder()
  const harness: Harness = {
    recorder,
    tracksStopped: 0,
    written: [],
    removed: [],
    transcribeCalls: [],
    deps: {
      getUserMedia: async () => {
        return {
          getTracks: () => [
            {
              stop: () => {
                harness.tracksStopped += 1
              },
            },
          ],
        } as unknown as MediaStream
      },
      createRecorder: () => recorder as unknown as MediaRecorder,
      decodeToMono16k:
        overrides.decodeToMono16k ??
        (async () => new Float32Array([0.1, -0.2, 0.3])),
      ensureDir: async () => {},
      writeFile: async (path, data) => {
        harness.written.push({ path, data })
      },
      removeFile: async (path) => {
        harness.removed.push(path)
      },
      transcribe:
        overrides.transcribe ??
        (async (args) => {
          harness.transcribeCalls.push(args)
          return { text: "Hello there", language: "en" }
        }),
      tempFileName: () => "dictation-fixed.wav",
    },
  }
  return harness
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("beginDictation happy path", () => {
  it("writes the temp WAV, transcribes, deletes the file and returns the text", async () => {
    const environment = harness()
    const session = await beginDictation(environment.deps)
    expect(environment.recorder.state).toBe("recording")

    const text = await session.stop("de")

    expect(text).toBe("Hello there")
    // One temp file written into voice_temp under appDataDir, and the
    // SAME path handed to transcribe and deleted afterwards.
    expect(environment.written).toHaveLength(1)
    const writtenPath = environment.written[0].path
    expect(writtenPath).toBe("/mock/appdata/voice_temp/dictation-fixed.wav")
    expect(environment.transcribeCalls).toEqual([
      {
        modelDir: "/mock/appdata/models/ggml-base",
        path: writtenPath,
        languageHint: "de",
      },
    ])
    expect(environment.removed).toEqual([writtenPath])
    // The mic is released (spec: local-only processing, nothing left
    // holding the hardware).
    expect(environment.tracksStopped).toBe(1)
  })

  it("encodes the WAV exactly as the Rust reader parses it", async () => {
    const environment = harness()
    const session = await beginDictation(environment.deps)
    await session.stop("")

    const { data } = environment.written[0]
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const ascii = (offset: number, length: number): string =>
      String.fromCharCode(...data.subarray(offset, offset + length))
    // Canonical 44-byte header: RIFF/WAVE, IEEE float (tag 3), mono,
    // 16 kHz, 32-bit, data chunk sized to the sample count.
    expect(ascii(0, 4)).toBe("RIFF")
    expect(ascii(8, 4)).toBe("WAVE")
    expect(ascii(12, 4)).toBe("fmt ")
    expect(view.getUint16(20, true)).toBe(3)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(34, true)).toBe(32)
    expect(ascii(36, 4)).toBe("data")
    expect(view.getUint32(40, true)).toBe(3 * 4)
    // The samples survive the encoding verbatim (little-endian f32).
    expect(view.getFloat32(44, true)).toBeCloseTo(0.1)
    expect(view.getFloat32(48, true)).toBeCloseTo(-0.2)
    expect(view.getFloat32(52, true)).toBeCloseTo(0.3)
  })

  it("an empty transcript still inserts-as-empty without an error", async () => {
    // Silence transcribes to "" — a valid result, not a failure.
    const environment = harness({
      transcribe: async (args) => {
        environment.transcribeCalls.push(args)
        return { text: "", language: "en" }
      },
    })
    const session = await beginDictation(environment.deps)
    expect(await session.stop("")).toBe("")
    expect(environment.transcribeCalls).toHaveLength(1)
  })
})

describe("encodeWavF32Mono16k", () => {
  it("round-trips through the documented layout for an empty utterance", () => {
    const bytes = encodeWavF32Mono16k(new Float32Array(0))
    expect(bytes.byteLength).toBe(44)
    const view = new DataView(bytes.buffer)
    expect(view.getUint32(40, true)).toBe(0) // zero data bytes
    expect(view.getUint32(4, true)).toBe(36) // riff size = 36 + data
  })
})

describe("cancel", () => {
  it("discards the recording, releases the mic and never transcribes", async () => {
    const environment = harness()
    const session = await beginDictation(environment.deps)
    expect(environment.recorder.state).toBe("recording")

    await session.cancel()

    // Recorder stopped, mic released, nothing written or transcribed.
    expect(environment.recorder.state).toBe("inactive")
    expect(environment.tracksStopped).toBe(1)
    expect(environment.written).toHaveLength(0)
    expect(environment.transcribeCalls).toHaveLength(0)
    expect(environment.removed).toHaveLength(0)

    // A late stop() after the cancel cannot resurrect the flow: the
    // typed cancellation error, nothing else.
    await expect(session.stop("en")).rejects.toBeInstanceOf(
      DictationCancelledError
    )
    expect(environment.transcribeCalls).toHaveLength(0)
    expect(environment.written).toHaveLength(0)
  })

  it("cancel during stop's processing deletes the temp file and the caller gets the typed error", async () => {
    // A transcribe seam held pending while the user clicks ✕ — the
    // typed cancellation error must win over the (arriving) text and
    // the temp file must still be deleted.
    let resolveTranscribe!: (value: TranscriptionResult) => void
    const environment = harness({
      transcribe: (args) => {
        environment.transcribeCalls.push(args)
        return new Promise<TranscriptionResult>((resolve) => {
          resolveTranscribe = resolve
        })
      },
    })
    const session = await beginDictation(environment.deps)
    const stopping = session.stop("en")
    // Wait until the temp file is written and the invoke is in flight,
    // then cancel mid-processing.
    await vi.waitFor(() =>
      expect(environment.transcribeCalls).toHaveLength(1)
    )
    await session.cancel()
    resolveTranscribe({ text: "Too late", language: "en" })
    await expect(stopping).rejects.toBeInstanceOf(DictationCancelledError)
    // Deleted exactly once (cancel's cleanup; stop's finally no-ops).
    expect(environment.removed).toEqual([
      "/mock/appdata/voice_temp/dictation-fixed.wav",
    ])
    expect(environment.written).toHaveLength(1)
  })

  it("a transcribe failure still deletes the temp file and propagates", async () => {
    const environment = harness({
      transcribe: async (args) => {
        environment.transcribeCalls.push(args)
        throw { kind: "model_missing", message: "model file gone" }
      },
    })
    const session = await beginDictation(environment.deps)
    await expect(session.stop("")).rejects.toMatchObject({
      kind: "model_missing",
    })
    // The typed Rust error propagated AND the temp WAV is gone.
    expect(environment.transcribeCalls).toHaveLength(1)
    expect(environment.removed).toEqual([
      "/mock/appdata/voice_temp/dictation-fixed.wav",
    ])
  })
})
