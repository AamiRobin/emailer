import { invoke } from "@tauri-apps/api/core"

import { decryptCredentials, encryptCredentials } from "../crypto/credentials"
import type { SqlExecutor } from "../db/executor"
import { parseIcsCalendar, resolveIcsEventEnd, unfoldIcsLines } from "./ics"
import type { IcsEvent } from "./ics"
import type { CalendarEventInput } from "./google-calendar"
import {
  addCalendarSource,
  getCalendarSource,
  getCalendarSyncState,
  updateCalendarSyncState,
} from "./sources"
import type { CalendarSource } from "./sources"

/**
 * CalDAV provider client (task 5.2, design D5) — the TS half of the
 * minimal Rust CalDAV client. The webview cannot open raw TLS sockets and
 * tauri-plugin-http cannot send PROPFIND/REPORT with Basic auth to
 * arbitrary hosts, so CalDAV travels ONLY through the `caldav_*` Rust
 * commands (`src-tauri/src/caldav`): this module is a thin typed wrapper
 * plus the persistence half (mapping REPORT calendar-data into
 * `calendar_events` rows and bookkeeping the sync cursor).
 *
 * Credential flow (the enforced contract): the source's config envelope
 * is SEALED (`encryptCredentials`, AES-256-GCM — the accounts pattern).
 * For every command call this module unseals it and passes the PLAINTEXT
 * username + app password for THAT call — exactly the AI client's
 * per-call API-key contract. Plaintext credentials are never persisted,
 * never logged (nothing here logs arguments), and the Rust side scrubs
 * them from every error message.
 *
 * Sync flow (design D5): sync-token incremental fetch with a full-sync
 * fallback lives Rust-side (`caldav_sync` answers mode "delta" or
 * "full"). The stored cursor lives in `sync_state_json` keyed by the
 * calendar path (NOT the sealed envelope — cursors are not secrets), the
 * same bookkeeping `calendar/sources.ts` provides for Google. On a "full"
 * pass the whole calendar's local rows are replaced (stale rows pruned),
 * which is also how removals are handled on servers that cannot do
 * incremental sync at all.
 *
 * Event mapping: the `ical` column stores the server's calendar-data
 * VERBATIM (a full RFC 5545 VCALENDAR) so every provider shares one
 * uniform iCalendar surface; the row's index fields (start/end/summary/…)
 * are parsed out with the task 5.5 `ics.ts` parser. A delta pass maps the
 * server's removed hrefs to uid candidates (URL-decoded resource file
 * name minus `.ics`) — the documented v1 approximation for servers whose
 * resource names are not the VEVENT UID; those servers converge via full
 * passes (see the design D5 risk note).
 */

/** The unsealed CalDAV source config living inside the sealed envelope. */
export interface CaldavSourceConfig {
  /** The CalDAV server root the user entered (https except loopback). */
  serverUrl: string
  username: string
  appPassword: string
  /** The calendar collections the user kept visible (discovery hrefs). */
  calendarPaths: string[]
}

/** One discovered calendar collection (wire shape: Rust snake_case). */
export interface CaldavDiscoveredCalendar {
  /** Absolute collection URL — stored as the calendar path. */
  href: string
  displayName?: string
  description?: string
  ctag?: string
}

interface CaldavDiscoveredCalendarWire {
  href: string
  display_name?: string
  description?: string
  ctag?: string
}

interface CaldavSyncResponseWire {
  mode: "full" | "delta"
  next_sync_token: string | null
  changed: { href: string; ical: string }[]
  removed: string[]
}

/** The CalDAV command failure kinds (the Rust `CaldavCommandError`). */
export type CaldavErrorKind = "network" | "status" | "parse" | "config"

/**
 * A CalDAV command failure with its specific reason (the spec's
 * connection-test requirement): `status` carries the HTTP status (401/403
 * → auth problem, 3xx → fix the URL — redirects are not followed). The
 * message is the Rust-side, credential-redacted text.
 */
export class CaldavProviderError extends Error {
  readonly kind: CaldavErrorKind
  readonly status?: number

