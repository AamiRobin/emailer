import { ACCENTS, applyAccent, DEFAULT_ACCENT_ID } from "@/lib/accent"
import type { SqlExecutor } from "@/services/db/executor"
import { getSetting, setSetting } from "@/services/db/settings"
import type { ReadingPanePosition } from "@/stores/ui-store"
import { useUiStore } from "@/stores/ui-store"

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
