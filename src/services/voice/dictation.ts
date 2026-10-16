import { isTauriRuntime } from "@/services/desktop/popout"

import { getWhisperModelDir } from "./model"

/**
 * Composer dictation (parity-round-3 task 7.2, design D3): record via
 * MediaRecorder → WebAudio decode + resample to 16 kHz mono → WAV temp
 * file through the fs plugin → the Rust `transcribe` command (whisper,
 * local only) → the recognized text. The INSERTION is the caller's (the
 * composer's cursor pipeline); this module owns everything up to and
 * including the text.
 *
 * Pipeline (design D3): the webview's MediaRecorder produces whatever
 * container the platform prefers; decodeAudioData turns it into an
 * AudioBuffer, the channels are averaged to mono and an
 * OfflineAudioContext resamples to exactly 16 kHz (whisper's fixed input
 * rate), and the samples are written as a canonical 44-byte-header
 * float32 WAV (the exact shape src-tauri/src/voice/mod.rs parses — the
 * Rust side REJECTS anything else, so a writer bug surfaces as a typed
 * error, never as garbage transcription).
 *
 * Cancel contract (spec "Cancel mid-dictation"): cancel() aborts the
 * recording, deletes the temp file and leaves nothing to insert —
 * stop() after a cancel (or a cancel during stop's processing) rejects
 * with DictationCancelledError and the caller inserts nothing. The temp
 * file lives only for the transcribe invoke: it is removed in a finally
 * on every path, success or failure.
 *
 * Everything with side effects — the microphone, WebAudio, disk, the
 * IPC — sits behind DictationDeps so the whole flow runs under vitest
 * with fakes (the attachments-cache pattern); production resolves the
 * defaults lazily so the module imports clean outside the Tauri runtime.
 */

/** Whisper's fixed input rate (mirrors the Rust module's constant). */
export const SAMPLE_RATE_HZ = 16_000

/** The temp WAV's directory under appDataDir. */
export const DICTATION_TEMP_DIR = "voice_temp"

/** Thrown by stop() when the session was cancelled (recording aborted,
 * temp file deleted) — the caller inserts nothing. */
export class DictationCancelledError extends Error {
  constructor() {
    super("Dictation cancelled")
    this.name = "DictationCancelledError"
  }
}

/** The `transcribe` command's wire shape (voice/mod.rs). */
export interface TranscriptionResult {
  text: string
  language: string
}

/** Injectable seams (tests inject all of them; production omits). */
export interface DictationDeps {
  /** Mic access. Default: navigator.mediaDevices.getUserMedia. */
  getUserMedia?: (constraints: { audio: boolean }) => Promise<MediaStream>
  /** Recorder factory. Default: new MediaRecorder(stream). */
  createRecorder?: (stream: MediaStream) => MediaRecorder
  /** Recorded blob → 16 kHz mono f32. Default: WebAudio decode +
   * OfflineAudioContext resample (decodeToMono16k). */
  decodeToMono16k?: (blob: Blob) => Promise<Float32Array>
  /** Create the temp directory. Default: plugin-fs mkdir (recursive). */
  ensureDir?: (absolutePath: string) => Promise<void>
  /** Write bytes to an absolute path. Default: plugin-fs writeFile. */
  writeFile?: (absolutePath: string, data: Uint8Array) => Promise<void>
  /** Delete a file (best-effort). Default: plugin-fs remove. */
  removeFile?: (absolutePath: string) => Promise<void>
  /** The transcribe invoke. Default: Tauri `transcribe` command with
   * the pinned model directory from the voice model module. */
  transcribe?: (args: {
    modelDir: string
    path: string
    languageHint: string
  }) => Promise<TranscriptionResult>
  /** Temp file name uniquifier (tests pin it; default crypto UUID). */
  tempFileName?: () => string
}

/** One live dictation: the mic is open and the recorder is running. */
export interface ActiveDictation {
  /** Stop recording and transcribe. Resolves the recognized text
   * (possibly empty for silence); rejects with DictationCancelledError
   * if cancel() won the race. The temp WAV is always cleaned up. */
  stop(languageHint: string): Promise<string>
  /** Abort: stop the recorder, discard the audio, release the mic,
   * delete any temp file. Inserts nothing (the caller's contract). */
  cancel(): Promise<void>
}

