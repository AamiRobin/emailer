import { SHORTCUTS, type ShortcutId } from "@/constants/shortcuts"
import { ACCENTS, applyAccent, DEFAULT_ACCENT_ID } from "@/lib/accent"
import type { SqlExecutor } from "@/services/db/executor"
import { getSetting, setSetting } from "@/services/db/settings"
import { decryptCredentials, encryptCredentials } from "@/services/crypto/credentials"
import type { ThreadSortOption } from "@/services/db/thread-sort"
import { isThreadSortOption } from "@/services/db/thread-sort"
import type { ReadingPanePosition } from "@/stores/ui-store"
import { useUiStore } from "@/stores/ui-store"
import {
  clampSendDelaySeconds,
  DEFAULT_SEND_DELAY_SECONDS,
} from "@/services/composer/undo-send"

/**
 * User preferences (tasks 11.2/11.3): typed accessors over the generic
 * settings module (src/services/db/settings) for everything the settings
 * page edits, plus applyBootPreferences() — the single boot hook that
 * re-applies the persisted choices (called from the mail shell's mount
 * effect, which only runs after bootstrap() has the database ready).
 *
 * Persistence model per preference — what lives where and why:
 *
 * - density, font scale, reading pane: the settings table is the ONLY
 *   store. They are applied post-mount (CSS variables / ui-store), so no
 *   pre-paint bootstrap is needed; applyBootPreferences() applies them at
 *   boot (reading pane feeds ui-store.setReadingPane, the same API the
 *   pane switcher uses).
 * - accent: `src/lib/accent.ts` keeps localStorage as the pre-mount
 *   bootstrap (initAccent() in main.tsx must tint the first paint before
 *   React exists). applyAccent() stays the live-apply path and writes
 *   localStorage; setAccentPreference() additionally mirrors the id into
 *   the settings table. applyBootPreferences() re-applies the mirrored id
 *   ONLY when a row exists — a fresh database (or an accent the user never
 *   touched) must never clobber the localStorage choice initAccent()
 *   already applied.
 * - theme mode: next-themes owns persistence (localStorage key "theme")
 *   for the same pre-mount reason and re-applies it before React mounts;
 *   setThemeModePreference() only mirrors the mode into the settings table
 *   for visibility. The mirror is never read at boot.
 * - notifications: the settings table via the new-mail notifier's
 *   setNotificationsEnabled (persist + in-memory cache invalidation);
 *   reading goes through db/settings getNotificationsEnabled. The 30s TTL
 *   cache is the notifier's concern — this module stays cache-free.
 */

/** Settings-table keys owned by this module (new keys beyond the ones
 * SETTINGS_KEYS in db/settings ships with — kept here because the generic
 * settings module must stay feature-agnostic). */