  constructor(kind: CaldavErrorKind, message: string, status?: number) {
    super(message)
    this.name = "CaldavProviderError"
    this.kind = kind
    if (status !== undefined) this.status = status
  }
}

function isCaldavErrorKind(value: string): value is CaldavErrorKind {
  return (
    value === "network" ||
    value === "status" ||
    value === "parse" ||
    value === "config"
  )
}

/** Normalize a `caldav_*` rejection into a `CaldavProviderError`. */
function normalizeCaldavError(thrown: unknown): CaldavProviderError {
  if (thrown instanceof CaldavProviderError) return thrown
  if (typeof thrown === "object" && thrown !== null) {
    const candidate = thrown as Record<string, unknown>
    if (
      typeof candidate.kind === "string" &&
      isCaldavErrorKind(candidate.kind) &&
      typeof candidate.message === "string"
    ) {
      return new CaldavProviderError(
        candidate.kind,
        candidate.message,
        typeof candidate.status === "number" ? candidate.status : undefined
      )
    }
  }
  // An IPC-level failure (non-Tauri runtime, …): transport did not
  // complete.
  return new CaldavProviderError(
    "network",
    thrown instanceof Error ? thrown.message : String(thrown)
  )
}

/** The unsealed-per-call credential triple the commands expect. */
export interface CaldavCallCredentials {
  serverUrl: string
  username: string
  appPassword: string
}

/**
 * Connection test (spec: reports success or a specific failure): resolves
 * on success, throws `CaldavProviderError` with the Rust command's
 * structured reason otherwise.
 */
export async function testCaldavConnection(
  credentials: CaldavCallCredentials
): Promise<void> {
  try {
    await invoke("caldav_test_connection", {
      serverUrl: credentials.serverUrl,
      username: credentials.username,
      appPassword: credentials.appPassword,
    })
  } catch (thrown) {
    throw normalizeCaldavError(thrown)
  }
}

/** Discover the calendars reachable from the server (spec scenario:
 * "the server's calendars are discovered"). */
export async function discoverCaldavCalendars(
  credentials: CaldavCallCredentials
): Promise<CaldavDiscoveredCalendar[]> {
  let response
  try {
    response = await invoke<{ calendars: CaldavDiscoveredCalendarWire[] }>(
      "caldav_discover",
      {
        serverUrl: credentials.serverUrl,
        username: credentials.username,
        appPassword: credentials.appPassword,
      }
    )
  } catch (thrown) {
    throw normalizeCaldavError(thrown)
  }
  return response.calendars.map((calendar) => ({
    href: calendar.href,
    displayName: calendar.display_name,
    description: calendar.description,
    ctag: calendar.ctag,
  }))
}

/** One raw sync pass over one calendar (the `caldav_sync` command). */
export interface CaldavSyncPage {
  /** "delta" (incremental) or "full" (initial/fallback — callers prune). */
  mode: "full" | "delta"
  /** The fresh cursor; null when the server cannot do incremental sync. */
  nextSyncToken: string | null
  changed: { href: string; ical: string }[]
  removed: string[]
}

/** Run one sync pass for a calendar path (a discovery href). */
export async function syncCaldavCalendar(
  credentials: CaldavCallCredentials,
  calendarPath: string,
  syncToken: string | null
): Promise<CaldavSyncPage> {
  let response: CaldavSyncResponseWire
  try {
    response = await invoke<CaldavSyncResponseWire>("caldav_sync", {
      serverUrl: credentials.serverUrl,
      username: credentials.username,
      appPassword: credentials.appPassword,
      calendarPath,
      syncToken: syncToken ?? null,
    })
  } catch (thrown) {
    throw normalizeCaldavError(thrown)
  }
  return {
    mode: response.mode,
    nextSyncToken: response.next_sync_token,
    changed: response.changed,
    removed: response.removed,
  }
}

// ---------------------------------------------------------------------------
// Event writes (task 5.4, design D5) — online-write contract
// ---------------------------------------------------------------------------

