import type { SqlExecutor } from "../db/executor"

/**
 * Calendar source CRUD (task 5.1, design D5) — the calendar counterpart of
 * db/accounts.ts. One row per connected calendar account (Google today,
 * CalDAV in task 5.2), multiple sources supported, each connectable and
 * removable independently.
 *
 * Secrets live ONLY in the AES-GCM sealed `config_json` envelope (produced
 * by crypto/credentials encryptCredentials — the accounts.credentials_json
 * pattern): for a Google source that is the calendar-scoped OAuth token
 * envelope (see calendar/connect.ts for why the mail account's envelope
 * cannot be reused). Plaintext token values are never persisted and never
 * logged. `sync_state_json` deliberately holds only sync cursors
 * (per-calendar nextSyncToken bookkeeping) — not secrets — so the sync loop
 * can update it without a decrypt/encrypt round-trip.
 */

export type CalendarProvider = "google" | "caldav" | "microsoft"

/** calendar_sources row as stored (snake_case columns). */
export interface CalendarSourceRow {
  id: string
  account_id: string | null
  provider: CalendarProvider
  name: string
  config_json: string
  sync_state_json: string | null
  created_at: number
}

/** Decoded calendar source (camelCase, config kept sealed as ciphertext). */
export interface CalendarSource {
  id: string
  /** The mail account this source was connected from (google, microsoft;
   * null for caldav sources). */
  accountId: string | null
  provider: CalendarProvider
  name: string
  /** The SEALED config envelope ciphertext — only crypto/credentials may
   * open this. */
  configJson: string
  syncState: CalendarSyncState
  createdAt: number
}

/**
 * Per-calendar incremental sync bookkeeping, keyed by provider calendar id.
 * Google: `nextSyncToken` is the events.list delta cursor (must NOT be sent
 * together with timeMin), `lastError` records the previous pass's failure
 * for the UI; it is cleared on the next successful sync.
 */
export type CalendarSyncState = Record<
  string,
  {
    nextSyncToken?: string
    lastSyncAt?: number
    lastError?: string
  }
>

export interface AddCalendarSourceInput {
  id: string
  accountId: string | null
  provider: CalendarProvider
  name: string
  /** SEALED config envelope (encryptCredentials output). */
  configJson: string
}

function toSource(row: CalendarSourceRow): CalendarSource {
  let syncState: CalendarSyncState = {}
  if (row.sync_state_json) {
    try {
      syncState = JSON.parse(row.sync_state_json) as CalendarSyncState
    } catch {
      // A corrupt sync-state blob is bookkeeping, not data — treat as empty
      // (the next sync falls back to a full pass and rewrites it).
      syncState = {}
    }
  }
  return {
    id: row.id,
    accountId: row.account_id,
    provider: row.provider,
    name: row.name,
    configJson: row.config_json,
    syncState,
    createdAt: row.created_at,
  }
}

export async function listCalendarSources(
  executor: SqlExecutor
): Promise<CalendarSource[]> {
  const rows = await executor.select<CalendarSourceRow>(
    "SELECT id, account_id, provider, name, config_json, sync_state_json, created_at FROM calendar_sources ORDER BY created_at ASC, id ASC"
  )
  return rows.map(toSource)
}

export async function listCalendarSourcesForAccount(
  executor: SqlExecutor,
  accountId: string
): Promise<CalendarSource[]> {
  const rows = await executor.select<CalendarSourceRow>(
    "SELECT id, account_id, provider, name, config_json, sync_state_json, created_at FROM calendar_sources WHERE account_id = $1 ORDER BY created_at ASC, id ASC",
    [accountId]
  )
  return rows.map(toSource)
}

export async function getCalendarSource(
  executor: SqlExecutor,
  id: string
): Promise<CalendarSource | null> {
  const rows = await executor.select<CalendarSourceRow>(
    "SELECT id, account_id, provider, name, config_json, sync_state_json, created_at FROM calendar_sources WHERE id = $1",
    [id]
  )
  return rows[0] ? toSource(rows[0]) : null
}

/**
 * Insert a new source. Callers must pass an already-sealed config envelope
 * — this module never builds or logs config contents.
 */