const PREFERENCE_KEYS = {
  density: "appearance.density",
  fontScale: "appearance.fontScale",
  readingPane: "mail.readingPane",
  accentId: "appearance.accentId",
  themeMode: "appearance.themeMode",
  /** Per-account undo-send window base; the accountId is appended as
   * `:<accountId>` (sendDelaySettingKey), the same namespacing
   * signatures.ts uses for `signature:<accountId>`. */
  sendDelaySeconds: "mail.sendDelaySeconds",
  /** Per-account send-guard suppression flags (task 5.3): one boolean
   * each for the forgotten-attachment reminder and the empty-subject
   * confirmation — `mail.attachmentGuardSuppressed:<accountId>` /
   * `mail.emptySubjectGuardSuppressed:<accountId>`, the same namespacing
   * sendDelaySettingKey uses. The "Don't ask again" checkbox on each
   * guard prompt writes one; the composer reads them per Send click. */
  attachmentGuardSuppressed: "mail.attachmentGuardSuppressed",
  emptySubjectGuardSuppressed: "mail.emptySubjectGuardSuppressed",
  /** Per-scope thread-list sort map (task 4.1): one JSON object
   * `Record<scopeKey, ThreadSortOption>` under a single key — the scope
   * keys themselves are derived in thread-list-store
   * (threadSortScopeKey): `special:<role>`, `label:<labelId>`, `search`. */
  threadSorts: "mail.threadSorts",
  /** Group-by-sender bundles (task 9.4): one GLOBAL boolean — the
   * simplest workable scheme, deliberately not per-scope like the sorts:
   * the grouping is a client-side view over whatever list is loaded, and
   * one flag keeps the toggle (and its read at list mount) trivial. */
  groupBySender: "mail.groupBySender",
  /** Nudges age threshold (task 14.1, design D8): how many days an
   * unanswered thread must sit before it becomes a nudge. One GLOBAL
   * number — the spec's "configurable threshold" is a single dial, and the
   * detection query is uniform across accounts. */
  nudgeDays: "mail.nudgeDays",
  /** Follow-up reminder interval (task 14.2, design D8): how many days
   * after an accepted reply-send the reminder resurfaces the thread if no
   * reply arrived. One GLOBAL number, like the nudge threshold. */
  followUpDays: "mail.followUpDays",
  /** Per-account IMAP drafts-folder override (task 17.2, design D9):
   * `mail.imapDraftsFolder:<accountId>` (imapDraftsFolderSettingKey), the
   * same namespacing signatures.ts uses. Escapes the folder auto-mapping
   * when a server's Drafts detection fails. */
  imapDraftsFolder: "mail.imapDraftsFolder",
  /** Keyboard-shortcut overrides (task 20.1, design D15): one JSON object
   * `Record<ShortcutId, keys>` under a single key — the same one-row shape
   * as mail.threadSorts. Values are display strings in the exact format
   * the default table uses (src/constants/shortcuts.ts); merging with the
   * defaults happens at read time in hooks/shortcut-bindings.ts. */
  shortcutOverrides: "mail.shortcutOverrides",
  /** Per-account OpenPGP opt-in (task 18.7, design D11):
   * `mail.pgpEnabled:<accountId>` (pgpEnabledSettingKey), the same
   * namespacing sendDelaySettingKey uses. The encryption settings section
   * is the writer; the key rows themselves live under
   * `mail.pgp.{private,public}Keys:<accountId>` (crypto/pgp-keys.ts). */
  pgpEnabled: "mail.pgpEnabled",
  /** Global malware hash-lookup opt-in (task 18.9, design D18): one
   * boolean + one API key, deliberately GLOBAL (not per account like the
   * PGP flag) — the lookup is content-addressed (SHA-256), so the verdict
   * cache is already shared across accounts and a per-account switch
   * would only make the gating inconsistent. The attachment-security
   * settings section is the writer; the open path (malware-lookup.ts)
   * reads both before an attachment's first open. */
  malwareLookupEnabled: "mail.malwareLookupEnabled",
  malwareLookupApiKey: "mail.malwareLookupApiKey",
  /** Per-account local junk filter (task 18.10, design D19):
   * `mail.junkFilterEnabled:<accountId>` (junkFilterEnabledSettingKey),
   * the same namespacing sendDelaySettingKey uses. IMAP-only (Gmail is
   * exempt — server-side filtering already exists); off by default, so
   * failing toward the default is failing toward no auto-junking. The
   * junk-filter settings section is the writer; the sync engines and the
   * thread-actions training hooks read it. */
  junkFilterEnabled: "mail.junkFilterEnabled",
} as const

/** Theme mode as next-themes models it (theme-provider passes it to
 * setTheme; "system" follows the OS setting live). */
export type ThemeMode = "light" | "dark" | "system"

export type DensityPreset = "compact" | "default" | "relaxed"

/** List-row density presets → the --density token value (see index.css:
 * --density-row derives from it, so this is a pure token swap). */
export const DENSITY_PRESETS: ReadonlyArray<{
  id: DensityPreset
  label: string
  value: number
}> = [
  { id: "compact", label: "Compact", value: 0.85 },
  { id: "default", label: "Default", value: 1 },
  { id: "relaxed", label: "Relaxed", value: 1.25 },
]

