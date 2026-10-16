import { invoke } from "@tauri-apps/api/core"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * The pinned BGE-small-en-v1.5 model catalog + download orchestration
 * (parity-round-3 design D1, tasks 6.1/6.5). The three model files are
 * fetched through the shared Rust downloader (task 1.4's `download_model`
 * — streaming progress events, SHA-256 verification BEFORE activation,
 * cancel) into `<appDataDir>/models/bge-small-en-v1.5/`, the directory
 * `embed_texts` (task 6.1) loads them from. Rust only moves bytes; the
 * download STATE row per file lives in migration v21's `model_downloads`
 * and is written here, frontend-side, from the events and return values.
 *
 * Pinned revision (verified 2026-10-04 by downloading and hashing the
 * files; documented Rust-side in src-tauri/src/embeddings/mod.rs):
 *   repo     BAAI/bge-small-en-v1.5 (official, safetensors, no ONNX)
 *   revision 5c38ec7c405ec4b44b94cc5a9bb96e735b38267a
 * For tokenizer.json and config.json (plain git blobs, not LFS) the
 * SHA-256 below was computed over the exact pinned-revision bytes; for
 * model.safetensors it is the LFS oid, which IS the file's SHA-256.
 */

export interface BgeModelFile {
  /** The model_downloads row key + cancel id (one per FILE — the table
   * is keyed by model_id and each file downloads, reports and cancels
   * independently). */
  modelId: string
  filename: string
  url: string
  expectedSha256: string
  /** Exact byte size at the pinned revision — the consent copy's
   * "model size" number (spec: state the size before download). */
  bytes: number
}

export const BGE_MODEL_DIR_NAME = "bge-small-en-v1.5"

const BGE_REVISION = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a"

const BGE_BASE_URL =
  `https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/${BGE_REVISION}`

/** Download order matters: the tiny files first, the ~127 MB weights
 * last — a cancelled download then leaves the cheap files already in
 * place for the retry. */
export const BGE_MODEL_FILES: readonly BgeModelFile[] = [
  {
    modelId: "bge-small-tokenizer",
    filename: "tokenizer.json",
    url: `${BGE_BASE_URL}/tokenizer.json`,
    expectedSha256:
      "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    bytes: 711396,
  },
  {
    modelId: "bge-small-config",
    filename: "config.json",
    url: `${BGE_BASE_URL}/config.json`,
    expectedSha256:
      "094f8e891b932f2000c92cfc663bac4c62069f5d8af5b5278c4306aef3084750",
    bytes: 743,
  },
  {
    modelId: "bge-small-safetensors",
    filename: "model.safetensors",
    url: `${BGE_BASE_URL}/model.safetensors`,
    expectedSha256:
      "3c9f31665447c8911517620762200d2245a2518d6e7208acc78cd9db317e21ad",
    bytes: 133466304,
  },
]

/** The file the settings UI's progress bar tracks (the only big one). */
export const BGE_PRIMARY_MODEL_ID = "bge-small-safetensors"

/** Approximate total download size, for the consent copy. */
export const BGE_TOTAL_BYTES = BGE_MODEL_FILES.reduce(
  (sum, file) => sum + file.bytes,
  0
)

/** Wire shape of `models://download-progress` (model_downloads/mod.rs). */
export interface ModelDownloadProgressPayload {
  modelId: string
  received: number
  total: number | null
}

/** Wire shape of `models://download-finished`. */
export interface ModelDownloadFinishedPayload {
  modelId: string
  path: string
  bytes: number
  sha256: string
}

/** Wire shape of `models://download-cancelled`. */
export interface ModelDownloadCancelledPayload {
  modelId: string
}

// ---------------------------------------------------------------------------
// Download state (observable snapshot — the category-backfill pattern)
// ---------------------------------------------------------------------------

/** Lifecycle of the three-file download as one unit. */
export type BgeDownloadState =
  | "idle" // not started, or already complete (see modelFilesPresent)
  | "downloading"
  | "completed"
  | "cancelled"
  | "failed"