/**
 * The event-resource href for one uid on a collection (RFC 4791 §5.3.2):
 * `{calendar href}{uid}.ics`. The uid is percent-encoded for the path —
 * `removedHrefToUid` (above) decodes on the way back, so round-trips via
 * sync keep the stored uid stable. Resource-name ≙ uid is the same
 * documented v1 approximation the sync module makes for servers that name
 * resources differently (those converge via full passes).
 */
export function caldavEventResourcePath(
  calendarPath: string,
  uid: string
): string {
  const base = calendarPath.endsWith("/") ? calendarPath : `${calendarPath}/`
  return `${base}${encodeURIComponent(uid)}.ics`
}

/**
 * Create or replace one event resource (task 5.4): PUT the built .ics
 * blob through the `caldav_put_event` command. Resolves on 2xx, throws
 * `CaldavProviderError` otherwise.
 */
export async function putCaldavEvent(
  credentials: CaldavCallCredentials,
  resourcePath: string,
  ical: string
): Promise<void> {
  try {
    await invoke("caldav_put_event", {
      serverUrl: credentials.serverUrl,
      username: credentials.username,
      appPassword: credentials.appPassword,
      resourcePath,
      ical,
    })
  } catch (thrown) {
    throw normalizeCaldavError(thrown)
  }
}

/**
 * Delete one event resource (task 5.4) through `caldav_delete_event`.
 * A 404 is tolerated as already-deleted (the local row may go); other
 * failures throw `CaldavProviderError`.
 */
export async function deleteCaldavEvent(
  credentials: CaldavCallCredentials,
  resourcePath: string
): Promise<void> {
  try {
    await invoke("caldav_delete_event", {
      serverUrl: credentials.serverUrl,
      username: credentials.username,
      appPassword: credentials.appPassword,
      resourcePath,
    })
  } catch (thrown) {
    const error = normalizeCaldavError(thrown)
    if (error.kind === "status" && error.status === 404) {
      return // already gone server-side — deletion is idempotent
    }
    throw error
  }
}

/** Unseal a CalDAV source's config envelope for one write call; null when
 * the envelope is missing, unreadable, or carries no usable connection. */