/** Global font-scale steps for the --font-scale token (index.css
 * multiplies the 16px root font by it). */
export const FONT_SCALES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0.9, label: "90%" },
  { value: 1, label: "100%" },
  { value: 1.1, label: "110%" },
  { value: 1.25, label: "125%" },
]

const READING_PANE_POSITIONS: readonly ReadingPanePosition[] = [
  "right",
  "bottom",
  "hidden",
]

const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"]

function isDensityPreset(value: unknown): value is DensityPreset {
  return DENSITY_PRESETS.some((preset) => preset.id === value)
}

function isFontScale(value: unknown): value is number {
  return FONT_SCALES.some((scale) => scale.value === value)
}

// ---------------------------------------------------------------------------
// Live application (document root tokens)
// ---------------------------------------------------------------------------

/** Apply a density preset to the --density token on <html> (live). */
export function applyDensity(preset: DensityPreset): void {
  const found =
    DENSITY_PRESETS.find((entry) => entry.id === preset) ?? DENSITY_PRESETS[1]
  document.documentElement.style.setProperty("--density", String(found.value))
}

/** Apply a font scale to the --font-scale token on <html> (live). Unknown
 * scales are ignored (the token keeps its current value). */
export function applyFontScale(scale: number): void {
  if (!isFontScale(scale)) return
  document.documentElement.style.setProperty("--font-scale", String(scale))
}

// ---------------------------------------------------------------------------
// Density
// ---------------------------------------------------------------------------

export async function getDensity(
  executor: SqlExecutor
): Promise<DensityPreset> {
  const stored = await getSetting<unknown>(
    executor,
    PREFERENCE_KEYS.density,
    "default"
  )
  return isDensityPreset(stored) ? stored : "default"
}

/** Persist the density preset and apply it live (--density token). */
export async function setDensityPreference(
  executor: SqlExecutor,
  preset: DensityPreset
): Promise<void> {
  await setSetting(executor, PREFERENCE_KEYS.density, preset)
  applyDensity(preset)
}

// ---------------------------------------------------------------------------
// Font scale
// ---------------------------------------------------------------------------

export async function getFontScale(executor: SqlExecutor): Promise<number> {
  const stored = await getSetting<unknown>(
    executor,
    PREFERENCE_KEYS.fontScale,
    1
  )
  return isFontScale(stored) ? stored : 1
}

/** Persist the font scale and apply it live (--font-scale token). */
export async function setFontScalePreference(
  executor: SqlExecutor,
  scale: number
): Promise<void> {
  if (!isFontScale(scale)) return
  await setSetting(executor, PREFERENCE_KEYS.fontScale, scale)
  applyFontScale(scale)
}

// ---------------------------------------------------------------------------
// Reading pane position
// ---------------------------------------------------------------------------

export async function getReadingPanePreference(
  executor: SqlExecutor
): Promise<ReadingPanePosition> {
  const stored = await getSetting<unknown>(
    executor,
    PREFERENCE_KEYS.readingPane,
    "right"
  )
  return READING_PANE_POSITIONS.includes(stored as ReadingPanePosition)
    ? (stored as ReadingPanePosition)
    : "right"
}

/**
 * Persist the default reading-pane position and push it into the ui-store
 * via its regular setReadingPane API, so the shell re-lays out live — the
 * same path the pane switcher buttons use. This replaces the ui-store's
 * interim localStorage persistence (task 6.5) with the settings table.
 */
export async function setReadingPanePreference(
  executor: SqlExecutor,
  position: ReadingPanePosition
): Promise<void> {
  await setSetting(executor, PREFERENCE_KEYS.readingPane, position)
  useUiStore.getState().setReadingPane(position)
}

// ---------------------------------------------------------------------------
// Accent (settings-table mirror; localStorage stays the boot source)
// ---------------------------------------------------------------------------

export async function getAccentPreference(
  executor: SqlExecutor
): Promise<string> {
  const stored = await getSetting<unknown>(
    executor,
    PREFERENCE_KEYS.accentId,
    DEFAULT_ACCENT_ID
  )
  return ACCENTS.some((accent) => accent.id === stored)
    ? (stored as string)
    : DEFAULT_ACCENT_ID
}

