import type { SqlExecutor } from "@/services/db/executor"

/**
 * thread_vectors storage (parity-round-3 design D1, task 6.2) — the SQL
 * half of the embedding index, all frontend-owned (Rust never executes
 * app SQL; the DB-stack decision). Migration v21's table:
 *
 *   thread_vectors(account_id, thread_id, dim, vector BLOB,
 *                  content_hash, updated_at)  PK (account_id, thread_id)
 *
 * BLOB encoding: 384 little-endian f32s = the Float32Array's raw bytes.
 * The SQL plugin binds params as JSON values, and a JSON array would
 * arrive TEXT-shaped, so writes pass the vector as lowercase HEX and
 * store `unhex($n)` (SQLite ≥ 3.41 — the plugin bundles 3.46, node's
 * test SQLite is newer) — the column really holds a BLOB. Reads come
 * back from the plugin as a JSON number array and from the node:sqlite
 * test executor as a Uint8Array, so [`vectorToFloat32`] accepts both.
 *
 * Deleting an account (or a thread) removes its rows through the
 * schema's ON DELETE CASCADE — `deleteThreadVectors` exists for the
 * belt-and-braces explicit call sites (the account-deletion flow's
 * other cleanups) and for tests, and is also what makes a disabled
 * feature's data removable on demand.
 */

/** Rows to upsert in one statement batch. */
export interface ThreadVectorUpsert {
  accountId: string
  threadId: string
  vector: Float32Array
  contentHash: string
}

/** Encode bytes to lowercase hex (the unhex() input). */
export function float32ToHex(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
  let hex = ""
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0")
  }
  return hex
}

/** Decode a stored vector BLOB — the plugin returns number[], the test
 * executor a Uint8Array — back to the Float32Array the math wants.
 * Undecodable shapes (corrupt row) return null: one bad row must not
 * fail the whole account load (the caller drops the thread instead). */
export function vectorToFloat32(value: unknown): Float32Array | null {
  let bytes: Uint8Array
  // ArrayBuffer.isView rather than `instanceof Uint8Array`: the view can
  // come from another realm (vitest's jsdom vs the node:sqlite driver's)
  // and the instanceof check would silently reject every row there.
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  } else if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
    bytes = Uint8Array.from(value as number[])
  } else {
    return null
  }
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

/** Upsert one batch of vectors (the indexer's only write). */
export async function upsertThreadVectors(
  executor: SqlExecutor,
  rows: readonly ThreadVectorUpsert[]
): Promise<void> {
  for (const row of rows) {
    await executor.execute(
      `INSERT INTO thread_vectors
         (account_id, thread_id, dim, vector, content_hash, updated_at)
       VALUES ($1, $2, $3, unhex($4), $5, unixepoch())
       ON CONFLICT(account_id, thread_id) DO UPDATE SET
         dim = excluded.dim,
         vector = excluded.vector,
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at`,
      [
        row.accountId,
        row.threadId,
        row.vector.length,
        float32ToHex(row.vector),
        row.contentHash,
      ]
    )
  }
}

/** One stored vector row, as the loader consumes it. */
export interface ThreadVectorRow {
  thread_id: string
  vector: unknown
  content_hash: string
  updated_at: number
  last_message_at: number | null
}

/**
 * Every vector of one account, oldest thread first (last_message_at
 * ascending, NULLs oldest) — the loader's spill order: when the account
 * exceeds the in-memory cap the OLDEST rows are the ones dropped (design
 * D1's "oldest-first spill"), so the reader orders for that cut. The
 * thread join carries last_message_at for the same reason; a thread row
 * deleted mid-flight leaves no vector (CASCADE) and no join row.
 */
export async function listThreadVectors(
  executor: SqlExecutor,
  accountId: string
): Promise<ThreadVectorRow[]> {
  return executor.select<ThreadVectorRow>(
    `SELECT tv.thread_id, tv.vector, tv.content_hash, tv.updated_at,
            t.last_message_at
     FROM thread_vectors tv
     JOIN threads t ON t.id = tv.thread_id
     WHERE tv.account_id = $1
     ORDER BY t.last_message_at IS NOT NULL, t.last_message_at, tv.thread_id`,
    [accountId]
  )
}

/** How many vectors an account holds (the settings section's count). */
export async function countThreadVectors(
  executor: SqlExecutor,
  accountId: string
): Promise<number> {
  const rows = await executor.select<{ count: number }>(
    "SELECT COUNT(*) AS count FROM thread_vectors WHERE account_id = $1",
    [accountId]
  )
  return rows[0]?.count ?? 0
}

/** Explicit per-account delete (the FK cascade also covers it). */
export async function deleteThreadVectors(
  executor: SqlExecutor,
  accountId: string
): Promise<void> {
  await executor.execute("DELETE FROM thread_vectors WHERE account_id = $1", [
    accountId,
  ])
}