/**
 * Whether the dictation affordance may appear at all: a MediaRecorder
 * exists AND the app runs under the Tauri runtime (the transcribe
 * command + fs plugin are IPC — a plain browser has no local engine,
 * so the button hides instead of erroring; the unconfigured-surfaces-
 * hide rule every AI affordance follows).
 */
export function dictationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    isTauriRuntime()
  )
}

// ---------------------------------------------------------------------------
// WAV encoding (the exact shape the Rust reader accepts)
// ---------------------------------------------------------------------------

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index++) {
    view.setUint8(offset + index, text.charCodeAt(index))
  }
}

/**
 * Encode 16 kHz mono f32 samples as a canonical 44-byte-header WAV
 * (RIFF/WAVE, IEEE float format tag 3, mono, 16 kHz) — byte-for-byte
 * the fixture shape the Rust module's tests build.
 */
export function encodeWavF32Mono16k(samples: Float32Array): Uint8Array {
  const dataBytes = samples.length * 4
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  writeAscii(view, 0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, "WAVE")
  writeAscii(view, 12, "fmt ")
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 3, true) // IEEE float
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, SAMPLE_RATE_HZ, true)
  view.setUint32(28, SAMPLE_RATE_HZ * 4, true) // byte rate
  view.setUint16(32, 4, true) // block align
  view.setUint16(34, 32, true) // bits per sample
  writeAscii(view, 36, "data")
  view.setUint32(40, dataBytes, true)
  for (let index = 0; index < samples.length; index++) {
    view.setFloat32(44 + index * 4, samples[index], true)
  }
  return new Uint8Array(buffer)
}

// ---------------------------------------------------------------------------
// WebAudio decode + resample (production seam implementation)
// ---------------------------------------------------------------------------

/**
 * Decode a recorded blob and resample to 16 kHz mono: decodeAudioData
 * (native decoder, handles every container the webview's MediaRecorder
 * produces), channels averaged to mono, OfflineAudioContext rendering at
 * 16 kHz (the browser's resampler — linear-on-write with proper
 * anti-aliasing, better than a hand loop).
 */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer()
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  if (!AudioContextCtor) {
    throw new Error("WebAudio is unavailable in this webview")
  }
  const decodeContext = new AudioContextCtor()
  let audioBuffer: AudioBuffer
  try {
    audioBuffer = await decodeContext.decodeAudioData(arrayBuffer)
  } finally {
    void decodeContext.close().catch(() => {})
  }
  const frames = audioBuffer.length
  if (frames === 0) return new Float32Array(0)
  // Average every channel into one mono track first, so the resampler
  // runs once over the mixdown (identical result, half the work).
  const channels = audioBuffer.numberOfChannels
  const mono = new Float32Array(frames)
  for (let channel = 0; channel < channels; channel++) {
    const data = audioBuffer.getChannelData(channel)
    for (let frame = 0; frame < frames; frame++) {
      mono[frame] += data[frame] / channels
    }
  }
  const durationSeconds = frames / audioBuffer.sampleRate
  const targetFrames = Math.max(1, Math.ceil(durationSeconds * SAMPLE_RATE_HZ))
  const offline = new OfflineAudioContext(1, targetFrames, SAMPLE_RATE_HZ)
  const source = offline.createBufferSource()
  const monoBuffer = offline.createBuffer(1, frames, audioBuffer.sampleRate)
  monoBuffer.copyToChannel(mono, 0)
  source.buffer = monoBuffer
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/** Production defaults, resolved lazily so the module never touches a
 * Tauri-only API at import time. */
async function defaultTempPaths(fileName: string): Promise<{
  dir: string
  file: string
}> {
  const { appDataDir, join } = await import("@tauri-apps/api/path")
  const dir = await join(await appDataDir(), DICTATION_TEMP_DIR)
  return { dir, file: await join(dir, fileName) }
}

async function defaultTranscribe(args: {
  modelDir: string
  path: string
  languageHint: string
}): Promise<TranscriptionResult> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<TranscriptionResult>("transcribe", {
    modelDir: args.modelDir,
    path: args.path,
    languageHint: args.languageHint,
  })
}

/** Resolve one dep with its production default (undefined → default). */
function withDefault<K extends keyof DictationDeps>(
  deps: Partial<DictationDeps> | undefined,
  key: K,
  fallback: Exclude<DictationDeps[K], undefined>
): Exclude<DictationDeps[K], undefined> {
  const value = deps?.[key]
  return (value !== undefined ? value : fallback) as Exclude<
    DictationDeps[K],
    undefined
  >
}