/**
 * Mirror the accent choice into the settings table. The live application
 * and localStorage write stay in applyAccent() (src/lib/accent.ts) — the
 * UI calls both: applyAccent(id) then this.
 */
export async function setAccentPreference(
  executor: SqlExecutor,
  accentId: string
): Promise<void> {
  await setSetting(executor, PREFERENCE_KEYS.accentId, accentId)
}

// ---------------------------------------------------------------------------
// Theme mode (settings-table mirror; next-themes owns the real persistence)
// ---------------------------------------------------------------------------

export async function getThemeModePreference(
  executor: SqlExecutor
): Promise<ThemeMode> {
  const stored = await getSetting<unknown>(
    executor,
    PREFERENCE_KEYS.themeMode,
    "system"
  )
  return THEME_MODES.includes(stored as ThemeMode)
    ? (stored as ThemeMode)
    : "system"
}

/** Mirror-only: next-themes persists the mode (localStorage "theme") and
 * bootstraps it pre-mount; the settings row is for visibility. */
export async function setThemeModePreference(
  executor: SqlExecutor,
  mode: ThemeMode
): Promise<void> {
  await setSetting(executor, PREFERENCE_KEYS.themeMode, mode)
}

// ---------------------------------------------------------------------------
// Per-account undo-send delay (design D3, task 5.1)
// ---------------------------------------------------------------------------

/** Settings key holding one account's undo-send window length (a plain
 * JSON number of seconds). The settings-UI control is a later task —
 * until it ships, this accessor pair is the only way the value is written
 * or read. */
export function sendDelaySettingKey(accountId: string): string {
  return `${PREFERENCE_KEYS.sendDelaySeconds}:${accountId}`
}

/**
 * The account's undo-send window in seconds: default 10 when unset or
 * corrupt, values clamped to 5–30, and a stored 0 kept as the explicit
 * "send immediately" opt-out (the clamp owns those rules — undo-send.ts).
 */
export async function getSendDelaySeconds(
  executor: SqlExecutor,
  accountId: string
): Promise<number> {
  const stored = await getSetting<unknown>(
    executor,
    sendDelaySettingKey(accountId),
    DEFAULT_SEND_DELAY_SECONDS
  )
  return clampSendDelaySeconds(stored)
}

/** Persist the account's undo-send window (clamped on write). */
export async function setSendDelaySecondsPreference(
  executor: SqlExecutor,
  accountId: string,
  seconds: number
): Promise<void> {
  await setSetting(
    executor,
    sendDelaySettingKey(accountId),
    clampSendDelaySeconds(seconds)
  )
}

// ---------------------------------------------------------------------------
// Per-account send-guard suppression (task 5.3)
// ---------------------------------------------------------------------------

/** Settings key holding one account's "Don't ask again" flag for a send
 * guard (a plain JSON boolean) — attachmentGuardSettingKey for the
 * forgotten-attachment reminder, emptySubjectGuardSettingKey for the
 * empty-subject confirmation. */
function guardSuppressedSettingKey(prefix: string, accountId: string): string {
  return `${prefix}:${accountId}`
}

export function attachmentGuardSettingKey(accountId: string): string {
  return guardSuppressedSettingKey(
    PREFERENCE_KEYS.attachmentGuardSuppressed,
    accountId
  )
}

export function emptySubjectGuardSettingKey(accountId: string): string {
  return guardSuppressedSettingKey(
    PREFERENCE_KEYS.emptySubjectGuardSuppressed,
    accountId
  )
}

/**
 * The account's suppression flag for the forgotten-attachment reminder
 * (the guard prompt's checkbox): stored JSON `true` means suppressed;
 * unset or corrupt rows read as active — fail toward asking.
 */
export async function getAttachmentGuardSuppressed(
  executor: SqlExecutor,
  accountId: string
): Promise<boolean> {
  const stored = await getSetting<unknown>(
    executor,
    attachmentGuardSettingKey(accountId),
    false
  )
  return stored === true
}