export async function unsealCaldavConfig(
  source: CalendarSource
): Promise<CaldavSourceConfig | null> {
  try {
    const envelope = await decryptCredentials<CaldavSourceConfig>(
      source.configJson
    )
    if (
      envelope?.serverUrl &&
      envelope.username &&
      envelope.appPassword &&
      Array.isArray(envelope.calendarPaths)
    ) {
      return envelope
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export interface ConnectCaldavSourceInput {
  serverUrl: string
  username: string
  appPassword: string
  /**
   * The discovered calendars the user kept VISIBLE (spec: discovery lets
   * the user choose which are shown). Paths become the sync keys.
   */
  calendars: CaldavDiscoveredCalendar[]
  /** Overrides the source's display name (default: the username). */
  name?: string
}

/**
 * Persist a new CalDAV source: the connection details are SEALED into the
 * config envelope (encryptCredentials — sealing point; plaintext
 * credentials exist only in memory before this call and only as
 * ciphertext afterwards) and the selected calendar paths ride inside the
 * envelope (they sit next to the credentials they authenticate). Nothing
 * is persisted before the caller has tested/discovered — the UI drives
 * that order.
 */
export async function connectCaldavSource(
  executor: SqlExecutor,
  input: ConnectCaldavSourceInput
): Promise<CalendarSource> {
  const config: CaldavSourceConfig = {
    serverUrl: input.serverUrl,
    username: input.username,
    appPassword: input.appPassword,
    calendarPaths: input.calendars.map((calendar) => calendar.href),
  }
  const configJson = await encryptCredentials(config)
  const id = crypto.randomUUID()
  await addCalendarSource(executor, {
    id,
    // CalDAV sources have no linked mail account (the v11 schema note).
    accountId: null,
    provider: "caldav",
    name: input.name ?? input.username,
    configJson,
  })
  const source = await getCalendarSource(executor, id)
  if (!source) {
    // addCalendarSource inserting then the row being unreadable cannot
    // happen short of a storage failure — fail loudly rather than return
    // a half-formed source.
    throw new Error("the connected CalDAV source could not be reloaded")
  }
  return source
}

// ---------------------------------------------------------------------------
// Sync: calendar-data → calendar_events rows
// ---------------------------------------------------------------------------

/** unix epoch seconds from a Date. */
function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

/**
 * The uid a removed resource href maps to: URL-decoded last path segment
 * with a trailing `.ics` stripped (how Radicale/Nextcloud name event
 * resources). A heuristic by necessity — an incremental 404 carries only
 * the href, not the uid; servers that name resources differently
 * converge via the full-pass pruning (module comment).
 */
export function removedHrefToUid(href: string): string {
  const withoutQuery = href.split(/[?#]/)[0]
  const segments = withoutQuery.split("/").filter((segment) => segment !== "")
  const last = segments[segments.length - 1] ?? href
  let decoded = last
  try {
    decoded = decodeURIComponent(last)
  } catch {
    // Malformed escape: the raw segment is still the best candidate.
  }
  return decoded.replace(/\.ics$/i, "")
}

/**
 * The raw recurrence rules of the VEVENTs in an ical blob ("RRULE:…",
 * "EXDATE:…") — the same array-JSON shape the Google provider stores.
 * `ics.ts` skips RRULE by design; the lines are cheap to re-extract here.
 */
export function extractRecurrenceRules(ical: string): string[] {
  const rules: string[] = []
  for (const line of unfoldIcsLines(ical)) {
    // Quote-aware colon split is unnecessary for RRULE/EXDATE (no
    // colons in names/params); a name check on the raw line suffices.
    const match = /^(RRULE|EXDATE)([;:])/i.exec(line)
    if (match) {
      rules.push(`${match[1].toUpperCase()}:${line.slice(match[0].length)}`)
    }
  }
  return rules
}

/**
 * Map the VEVENTs of one calendar-data blob into upsert inputs. The blob
 * is stored verbatim per row (usually one VEVENT per resource; a
 * multi-VEVENT resource indexes each event against the same blob).
 * Returns null when the blob is not parseable iCalendar or carries no
 * usable VEVENT — counted as a parse failure by the sync loop, never a
 * throw (one malformed resource must not sink the calendar).
 */
export function mapCaldavCalendarData(
  sourceId: string,
  calendarId: string,
  href: string,
  ical: string
): CalendarEventInput[] | null {
  const parsed = parseIcsCalendar(ical)
  if (!parsed.ok) return null

  const inputs: CalendarEventInput[] = []
  for (const event of parsed.calendar.events) {
    const mapped = mapIcsEvent(sourceId, calendarId, href, event, ical)
    if (mapped) inputs.push(mapped)
  }
  return inputs.length > 0 ? inputs : null
}

/** Map one parsed VEVENT into a row input; null when it cannot be placed
 * (no UID and no derivable one, or no parseable start time). CANCELLED
 * events keep their rows (status-filtered at view time, like Google's
 * cancelled masters). */
function mapIcsEvent(
  sourceId: string,
  calendarId: string,
  href: string,
  event: IcsEvent,
  ical: string
): CalendarEventInput | null {
  const uid = event.uid?.trim() || removedHrefToUid(href)
  if (!uid) return null
  if (!event.start?.date) return null

  const startAt = seconds(event.start.date)
  const allDay = event.start.allDay
  const end = resolveIcsEventEnd(event)?.date
  // Missing DTEND/DURATION: an all-day DATE spans its day (exclusive end,
  // the Google `date` convention); a timed event is zero-length.
  const endAt = end ? seconds(end) : allDay ? startAt + 86_400 : startAt

  const rules = extractRecurrenceRules(ical)
  return {
    id: `ce-${sourceId}:${calendarId}:${uid}`,
    sourceId,
    calendarId,
    uid,
    ical,
    summary: event.summary ?? undefined,
    location: event.location ?? undefined,
    description: event.description ?? undefined,
    startAt,
    endAt,
    allDay,
    recurrence: rules.length > 0 ? JSON.stringify(rules) : undefined,
    status: event.status ? event.status.toLowerCase() : undefined,
  }
}

/**
 * Upsert mapped events for one calendar (server-wins: mutable fields are
 * overwritten, id/created_at stay). Same select-then-insert-or-update
 * pattern as the Google provider's upsert (positional placeholders must
 * ascend by first occurrence, so ON CONFLICT is avoided). Exported for the
 * task-5.4 write path, which reuses it to cache its own freshly written
 * events (the local row lands ONLY after the server write succeeded —
 * online-write semantics).
 */
export async function upsertEvents(
  executor: SqlExecutor,
  inputs: CalendarEventInput[]
): Promise<number> {
  let stored = 0
  for (const input of inputs) {
    const existing = await executor.select<{ id: string }>(
      "SELECT id FROM calendar_events WHERE source_id = $1 AND calendar_id = $2 AND uid = $3",
      [input.sourceId, input.calendarId, input.uid]
    )
    if (existing.length > 0) {
      await executor.execute(
        `UPDATE calendar_events SET
           ical = $1, summary = $2, location = $3, description = $4,
           start_at = $5, end_at = $6, all_day = $7, recurrence = $8,
           status = $9
         WHERE id = $10`,
        [
          input.ical,
          input.summary ?? null,
          input.location ?? null,
          input.description ?? null,
          input.startAt,
          input.endAt,
          input.allDay ? 1 : 0,
          input.recurrence ?? null,
          input.status ?? null,
          input.id,
        ]
      )
    } else {
      await executor.execute(
        `INSERT INTO calendar_events (
           id, source_id, calendar_id, uid, ical, summary, location,
           description, start_at, end_at, all_day, recurrence, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          input.id,
          input.sourceId,
          input.calendarId,
          input.uid,
          input.ical,
          input.summary ?? null,
          input.location ?? null,
          input.description ?? null,
          input.startAt,
          input.endAt,
          input.allDay ? 1 : 0,
          input.recurrence ?? null,
          input.status ?? null,
        ]
      )
    }
    stored += 1
  }
  return stored
}

/**
 * Delete the calendar's local rows whose uid is NOT in `keepUids` — the
 * full-pass replacement of the calendar's row set (how removals are
 * applied on "full" passes). Returns the number of rows removed.
 */
async function pruneStaleEvents(
  executor: SqlExecutor,
  sourceId: string,
  calendarId: string,
  keepUids: string[]
): Promise<number> {
  const keep = new Set(keepUids)
  const existing = await executor.select<{ uid: string }>(
    "SELECT uid FROM calendar_events WHERE source_id = $1 AND calendar_id = $2",
    [sourceId, calendarId]
  )
  let removed = 0
  for (const row of existing) {
    if (keep.has(row.uid)) continue
    removed += await executor.execute(
      "DELETE FROM calendar_events WHERE source_id = $1 AND calendar_id = $2 AND uid = $3",
      [sourceId, calendarId, row.uid]
    ).then((result) => result.rowsAffected)
  }
  return removed
}

/** One calendar's sync bookkeeping for the result. */
export interface CaldavCalendarSyncResult {
  calendarPath: string
  mode: "full" | "delta"
  stored: number
  removed: number
  /** calendar-data blobs that were not parseable iCalendar (skipped). */
  parseFailures: number
  /** The per-calendar failure, if this calendar's pass failed. */
  error?: string
}

export interface SyncCaldavSourceResult {
  /** Per selected calendar, in config order. */
  calendars: CaldavCalendarSyncResult[]
}

/**
 * Sync every selected calendar of a stored CalDAV source (task 5.2):
 * unseals the envelope (the per-call credential contract — module
 * comment), runs one `caldav_sync` pass per calendar with the stored
 * cursor, maps the returned calendar-data into `calendar_events`, applies
 * removals (uid candidates on delta, pruning on full), and persists the
 * fresh cursor + lastSyncAt (or the failure) per calendar via
 * `updateCalendarSyncState`. Per-calendar failures are RECORDED (the
 * per-source error surface) and returned — they do not throw, so one
 * broken calendar cannot block the others.
 */
export async function syncCaldavSource(
  executor: SqlExecutor,
  source: CalendarSource
): Promise<SyncCaldavSourceResult> {
  let envelope: CaldavSourceConfig | null
  try {
    envelope = await decryptCredentials<CaldavSourceConfig>(source.configJson)
  } catch {
    // An undecryptable envelope is a missing connection, not a sync
    // failure — the source needs re-connecting.
    envelope = null
  }
  if (
    !envelope?.serverUrl ||
    !envelope.username ||
    !envelope.appPassword ||
    !Array.isArray(envelope.calendarPaths)
  ) {
    throw new Error(
      "No stored CalDAV connection details for this source; re-connect it"
    )
  }
  const credentials: CaldavCallCredentials = {
    serverUrl: envelope.serverUrl,
    username: envelope.username,
    appPassword: envelope.appPassword,
  }

  const results: CaldavCalendarSyncResult[] = []
  for (const calendarPath of envelope.calendarPaths) {
    const base: CaldavCalendarSyncResult = {
      calendarPath,
      mode: "full",
      stored: 0,
      removed: 0,
      parseFailures: 0,
    }
    try {
      const storedToken =
        (await getStoredSyncToken(executor, source.id, calendarPath)) ?? null
      const page = await syncCaldavCalendar(
        credentials,
        calendarPath,
        storedToken
      )
      base.mode = page.mode

      const keepUids: string[] = []
      for (const change of page.changed) {
        const inputs = mapCaldavCalendarData(
          source.id,
          calendarPath,
          change.href,
          change.ical
        )
        if (inputs === null) {
          base.parseFailures += 1
          continue
        }
        base.stored += await upsertEvents(executor, inputs)
        for (const input of inputs) keepUids.push(input.uid)
      }

      if (page.mode === "full") {
        // Full pass: the changed set IS the calendar's contents — prune
        // everything not in it (also the tombstone path for query-only
        // servers, which have no removal reporting).
        base.removed += await pruneStaleEvents(
          executor,
          source.id,
          calendarPath,
          keepUids
        )
      } else {
        // Delta pass: the server named its removals; map each href to its
        // uid candidate (module comment on the approximation).
        for (const href of page.removed) {
          const uid = removedHrefToUid(href)
          base.removed += await executor.execute(
            "DELETE FROM calendar_events WHERE source_id = $1 AND calendar_id = $2 AND uid = $3",
            [source.id, calendarPath, uid]
          ).then((result) => result.rowsAffected)
        }
      }

      await updateStoredSyncToken(executor, source.id, calendarPath, {
        nextSyncToken: page.nextSyncToken,
        lastError: null,
      })
    } catch (error) {
      // The per-source error surface: record the specific failure on the
      // calendar's sync state and keep syncing the other calendars.
      base.error =
        error instanceof Error ? error.message : String(error)
      await updateStoredSyncToken(executor, source.id, calendarPath, {
        lastError: base.error,
      })
    }
    results.push(base)
  }
  return { calendars: results }
}

/** The calendar's stored incremental cursor (undefined when absent/empty
 * — an empty cursor would make `caldav_sync` full-sync anyway). */
async function getStoredSyncToken(
  executor: SqlExecutor,
  sourceId: string,
  calendarPath: string
): Promise<string | undefined> {
  const token = (await getCalendarSyncState(executor, sourceId))[
    calendarPath
  ]?.nextSyncToken
  return token && token.length > 0 ? token : undefined
}

/** Merge the cursor/lastError patch into the source's sync state. */
async function updateStoredSyncToken(
  executor: SqlExecutor,
  sourceId: string,
  calendarPath: string,
  patch: { nextSyncToken?: string | null; lastError?: string | null }
): Promise<void> {
  await updateCalendarSyncState(executor, sourceId, calendarPath, {
    ...patch,
    lastSyncAt: patch.lastError ? undefined : Math.floor(Date.now() / 1000),
  })
}