export interface BgeDownloadSnapshot {
  state: BgeDownloadState
  /** Bytes of the currently-downloading file (0 otherwise). */
  received: number
  /** Total of the currently-downloading file (null until the server
   * reports Content-Length). */
  total: number | null
  /** modelId of the file in flight (or the last one that settled). */
  modelId: string | null
  /** Typed error kind from the Rust downloader (checksum_mismatch,
   * network, io, cancelled, …); null while clean. */
  error: string | null
}

const IDLE_SNAPSHOT: BgeDownloadSnapshot = {
  state: "idle",
  received: 0,
  total: null,
  modelId: null,
  error: null,
}

let snapshot: BgeDownloadSnapshot = IDLE_SNAPSHOT
const downloadListeners = new Set<(snapshot: BgeDownloadSnapshot) => void>()

function setSnapshot(patch: Partial<BgeDownloadSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const listener of downloadListeners) {
    try {
      listener(snapshot)
    } catch (error) {
      console.warn("[embeddings] download listener failed", error)
    }
  }
}

/** The current download snapshot (stable reference between changes —
 * safe as a useSyncExternalStore snapshot). */
export function getBgeDownloadSnapshot(): BgeDownloadSnapshot {
  return snapshot
}

/** Observe download progress; returns the unsubscribe function. */
export function subscribeBgeDownload(
  listener: (snapshot: BgeDownloadSnapshot) => void
): () => void {
  downloadListeners.add(listener)
  return () => {
    downloadListeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// model_downloads persistence (migration v21, written from TS only)
// ---------------------------------------------------------------------------

/** One persisted row's state vocabulary (open TEXT by design — see the
 * migration comment; the enum here is this module's writer contract). */
export type ModelDownloadRowState =
  | "downloading"
  | "completed"
  | "cancelled"
  | "failed"

/** Upsert the model's state row (error = typed kind + message, NULL
 * while clean). */
async function recordDownloadState(
  executor: SqlExecutor,
  modelId: string,
  state: ModelDownloadRowState,
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
    [modelId, state, bytesDownloaded, totalBytes, error]
  )
}

/**
 * Whether the model is DOWNLOADED: every file's persisted row says
 * completed (the Rust downloader only renames a verified file into
 * place, so "completed" means checksum-clean bytes on disk). The read
 * fail-toward-false: a corrupt/missing row reads as absent and the
 * caller offers a re-download.
 */
export async function modelFilesPresent(
  executor: SqlExecutor
): Promise<boolean> {
  const rows = await executor.select<{ model_id: string; state: string }>(
    "SELECT model_id, state FROM model_downloads"
  )
  const states = new Map(rows.map((row) => [row.model_id, row.state]))
  return BGE_MODEL_FILES.every(
    (file) => states.get(file.modelId) === "completed"
  )
}

// ---------------------------------------------------------------------------
// The download flow
// ---------------------------------------------------------------------------

/** Options for `downloadBgeModel` — tests inject the event seam. */
export interface DownloadBgeOptions {
  /** Progress/finish/cancel event subscription. Production wires the
   * Tauri `models://download-*` events (see attachBgeDownloadEvents);
   * tests drive updates directly. */
  events?: BgeDownloadEvents
}

/**
 * The event seam: the same three notifications the Rust downloader
 * emits. A single object (not three listen() handles) so the production
 * wiring is one subscription and tests can drive the state machine
 * without a Tauri runtime.
 */
export interface BgeDownloadEvents {
  onProgress(payload: ModelDownloadProgressPayload): void
  onFinished(payload: ModelDownloadFinishedPayload): void
  onCancelled(payload: ModelDownloadCancelledPayload): void
}

/**
 * Download the three pinned model files sequentially (see
 * BGE_MODEL_FILES for the order), updating the snapshot + the persisted
 * rows as it goes. Resolves true when the model is complete; resolves
 * FALSE on cancellation (not an error — spec: cancelling leaves no
 * partially enabled feature) and throws on hard failures (the settings
 * section renders the message and offers a retry).
 *
 * Single-flight: a download while one is running is a no-op resolving
 * false (the running one continues).
 */
export async function downloadBgeModel(
  executor: SqlExecutor,
  modelDir: string,
  options?: DownloadBgeOptions
): Promise<boolean> {
  if (snapshot.state === "downloading") return false
  const events: BgeDownloadEvents = options?.events ?? {
    onProgress: () => {},
    onFinished: () => {},
    onCancelled: () => {},
  }
  setSnapshot({ ...IDLE_SNAPSHOT, state: "downloading" })
  try {
    for (const file of BGE_MODEL_FILES) {
      setSnapshot({
        received: 0,
        total: file.bytes,
        modelId: file.modelId,
        error: null,
      })
      await recordDownloadState(
        executor,
        file.modelId,
        "downloading",
        0,
        file.bytes,
        null
      )
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
          file.modelId,
          "completed",
          result.bytes,
          file.bytes,
          null
        )
        events.onFinished({
          modelId: file.modelId,
          path: result.path,
          bytes: result.bytes,
          sha256: result.sha256,
        })
      } catch (caught) {
        const error = caught as { kind?: string; message?: string }
        const kind = typeof error?.kind === "string" ? error.kind : "unknown"
        const message =
          typeof error?.message === "string" ? error.message : String(caught)
        if (kind === "cancelled") {
          await recordDownloadState(
            executor,
            file.modelId,
            "cancelled",
            snapshot.received,
            file.bytes,
            null
          )
          events.onCancelled({ modelId: file.modelId })
          setSnapshot({ state: "cancelled", error: null })
          return false
        }
        await recordDownloadState(
          executor,
          file.modelId,
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
    }
    setSnapshot({ state: "completed", received: 0, total: null })
    return true
  } finally {
    // Leave the in-flight bookkeeping clear whatever the outcome.
    setSnapshot({ received: 0, total: null, modelId: null })
  }
}

/**
 * Flag the running download for cancellation. Fire-and-forget: the Rust
 * stream loop checks the flag between chunks; the awaited
 * `downloadBgeModel` settles with false shortly after.
 */
export async function cancelBgeModelDownload(): Promise<void> {
  for (const file of BGE_MODEL_FILES) {
    // Unknown (already settled) ids answer false — a no-op cleanup.
    await invoke("cancel_model_download", { modelId: file.modelId })
  }
}

/**
 * Wire the production Tauri events into the snapshot (the settings
 * section calls this once on mount; the update-notice's unsubscribe
 * pattern). Progress lands in the snapshot only for the file that is
 * actually in flight, so a straggler event cannot lie about a finished
 * file.
 */
export async function attachBgeDownloadEvents(): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event")
  const unlistens = await Promise.all([
    listen<ModelDownloadProgressPayload>(
      "models://download-progress",
      (event) => {
        if (event.payload.modelId !== snapshot.modelId) return
        setSnapshot({
          received: event.payload.received,
          total: event.payload.total,
        })
      }
    ),
    listen<ModelDownloadFinishedPayload>(
      "models://download-finished",
      () => {
        // The awaited invoke already records the completed state; events
        // are informational for other windows.
      }
    ),
    listen<ModelDownloadCancelledPayload>(
      "models://download-cancelled",
      () => {
        // Same: the awaited invoke's typed cancelled error owns the state
        // transition; this only mirrors it to secondary windows.
      }
    ),
  ])
  return () => {
    for (const unlisten of unlistens) unlisten()
  }
}

/**
 * The absolute models directory for the pinned BGE model:
 * `<appDataDir>/models/bge-small-en-v1.5`. Dynamic import like
 * key-management.ts — keeps the module importable outside the Tauri
 * runtime (plain vite, tests) as long as the function is not called.
 */
export async function getBgeModelDir(): Promise<string> {
  const { appDataDir, join } = await import("@tauri-apps/api/path")
  return join(await appDataDir(), "models", BGE_MODEL_DIR_NAME)
}