/** Persist the account's forgotten-attachment suppression flag. */
export async function setAttachmentGuardSuppressedPreference(
  executor: SqlExecutor,
  accountId: string,
  suppressed: boolean
): Promise<void> {
  await setSetting(executor, attachmentGuardSettingKey(accountId), suppressed)
}

/** Same accessor for the empty-subject confirmation's suppression flag. */
export async function getEmptySubjectGuardSuppressed(
  executor: SqlExecutor,
  accountId: string
): Promise<boolean> {
  const stored = await getSetting<unknown>(
    executor,
    emptySubjectGuardSettingKey(accountId),
    false
  )
  return stored === true
}

/** Persist the account's empty-subject suppression flag. */
export async function setEmptySubjectGuardSuppressedPreference(
  executor: SqlExecutor,
  accountId: string,
  suppressed: boolean
): Promise<void> {
  await setSetting(executor, emptySubjectGuardSettingKey(accountId), suppressed)
}

// ---------------------------------------------------------------------------
// Per-scope thread-list sorts (task 4.1)
// ---------------------------------------------------------------------------

/**
 * The per-scope thread-list sort map (`mail.threadSorts`): a single JSON
 * object `Record<scopeKey, ThreadSortOption>` — one settings row, one
 * write per sort change, however many views the user has customized.
 * Unknown scope keys and invalid options (a shape from an older build or
 * a hand-edited row) are dropped on read; a scope with no entry falls back
 * to date_desc at the call site.
 */
export async function getThreadSorts(
  executor: SqlExecutor
): Promise<Record<string, ThreadSortOption>> {
  const stored = await getSetting<unknown>(
    executor,
    PREFERENCE_KEYS.threadSorts,
    {}
  )
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(stored as Record<string, unknown>).filter(
      (entry): entry is [string, ThreadSortOption] =>
        isThreadSortOption(entry[1])
    )
  )
}

/** Persist the whole per-scope sort map (the caller owns merging). */
export async function setThreadSorts(
  executor: SqlExecutor,
  sorts: Record<string, ThreadSortOption>
): Promise<void> {
  await setSetting(executor, PREFERENCE_KEYS.threadSorts, sorts)
}

// ---------------------------------------------------------------------------
// Group-by-sender bundles (task 9.4)
// ---------------------------------------------------------------------------

/** The global "Group by sender" toggle: default off; anything but a
 * stored JSON `true` reads as off (corrupt rows included). */
export async function getGroupBySenderPreference(
  executor: SqlExecutor
): Promise<boolean> {
  const stored = await getSetting<unknown>(
    executor,
    PREFERENCE_KEYS.groupBySender,
    false
  )
  return stored === true
}

/** Persist the "Group by sender" toggle. */
export async function setGroupBySenderPreference(
  executor: SqlExecutor,
  enabled: boolean
): Promise<void> {
  await setSetting(executor, PREFERENCE_KEYS.groupBySender, enabled)
}

// ---------------------------------------------------------------------------
// Nudges + follow-up reminder thresholds (tasks 14.1/14.2, design D8)
// ---------------------------------------------------------------------------

/** Default age (days) before an unanswered thread becomes a nudge. The
 * spec fixes no default — its "forgotten question" scenario runs at two
 * days as a configured instance; 3 matches the follow-up interval and
 * keeps routine threads out of the view. */
export const DEFAULT_NUDGE_DAYS = 3

/** Default follow-up reminder interval (days) attached at send time —
 * the spec scenario's "3-day follow-up reminder". */
export const DEFAULT_FOLLOW_UP_DAYS = 3

const MIN_THRESHOLD_DAYS = 1
const MAX_THRESHOLD_DAYS = 30

function clampThresholdDays(days: number, fallback: number): number {
  if (!Number.isFinite(days)) return fallback
  return Math.min(
    MAX_THRESHOLD_DAYS,
    Math.max(MIN_THRESHOLD_DAYS, Math.floor(days))
  )
}

