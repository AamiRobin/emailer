import type { SqlExecutor } from "../db/executor"
import {
  composeFoldedText,
  type FoldedTextSource,
} from "./fts"

export {
  composeFoldedText,
  type FoldedTextSource,
} from "./fts"

/**
 * The folded-text backfill (parity-round-3 tasks 1.3/2.1, design D8).
 *
 * Migration v20 rebuilt messages_fts with the extra `folded` column — the
 * NFD diacritic-stripped copy of the searchable text. SQLite has no
 * SQL-side Unicode fold, so the column is TS-written: messages arriving
 * AFTER the write-path stamp lands (task 2.1) are folded at insert time,
 * and PRE-EXISTING rows are folded here, once, batched, fire-and-forget
 * from the app bootstrap (the categorization backfill's "upgrade fills
 * the new column" pattern, without the scheduler job — a one-shot catch-up
 * needs no 60s tick).
 *
 * Until a row is backfilled its folded column is NULL: the FTS row simply
 * matches through the raw columns only (exactly the pre-v20 behavior —
 * the trigram tokenizer's remove_diacritics still bridges Latin-1
 * accents), so a slow or interrupted backfill degrades, never breaks.
 * Each UPDATE re-fires the messages_fts_au trigger, so index and column
 * stay consistent row by row.
 */

/** Rows per batch: bounded work per await so a huge mailbox never pins
 * the main thread (the category-backfill batching convention). */
const BATCH_SIZE = 200

let running = false

/**
 * Backfill `messages.folded` for every row that predates v20 (folded IS
 * NULL), batch by batch, until none remain. Idempotent and resume-safe:
 * every UPDATE narrows to `AND folded IS NULL`, so a concurrent run (or a
 * re-entry after an error) can neither double-fold a row nor spin on a
 * poisoned batch — the cursor is the column itself.
 *
 * Returns the number of rows folded. Bootstrap fires this
 * fire-and-forget: a failure is logged, never surfaced as a startup
 * error (the raw-column search keeps working regardless).
 */
export async function backfillFoldedText(
  executor: SqlExecutor
): Promise<number> {
  if (running) return 0
  running = true
  let folded = 0
  try {
    // Seek by rowid cursor: without it every batch re-scans from rowid 1
    // past all already-stamped rows (no index supports `folded IS NULL`),
    // making a large mailbox quadratic. The cursor advances even over
    // rows this pass leaves NULL (concurrent inserts stamp their own).
    let cursor = 0
    for (;;) {
      const batch = await executor.select<FoldedTextSource & { rowid: number }>(
        `SELECT rowid, subject, from_name, from_address, to_json,
                body_text, snippet
         FROM messages
         WHERE folded IS NULL AND rowid > $1
         ORDER BY rowid ASC
         LIMIT ${BATCH_SIZE}`,
        [cursor]
      )
      if (!batch.length) break
      for (const row of batch) {
        await executor.execute(
          "UPDATE messages SET folded = $1 WHERE rowid = $2 AND folded IS NULL",
          [composeFoldedText(row), row.rowid]
        )
        folded += 1
      }
      cursor = batch[batch.length - 1].rowid
    }
  } finally {
    running = false
  }
  return folded
}