export async function addCalendarSource(
  executor: SqlExecutor,
  input: AddCalendarSourceInput
): Promise<CalendarSourceRow> {
  const row: CalendarSourceRow = {
    id: input.id,
    account_id: input.accountId,
    provider: input.provider,
    name: input.name,
    config_json: input.configJson,
    sync_state_json: null,
    created_at: 0,
  }
  await executor.execute(
    `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.id, input.accountId, input.provider, input.name, input.configJson]
  )
  return row
}

/**
 * Rename a source (the user-visible label only — config untouched).
 */
export async function renameCalendarSource(
  executor: SqlExecutor,
  id: string,
  name: string
): Promise<void> {
  await executor.execute("UPDATE calendar_sources SET name = $1 WHERE id = $2", [
    name,
    id,
  ])
}

/**
 * Remove a calendar source (spec: "Remove a calendar source" — its events
 * are removed and mail access for the account is unaffected).
 *
 * Transaction-ish sequence, documented: the SqlExecutor surface has no
 * explicit transaction API, so the removal runs as two ordered statements —
 * the source's events first, then the source row. A crash in between can
 * only leave a source with zero events (an empty, still-listed source),
 * never orphaned event rows pointing at a missing source. The schema also
 * carries ON DELETE CASCADE on calendar_events.source_id, so even a bare
 * source-row delete cleans up; the explicit delete keeps the invariant
 * visible and lets the reported count cover exactly what this call removed.
 * The mail account (accounts row + its mail) is never touched here.
 */
export async function removeCalendarSource(
  executor: SqlExecutor,
  id: string
): Promise<{ eventsDeleted: number }> {
  const events = await executor.execute(
    "DELETE FROM calendar_events WHERE source_id = $1",
    [id]
  )
  await executor.execute("DELETE FROM calendar_sources WHERE id = $1", [id])
  return { eventsDeleted: events.rowsAffected }
}

/** Read the stored sync state (parsed; {} when absent/corrupt). */
export async function getCalendarSyncState(
  executor: SqlExecutor,
  sourceId: string
): Promise<CalendarSyncState> {
  const rows = await executor.select<{ sync_state_json: string | null }>(
    "SELECT sync_state_json FROM calendar_sources WHERE id = $1",
    [sourceId]
  )
  const raw = rows[0]?.sync_state_json
  if (!raw) return {}
  try {
    return JSON.parse(raw) as CalendarSyncState
  } catch {
    return {}
  }
}

/**
 * Merge one calendar's sync bookkeeping into the source's sync_state_json
 * (read-modify-write; other calendars' entries are preserved). `patch` with
 * undefined/absent fields leaves the stored values untouched; pass explicit
 * nulls to clear (e.g. lastError after a successful pass).
 */
export async function updateCalendarSyncState(
  executor: SqlExecutor,
  sourceId: string,
  calendarId: string,
  patch: {
    nextSyncToken?: string | null
    lastSyncAt?: number | null
    lastError?: string | null
  }
): Promise<void> {
  const state = await getCalendarSyncState(executor, sourceId)
  const entry = { ...state[calendarId] }
  if (patch.nextSyncToken !== undefined) {
    entry.nextSyncToken = patch.nextSyncToken ?? undefined
  }
  if (patch.lastSyncAt !== undefined) {
    entry.lastSyncAt = patch.lastSyncAt ?? undefined
  }
  if (patch.lastError !== undefined) {
    entry.lastError = patch.lastError ?? undefined
  }
  // Strip keys cleared to undefined so a fully-cleared calendar drops out
  // of the map instead of lingering as an empty entry.
  for (const key of Object.keys(entry) as (keyof typeof entry)[]) {
    if (entry[key] === undefined) delete entry[key]
  }
  const next: CalendarSyncState = { ...state }
  if (Object.keys(entry).length === 0) {
    delete next[calendarId]
  } else {
    next[calendarId] = entry
  }
  const json = Object.keys(next).length > 0 ? JSON.stringify(next) : null
  await executor.execute(
    "UPDATE calendar_sources SET sync_state_json = $1 WHERE id = $2",
    [json, sourceId]
  )
}