/**
 * The nudges age threshold (`mail.nudgeDays`): default 3 when unset,
 * clamped 1–30, corrupt rows read as the default. The settings-UI control
 * is a later consumer — until it ships, this accessor pair is the only way
 * the value is written or read.
 */
export async function getNudgeDays(executor: SqlExecutor): Promise<number> {
  const stored = await getSetting<unknown>(
    executor,
    PREFERENCE_KEYS.nudgeDays,
    DEFAULT_NUDGE_DAYS
  )
  return typeof stored === "number"
    ? clampThresholdDays(stored, DEFAULT_NUDGE_DAYS)
    : DEFAULT_NUDGE_DAYS
}

/** Persist the nudges age threshold (clamped on write). */
export async function setNudgeDaysPreference(
  executor: SqlExecutor,
  days: number
): Promise<void> {
  await setSetting(
    executor,
    PREFERENCE_KEYS.nudgeDays,
    clampThresholdDays(days, DEFAULT_NUDGE_DAYS)
  )
}

/**
 * The follow-up reminder interval (`mail.followUpDays`): default 3 when
 * unset, clamped 1–30, corrupt rows read as the default. No settings-UI
 * control yet — accessor pair only, like the nudge threshold.
 */
export async function getFollowUpDays(executor: SqlExecutor): Promise<number> {
  const stored = await getSetting<unknown>(
    executor,
    PREFERENCE_KEYS.followUpDays,
    DEFAULT_FOLLOW_UP_DAYS
  )
  return typeof stored === "number"
    ? clampThresholdDays(stored, DEFAULT_FOLLOW_UP_DAYS)
    : DEFAULT_FOLLOW_UP_DAYS
}

/** Persist the follow-up reminder interval (clamped on write). */
export async function setFollowUpDaysPreference(
  executor: SqlExecutor,
  days: number
): Promise<void> {
  await setSetting(
    executor,
    PREFERENCE_KEYS.followUpDays,
    clampThresholdDays(days, DEFAULT_FOLLOW_UP_DAYS)
  )
}

// ---------------------------------------------------------------------------
// Per-account IMAP drafts folder override (design D9, task 17.2)
// ---------------------------------------------------------------------------

/** Settings key holding one IMAP account's Drafts folder path override (a
 * plain JSON string). Consulted by the draft-mirror ops BEFORE the
 * special-use mapping and the "Drafts" name fallback; a settings-UI
 * control is a later task — until it ships, this accessor pair is the
 * only way the value is written or read. */
export function imapDraftsFolderSettingKey(accountId: string): string {
  return `${PREFERENCE_KEYS.imapDraftsFolder}:${accountId}`
}

/**
 * The account's Drafts folder override: the stored trimmed path, or null
 * when unset/blank/corrupt (null = fall through to the mapped/fallback
 * resolution in the draft mirror).
 */
export async function getImapDraftsFolderOverride(
  executor: SqlExecutor,
  accountId: string
): Promise<string | null> {
  const stored = await getSetting<unknown>(
    executor,
    imapDraftsFolderSettingKey(accountId),
    null
  )
  if (typeof stored !== "string") return null
  const trimmed = stored.trim()
  return trimmed === "" ? null : trimmed
}

/** Persist (or clear with null) the account's Drafts folder override. */
export async function setImapDraftsFolderPreference(
  executor: SqlExecutor,
  accountId: string,
  folder: string | null
): Promise<void> {
  const trimmed = folder?.trim() ?? ""
  await setSetting(
    executor,
    imapDraftsFolderSettingKey(accountId),
    trimmed === "" ? null : trimmed
  )
}

// ---------------------------------------------------------------------------
// Per-account PGP enable flag (task 18.7, design D11)
// ---------------------------------------------------------------------------

/** Settings key holding one account's OpenPGP opt-in (a plain JSON
 * boolean). The encryption settings section writes it; the pgp key rows
 * themselves are scoped separately by crypto/pgp-keys.ts
 * (`mail.pgp.{private,public}Keys:<accountId>`). */
