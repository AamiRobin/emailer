import type { SqlExecutor } from "./executor"

/**
 * Attachment malware-verdict cache (task 18.9, mail-security "Opt-in
 * attachment malware lookup", design D18) over the `attachment_scan_cache`
 * table (migration v6). One row per SHA-256 — the hash is the identity, so
 * rows are GLOBAL, deliberately not account-scoped: the same file content
 * has the same verdict everywhere, and the table never stores filenames or
 * bytes, only the digest and the lookup report's engine counts.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

/** The lookup verdict tiers the table's CHECK constraint admits. */
export type ScanVerdict = "malicious" | "suspicious" | "clean" | "unknown"

/** Mirrors the `attachment_scan_cache` table (migrations.ts v6). */
export interface AttachmentScanRow {
  sha256: string
  verdict: ScanVerdict
  /** Engines flagging the file — the "N of M" report. Null when the
   * service could not attribute counts (unknown verdicts). */
  malicious_count: number | null
  total_engines: number | null
  /** Unix seconds of the last lookup (bookkeeping; no TTL is enforced —
   * cache hit = use). */
  looked_up_at: number
}

/** The cached verdict for one digest, or null when never looked up. */
export async function getScanVerdict(
  executor: SqlExecutor,
  sha256: string
): Promise<AttachmentScanRow | null> {
  const rows = await executor.select<AttachmentScanRow>(
    "SELECT * FROM attachment_scan_cache WHERE sha256 = $1",
    [sha256]
  )
  return rows[0] ?? null
}

/**
 * Persist (or overwrite) the verdict for one digest. Idempotent upsert on
 * the sha256 primary key: a later lookup's fresher report replaces the
 * stored row wholesale. Callers persist only DEFINITIVE verdicts — an
 * "unknown" (failed/unreachable lookup) is deliberately not stored, so
 * the next open retries instead of remembering a transient failure.
 */
export async function putScanVerdict(
  executor: SqlExecutor,
  sha256: string,
  input: {
    verdict: ScanVerdict
    maliciousCount?: number | null
    totalEngines?: number | null
    /** Unix-seconds clock (injectable for tests). Default: wall clock. */
    now?: () => number
  }
): Promise<void> {
  const now = input.now ?? (() => Math.floor(Date.now() / 1000))
  await executor.execute(
    `INSERT INTO attachment_scan_cache (
       sha256, verdict, malicious_count, total_engines, looked_up_at
     )
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(sha256) DO UPDATE SET
       verdict = excluded.verdict,
       malicious_count = excluded.malicious_count,
       total_engines = excluded.total_engines,
       looked_up_at = excluded.looked_up_at`,
    [
      sha256,
      input.verdict,
      input.maliciousCount ?? null,
      input.totalEngines ?? null,
      now(),
    ]
  )
}
