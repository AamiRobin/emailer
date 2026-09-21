import type { SqlExecutor } from "../db/executor"
import { placeholders } from "../db/executor"
import type { Category, SenderCategorySource } from "./classify"
import { parseCategory } from "./classify"

/**
 * The `sender_categories` store (task 3.3, design D4, migration v9): one
 * row per SENDER (not per account — a sender is a sender across accounts,
 * like the contacts/participant matching) naming the category its mail
 * files under and who decided.
 *
 * Rows are read by the ingestion pass (categorization/ingestion.ts) as
 * one input to classifyMessage and WRITTEN by:
 * - task 3.4's user override ("always from sender") with source 'user'
 *   (deliberately NOT a rules-table row — D4 keeps the rules UI clean);
 * - the task 3.4 backfill with source 'heuristic';
 * - the later AI assist with source 'ai' (sender-cached per D2 — this
 *   table IS that cache for categorization).
 *
 * This module is the CRUD layer only; the ranking of user-sourced vs
 * heuristic-sourced rows against the header heuristics lives in
 * classify.ts (the spec makes a 'user' row "the rule for that sender").
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

/** The sender_categories row as stored (migration v9 columns). */
export interface SenderCategoryRow {
  /** Lowercased sender address (the primary key — see senderCategoryKey). */
  sender_key: string
  category: string
  source: SenderCategorySource
  updated_at: number
}

/** The typed read model the callers consume. */
export interface SenderCategory {
  category: Category
  source: SenderCategorySource
}

/**
 * Canonical sender_categories key for an address: trimmed and lowercased
 * (the sender_stats convention) so `News@List.example` mail and
 * `news@list.example` mail resolve to one row. Empty addresses never
 * become rows.
 */
export function senderCategoryKey(senderEmail: string): string | null {
  const key = senderEmail.trim().toLowerCase()
  return key === "" ? null : key
}

/**
 * The sender's stored category decision, or null when there is none (or
 * the address is empty). A row whose stored category no longer parses
 * (impossible through the CHECK, defensive against hand-edited rows)
 * reads as null rather than propagating a corrupt value.
 */
export async function getSenderCategory(
  executor: SqlExecutor,
  senderEmail: string
): Promise<SenderCategory | null> {
  const key = senderCategoryKey(senderEmail)
  if (!key) return null
  const rows = await executor.select<SenderCategoryRow>(
    "SELECT sender_key, category, source, updated_at FROM sender_categories WHERE sender_key = $1",
    [key]
  )
  const row = rows[0]
  if (!row) return null
  const category = parseCategory(row.category)
  if (!category) return null
  return { category, source: row.source }
}

/**
 * Category decisions for a BATCH of senders in one query (the ingestion
 * pass resolves every new message's sender with a single lookup instead
 * of one query per message). Senders without a row are absent from the
 * result; empty/normalization-collapsed keys are deduplicated.
 */
export async function getSenderCategories(
  executor: SqlExecutor,
  senderEmails: readonly (string | null | undefined)[]
): Promise<Map<string, SenderCategory>> {
  const result = new Map<string, SenderCategory>()
  const keys = new Set<string>()
  for (const email of senderEmails) {
    const key = email ? senderCategoryKey(email) : null
    if (key) keys.add(key)
  }
  if (keys.size === 0) return result
  const list = [...keys]
  const rows = await executor.select<SenderCategoryRow>(
    `SELECT sender_key, category, source, updated_at FROM sender_categories
     WHERE sender_key IN (${placeholders(list.length)})`,
    list
  )
  for (const row of rows) {
    const category = parseCategory(row.category)
    if (category) result.set(row.sender_key, { category, source: row.source })
  }
  return result
}

/**
 * Store (or replace) the sender's category decision — the upsert task 3.4's
 * "always from sender" action and the backfill/AI writers go through.
 * Creating a row for a sender whose mail has not arrived yet is fine (the
 * next arrival picks it up); re-setting the same sender overwrites
 * category, source and updated_at in one statement.
 */
export async function setSenderCategory(
  executor: SqlExecutor,
  senderEmail: string,
  category: Category,
  source: SenderCategorySource
): Promise<void> {
  const key = senderCategoryKey(senderEmail)
  if (!key) return
  await executor.execute(
    `INSERT INTO sender_categories (sender_key, category, source, updated_at)
     VALUES ($1, $2, $3, (unixepoch()))
     ON CONFLICT(sender_key) DO UPDATE SET
       category = excluded.category,
       source = excluded.source,
       updated_at = excluded.updated_at`,
    [key, category, source]
  )
}