export function pgpEnabledSettingKey(accountId: string): string {
  return `${PREFERENCE_KEYS.pgpEnabled}:${accountId}`
}

/**
 * The account's PGP opt-in: default off, and anything but a stored JSON
 * `true` reads as off (corrupt rows included). The lazy-load guarantee of
 * design D11 — no PGP chunk cost until the user enables the feature —
 * leans on this default, so failures must fail toward off.
 */
export async function getPgpEnabled(
  executor: SqlExecutor,
  accountId: string
): Promise<boolean> {
  const stored = await getSetting<unknown>(
    executor,
    pgpEnabledSettingKey(accountId),
    false
  )
  return stored === true
}

/** Persist the account's OpenPGP opt-in. */
export async function setPgpEnabledPreference(
  executor: SqlExecutor,
  accountId: string,
  enabled: boolean
): Promise<void> {
  await setSetting(executor, pgpEnabledSettingKey(accountId), enabled)
}

// ---------------------------------------------------------------------------
// Malware hash lookup (task 18.9, design D18)
// ---------------------------------------------------------------------------

/** The global malware-lookup opt-in: default off, and anything but a
 * stored JSON `true` reads as off (corrupt rows included). Failures must
 * fail toward off — the static dangerous-attachment warning (D17) stays
 * the only gate, which is exactly the feature-off contract. */
export async function getMalwareLookupEnabled(
  executor: SqlExecutor
): Promise<boolean> {
  const stored = await getSetting<unknown>(
    executor,
    PREFERENCE_KEYS.malwareLookupEnabled,
    false
  )
  return stored === true
}

/** Persist the global malware-lookup opt-in. */
export async function setMalwareLookupEnabledPreference(
  executor: SqlExecutor,
  enabled: boolean
): Promise<void> {
  await setSetting(executor, PREFERENCE_KEYS.malwareLookupEnabled, enabled)
}

/**
 * The stored lookup-service API key: the trimmed string, or "" when
 * unset/blank/corrupt ("" = effectively keyless — the lookup short-
 * circuits and D17 alone gates, per the spec's no-key path). A corrupt
 * non-string row reads as "" rather than throwing.
 *
 * The key is a third-party credential (VirusTotal), so it is stored in
 * the AES-256-GCM credentials envelope — the same at-rest treatment as
 * OAuth refresh tokens — never as plaintext in the SQLite file. Rows
 * written by older versions (plaintext) still read: they fail envelope
 * decryption and fall through to the raw value, and are re-encrypted on
 * the next save.
 */
export async function getMalwareLookupApiKey(
  executor: SqlExecutor
): Promise<string> {
  const stored = await getSetting<unknown>(
    executor,
    PREFERENCE_KEYS.malwareLookupApiKey,
    ""
  )
  if (typeof stored !== "string") return ""
  const trimmed = stored.trim()
  if (trimmed === "") return ""
  try {
    const key = await decryptCredentials<string>(trimmed)
    return typeof key === "string" ? key.trim() : ""
  } catch {
    // Not a valid envelope: a legacy plaintext row (or an unreadable key
    // store) — the value itself is still the key.
    return trimmed
  }
}

/** Persist the lookup-service API key (trimmed; blank clears it). */
export async function setMalwareLookupApiKeyPreference(
  executor: SqlExecutor,
  key: string
): Promise<void> {
  const trimmed = key.trim()
  const value = trimmed === "" ? "" : await encryptCredentials(trimmed)
  await setSetting(executor, PREFERENCE_KEYS.malwareLookupApiKey, value)
}

// ---------------------------------------------------------------------------
// Per-account local junk filter (task 18.10, design D19)
// ---------------------------------------------------------------------------

/** Settings key holding one account's junk-filter opt-in (a plain JSON
 * boolean). The junk-filter settings section writes it; the sync engines'
 * ingestion hook and the thread-actions training hooks read it. */
export function junkFilterEnabledSettingKey(accountId: string): string {
  return `${PREFERENCE_KEYS.junkFilterEnabled}:${accountId}`
}

