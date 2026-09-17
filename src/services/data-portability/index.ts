/**
 * Data portability (tasks 19.1–19.3, data-portability spec) — the API
 * surface for taking mailbox data IN and OUT of the app in standard
 * formats.
 *
 * OUT (export): both exports rebuild MIME from the parsed fields the
 * database stores (the messages table holds no raw RFC 822 — see eml.ts's
 * fidelity note): `rebuildEml` is the shared core, `exportThreadAsEml`
 * writes one `.eml` per message of a thread to a picked directory, and
 * `exportFolderAsMbox` streams a folder/label selection into a single
 * RFC 4155 mbox file with progress and cancel. Exports are read-only —
 * no row is modified, nothing is fetched from a server.
 *
 * IN (import, task 19.3): `importFiles` parses user-picked .eml/.mbox
 * files Rust-side (mail_import.rs — decoded messages plus the raw RFC 822
 * source), resolves/creates the destination folder through the existing
 * label CRUD, dedupes on Message-ID within the target folder, threads the
 * messages with the sync engines' semantics, caches attachment bytes, and
 * optionally appends each message to the server through the provider's
 * appendMessage. Per-file/per-entry failures never abort the batch, and
 * nothing existing is modified or deleted. See import.ts for the
 * documented semantics (read state, upload linkage).
 *
 * All Tauri plugins (dialog, fs) and the Rust parse commands sit behind
 * injectable `deps`, the file-actions.ts pattern, so flows run under
 * vitest with fakes. The settings UI entry points (task 19.4) consume
 * this module.
 */

export {
  emlFilename,
  exportThreadAsEml,
  rebuildEml,
  sanitizeFileStem,
  type EmlDeps,
  type EmlExportDeps,
  type EmlExportResult,
  type RebuiltEml,
} from "./eml"

export {
  escapeMboxBody,
  exportFolderAsMbox,
  mboxFromLine,
  type MboxExportDeps,
  type MboxExportOptions,
  type MboxExportResult,
  type StreamWriter,
} from "./mbox"

export {
  importFiles,
  pickImportFiles,
  type ImportDestination,
  type ImportDeps,
  type ImportEntryFailure,
  type ImportFileResult,
  type ImportOptions,
  type ImportSummary,
} from "./import"