/**
 * Open the mic and start recording. Resolves once the recorder is live
 * (the caller flips to its recording state only then); every failure —
 * permission denied, no recorder — rejects and nothing is left open.
 */
export async function beginDictation(
  deps?: Partial<DictationDeps>
): Promise<ActiveDictation> {
  const getUserMedia = withDefault(deps, "getUserMedia", (constraints) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      return Promise.reject(new Error("Microphone access is unavailable"))
    }
    return navigator.mediaDevices.getUserMedia(constraints)
  })
  const createRecorder = withDefault(deps, "createRecorder", (stream) => {
    if (typeof window.MediaRecorder === "undefined") {
      throw new Error("MediaRecorder is unavailable in this webview")
    }
    return new MediaRecorder(stream)
  })
  const decode = withDefault(deps, "decodeToMono16k", decodeToMono16k)
  const ensureDir = withDefault(deps, "ensureDir", async (absolutePath) => {
    const { mkdir } = await import("@tauri-apps/plugin-fs")
    await mkdir(absolutePath, { recursive: true })
  })
  const writeFile = withDefault(deps, "writeFile", async (absolutePath, data) => {
    const { writeFile: fsWriteFile } = await import("@tauri-apps/plugin-fs")
    await fsWriteFile(absolutePath, data)
  })
  const removeFile = withDefault(deps, "removeFile", async (absolutePath) => {
    const { remove } = await import("@tauri-apps/plugin-fs")
    await remove(absolutePath)
  })
  const transcribe = withDefault(deps, "transcribe", defaultTranscribe)
  const tempFileName =
    deps?.tempFileName ?? (() => `dictation-${crypto.randomUUID()}.wav`)

  const stream = await getUserMedia({ audio: true })
  let recorder: MediaRecorder
  try {
    recorder = createRecorder(stream)
  } catch (error) {
    // "No recorder" is an explicit failure mode of this function: the
    // already-opened mic tracks must not stay live across the rejection.
    for (const track of stream.getTracks()) track.stop()
    throw error
  }

  let cancelled = false
  const chunks: Blob[] = []
  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data && event.data.size > 0) chunks.push(event.data)
  }
  recorder.start()

  /** Best-effort temp-file removal (a lost race with stop's own finally
   * cleanup must not throw — double removal is the expected shape). */
  let tempPath: string | null = null
  const cleanupTemp = async (): Promise<void> => {
    const path = tempPath
    tempPath = null
    if (path === null) return
    try {
      await removeFile(path)
    } catch {
      // Already gone (stop's finally won the race) — fine.
    }
  }

  const releaseMic = (): void => {
    for (const track of stream.getTracks()) track.stop()
  }

  return {
    async stop(languageHint: string): Promise<string> {
      if (cancelled) {
        releaseMic()
        throw new DictationCancelledError()
      }
      // Stop the recorder and wait for the final dataavailable + onstop
      // (a native onstop handler would race the blob assembly here, so
      // the promise is armed before stop() and swapped out if already
      // inactive).
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
      })
      if (recorder.state !== "inactive") {
        recorder.stop()
      }
      await stopped
      releaseMic()
      if (cancelled) throw new DictationCancelledError()

      const blob = new Blob(chunks, {
        type: recorder.mimeType || "audio/webm",
      })
      const samples = await decode(blob)
      if (cancelled) throw new DictationCancelledError()

      // Write the temp WAV, transcribe it, clean it up — whatever the
      // outcome. The path is reserved before the write so a cancel that
      // lands mid-write still removes the file; the dir/write calls are
      // INSIDE the try so a filesystem failure cannot strand the user's
      // voice audio in voice_temp with no cleanup path.
      const { dir, file } = await defaultTempPaths(tempFileName())
      tempPath = file
      if (cancelled) {
        releaseMic()
        throw new DictationCancelledError()
      }
      try {
        await ensureDir(dir)
        await writeFile(file, encodeWavF32Mono16k(samples))
        if (cancelled) throw new DictationCancelledError()
        const result = await transcribe({
          modelDir: await getWhisperModelDir(),
          path: file,
          languageHint,
        })
        if (cancelled) throw new DictationCancelledError()
        return result.text
      } finally {
        await cleanupTemp()
      }
    },

    async cancel(): Promise<void> {
      cancelled = true
      try {
        if (recorder.state !== "inactive") recorder.stop()
      } catch {
        // Already stopped — the discard is what matters.
      }
      releaseMic()
      await cleanupTemp()
    },
  }
}