/**
 * The account's junk-filter opt-in: default off, and anything but a
 * stored JSON `true` reads as off (corrupt rows included) — failing
 * toward off means mail is never auto-moved by surprise (the D19
 * false-positive risk note leans on this default).
 */
export async function getJunkFilterEnabled(
  executor: SqlExecutor,
  accountId: string
): Promise<boolean> {
  const stored = await getSetting<unknown>(
    executor,
    junkFilterEnabledSettingKey(accountId),
    false
  )
  return stored === true
}

/** Persist the account's junk-filter opt-in. */
export async function setJunkFilterEnabledPreference(
  executor: SqlExecutor,
  accountId: string,
  enabled: boolean
): Promise<void> {
  await setSetting(executor, junkFilterEnabledSettingKey(accountId), enabled)
}

// ---------------------------------------------------------------------------
// Keyboard-shortcut overrides (task 20.1, design D15)
// ---------------------------------------------------------------------------

/**
 * The shortcut override map (`mail.shortcutOverrides`): a single JSON
 * object `Record<ShortcutId, keys>` where each value is the binding's
 * display string in the default table's exact format ("a", "Shift+R",
 * "Cmd/Ctrl+K", "j / ↓"). One settings row, one write per rebind/reset —
 * the caller (hooks/shortcut-bindings.ts) owns merging and the in-memory
 * store. Unknown ids and non-string/blank values (a shape from an older
 * build or a hand-edited row) are dropped on read so a corrupt row can
 * never poison the matcher.
 */
export async function getShortcutOverrides(
  executor: SqlExecutor
): Promise<Partial<Record<ShortcutId, string>>> {
  const stored = await getSetting<unknown>(
    executor,
    PREFERENCE_KEYS.shortcutOverrides,
    {}
  )
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return {}
  }
  const knownIds = new Set(SHORTCUTS.map((binding) => binding.id))
  return Object.fromEntries(
    Object.entries(stored as Record<string, unknown>).filter(
      (entry): entry is [ShortcutId, string] =>
        knownIds.has(entry[0] as ShortcutId) &&
        typeof entry[1] === "string" &&
        entry[1].trim() !== ""
    )
  )
}

/** Persist the whole override map (the caller owns merging). */
export async function setShortcutOverrides(
  executor: SqlExecutor,
  overrides: Partial<Record<ShortcutId, string>>
): Promise<void> {
  await setSetting(executor, PREFERENCE_KEYS.shortcutOverrides, overrides)
}

// ---------------------------------------------------------------------------
// Boot application
// ---------------------------------------------------------------------------

/**
 * Apply every persisted preference once at boot. Called from the mail
 * shell's mount effect (after bootstrap() made the database available):
 * sets the --density/--font-scale tokens, restores the accent from the DB
 * mirror (only when a mirror row exists — see the accent note above), and
 * feeds the saved reading-pane position into the ui-store. Theme mode is
 * NOT applied here — next-themes bootstrap owns it.
 *
 * Never throws: a database hiccup keeps the in-code defaults (tokens are
 * already 1, the accent is whatever initAccent() applied, pane "right").
 */
export async function applyBootPreferences(
  executor: SqlExecutor
): Promise<void> {
  try {
    const [density, fontScale, readingPane] = await Promise.all([
      getDensity(executor),
      getFontScale(executor),
      getReadingPanePreference(executor),
    ])
    applyDensity(density)
    applyFontScale(fontScale)
    // Raw read with a sentinel: apply the mirrored accent only when the
    // user actually stored one, so a fresh DB never overrides the
    // localStorage choice initAccent() already applied pre-mount.
    const storedAccent = await getSetting<unknown>(
      executor,
      PREFERENCE_KEYS.accentId,
      ""
    )
    if (ACCENTS.some((accent) => accent.id === storedAccent)) {
      applyAccent(storedAccent as string)
    }
    if (readingPane !== useUiStore.getState().readingPane) {
      useUiStore.getState().setReadingPane(readingPane)
    }
  } catch (error) {
    console.warn("[preferences] boot apply failed; defaults kept", error)
  }
}
