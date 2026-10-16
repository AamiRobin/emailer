import { invoke } from "@tauri-apps/api/core"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * The pinned whisper ggml-base model catalog + download orchestration
 * (parity-round-3 design D3, tasks 7.1/7.2) — the voice sibling of the
 * BGE catalog (src/services/embeddings/model.ts, followed file for
 * file). ONE model file is fetched through the shared Rust downloader
 * (task 1.4's `download_model` — streaming progress events, SHA-256
 * verification BEFORE activation, cancel) into
 * `<appDataDir>/models/ggml-base/`, the directory the `transcribe`
 * command (task 7.1) loads it from. Rust only moves bytes; the download
 * STATE row lives in migration v21's `model_downloads` (key "ggml-base")
 * and is written here, frontend-side, from the events and return values.
 *
 * Pinned revision (verified 2026-10-04 by downloading the file and
 * hashing it locally; documented Rust-side in src-tauri/src/voice/mod.rs):
 *   repo     ggerganov/whisper.cpp (official whisper.cpp models)
 *   revision 5359861c739e955e79d9a303bcbc70fb988958b1
 * The SHA-256 below is the file's LFS oid at that revision — IS the file's
 * SHA-256, and matched the locally computed digest exactly.
 *
 * Spec "First-use download": the model is NOT fetched until dictation is
 * first used — the composer's dictation control offers the download (with
 * this size stated) on first press; the settings voice section offers the
 * same flow outside the composer. No enable toggle exists: the feature is
 * exactly "the model is downloaded and the user dictates".
 */

export interface WhisperModelFile {
  /** The model_downloads row key + cancel id. */
  modelId: string
  filename: string
  url: string
  expectedSha256: string
  /** Exact byte size at the pinned revision — the consent copy's
   * "model size" number (spec: state the size before download). */
  bytes: number
}

export const WHISPER_MODEL_DIR_NAME = "ggml-base"

export const WHISPER_MODEL_ID = "ggml-base"

const WHISPER_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1"

export const WHISPER_MODEL_FILE: WhisperModelFile = {
  modelId: WHISPER_MODEL_ID,
  filename: "ggml-base.bin",
  url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_REVISION}/ggml-base.bin`,
  expectedSha256:
    "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
  bytes: 147951465,
}

/** Approximate download size, for the consent copy (~148 MB). */
export const WHISPER_TOTAL_BYTES = WHISPER_MODEL_FILE.bytes

// ---------------------------------------------------------------------------
// Download state (observable snapshot — the BGE module's pattern)
// ---------------------------------------------------------------------------

/** Lifecycle of the single-file download. */
export type WhisperDownloadState =
  | "idle" // not started, or already complete (see whisperModelPresent)
  | "downloading"
  | "completed"
  | "cancelled"
  | "failed"

export interface WhisperDownloadSnapshot {
  state: WhisperDownloadState
  received: number
  /** null until the server reports Content-Length. */
  total: number | null
  error: string | null
}

const IDLE_SNAPSHOT: WhisperDownloadSnapshot = {
  state: "idle",
  received: 0,
  total: null,
  error: null,
}

let snapshot: WhisperDownloadSnapshot = IDLE_SNAPSHOT
const downloadListeners = new Set<(snapshot: WhisperDownloadSnapshot) => void>()

function setSnapshot(patch: Partial<WhisperDownloadSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const listener of downloadListeners) {
    try {
      listener(snapshot)
    } catch (error) {
      console.warn("[voice] download listener failed", error)
    }
  }
}

/** The current download snapshot (stable reference between changes —
 * safe as a useSyncExternalStore snapshot). */
export function getWhisperDownloadSnapshot(): WhisperDownloadSnapshot {
  return snapshot
}

/** Observe download progress; returns the unsubscribe function. */
export function subscribeWhisperDownload(
  listener: (snapshot: WhisperDownloadSnapshot) => void
): () => void {
  downloadListeners.add(listener)
  return () => {
    downloadListeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// model_downloads persistence (migration v21, written from TS only)
// ---------------------------------------------------------------------------

/** Upsert the model's state row (error = typed kind + message, NULL
 * while clean). The row vocabulary mirrors the BGE module's writer
 * contract: downloading | completed | cancelled | failed. */
async function recordDownloadState(
  executor: SqlExecutor,
  state: "downloading" | "completed" | "cancelled" | "failed",
  bytesDownloaded: number,
  totalBytes: number | null,
  error: string | null
): Promise<void> {
  await executor.execute(
    `INSERT INTO model_downloads
       (model_id, state, bytes_downloaded, total_bytes, error, updated_at)
     VALUES ($1, $2, $3, $4, $5, unixepoch())
     ON CONFLICT(model_id) DO UPDATE SET
       state = excluded.state,
       bytes_downloaded = excluded.bytes_downloaded,
       total_bytes = excluded.total_bytes,
       error = excluded.error,
       updated_at = excluded.updated_at`,
    [WHISPER_MODEL_ID, state, bytesDownloaded, totalBytes, error]
  )
}

/**
 * Whether the whisper model is DOWNLOADED: the persisted row says
 * completed (the Rust downloader only renames a verified file into
 * place, so "completed" means checksum-clean bytes on disk). The read
 * fails toward false: a corrupt/missing row reads as absent and the
 * caller offers the (first-use) download.
 */
export async function whisperModelPresent(
  executor: SqlExecutor
): Promise<boolean> {
  const rows = await executor.select<{ state: string }>(
    "SELECT state FROM model_downloads WHERE model_id = $1",
    [WHISPER_MODEL_ID]
  )
  return rows[0]?.state === "completed"
}

// ---------------------------------------------------------------------------
// The download flow
// ---------------------------------------------------------------------------

/** Options for `downloadWhisperModel` — tests inject the event seam. */
export interface DownloadWhisperOptions {
  /** Progress/finish/cancel notifications. Production ignores them (the
   * awaited invoke + the snapshot drive the UI); tests assert on them. */
  events?: WhisperDownloadEvents
}

/** The event seam: the same three notifications the Rust downloader
 * emits (mirrors BgeDownloadEvents). */
export interface WhisperDownloadEvents {
  onProgress(payload: { received: number; total: number | null }): void
  onFinished(payload: { path: string; bytes: number; sha256: string }): void
  onCancelled(): void
}

/**
 * Download the pinned ggml-base model file, updating the snapshot + the
 * persisted row as it goes. Resolves true when complete; resolves FALSE
 * on cancellation (not an error) and throws on hard failures (the UI
 * renders the message and offers a retry). Single-flight: a download
 * while one is running is a no-op resolving false.
 */
export async function downloadWhisperModel(
  executor: SqlExecutor,
  modelDir: string,
  options?: DownloadWhisperOptions
): Promise<boolean> {
  if (snapshot.state === "downloading") return false
  const events: WhisperDownloadEvents = options?.events ?? {
    onProgress: () => {},
    onFinished: () => {},
    onCancelled: () => {},
  }
  const file = WHISPER_MODEL_FILE
  setSnapshot({ ...IDLE_SNAPSHOT, state: "downloading" })
  try {
    setSnapshot({ received: 0, total: file.bytes, error: null })
    await recordDownloadState(executor, "downloading", 0, file.bytes, null)
    try {
      const result = await invoke<{
        path: string
        bytes: number
        sha256: string
      }>("download_model", {
        modelId: file.modelId,
        url: file.url,
        expectedSha256: file.expectedSha256,
        destDir: modelDir,
      })
      await recordDownloadState(
        executor,
        "completed",
        result.bytes,
        file.bytes,
        null
      )
      events.onFinished({
        path: result.path,
        bytes: result.bytes,
        sha256: result.sha256,
      })
      setSnapshot({ state: "completed", received: 0, total: null })
      return true
    } catch (caught) {
      const error = caught as { kind?: string; message?: string }
      const kind = typeof error?.kind === "string" ? error.kind : "unknown"
      const message =
        typeof error?.message === "string" ? error.message : String(caught)
      if (kind === "cancelled") {
        await recordDownloadState(
          executor,
          "cancelled",
          snapshot.received,
          file.bytes,
          null
        )
        events.onCancelled()
        setSnapshot({ state: "cancelled", error: null })
        return false
      }
      await recordDownloadState(
        executor,
        "failed",
        snapshot.received,
        file.bytes,
        kind
      )
      setSnapshot({ state: "failed", error: kind })
      throw new Error(`Model download failed (${kind}): ${message}`, {
        cause: caught,
      })
    }
  } finally {
    setSnapshot({ received: 0, total: null })
  }
}

/**
 * Flag the running download for cancellation. Fire-and-forget: the Rust
 * stream loop checks the flag between chunks; the awaited
 * `downloadWhisperModel` settles with false shortly after.
 */
export async function cancelWhisperModelDownload(): Promise<void> {
  await invoke("cancel_model_download", { modelId: WHISPER_MODEL_ID })
}

/**
 * The absolute models directory for the pinned whisper model:
 * `<appDataDir>/models/ggml-base`. Dynamic import like the BGE module's
 * getBgeModelDir — keeps this module importable outside the Tauri
 * runtime (plain vite, tests) as long as the function is not called.
 */
export async function getWhisperModelDir(): Promise<string> {
  const { appDataDir, join } = await import("@tauri-apps/api/path")
  return join(await appDataDir(), "models", WHISPER_MODEL_DIR_NAME)
}
