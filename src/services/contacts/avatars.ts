import { invoke } from "@tauri-apps/api/core"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import { getGravatarEnabled } from "@/services/settings/preferences"

/**
 * Gravatar avatar bridge (task 2.5, design D12).
 *
 * Fetches contact avatars through the Rust `gravatar_fetch` command (the
 * webview never talks to gravatar.com — design D12 keeps the CSP
 * untouched and makes the opt-in enforceable in Rust + this one gate) and
 * hands the bytes to callers as blob URLs.
 *
 * Session cache: one blob URL per normalized address in a module-level
 * Map, so an address renders one image object no matter how many
 * surfaces (contacts browser rows, detail header, recipient chips,
 * autocomplete rows) show it. `clearAvatarCache()` revokes every URL and
 * notifies subscribers; the settings toggle calls it when the setting
 * flips so cached avatars leave display immediately (off) and already-
 * mounted avatars re-run their fetch under the new permission (on).
 *
 * PRIVACY CONTRACT (contacts spec "Contact avatars"): Gravatar loading
 * is opt-in because it discloses a one-way hash of each contact's email
 * address to an external service. `fetchGravatarBlobUrl` reads the
 * preference FIRST and returns null WITHOUT any invoke when it is off —
 * with the setting off, zero `gravatar_fetch` IPCs happen anywhere. Any
 * failure reading the preference (no DB, corrupt row) fails toward off.
 */

/** Normalized email → blob URL (revocable, see clearAvatarCache). */
const blobUrlByEmail = new Map<string, string>()

/** In-flight fetches, so N components asking about the same address
 * share one invoke (and one blob) instead of racing duplicates. */
const inFlight = new Map<string, Promise<string | null>>()

/** Bumped on every cache invalidation; subscribers re-run their fetch. */
let cacheVersion = 0

const listeners = new Set<() => void>()

/** Test hook: run preference reads against `executor` (node:sqlite under
 * vitest); pass null to restore the production getExecutor() binding —
 * the use-contacts.ts seam pattern. */
let executorOverride: SqlExecutor | null = null

export function setAvatarsExecutor(executor: SqlExecutor | null): void {
  executorOverride = executor
}

function resolveExecutor(): SqlExecutor {
  return executorOverride ?? getExecutor()
}

/** Lowercased + trimmed — the same normalization the Rust command hashes
 * with, so the Map key and the disk/URL cache agree. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Subscribe to cache invalidations (clearAvatarCache); returns the
 * unsubscribe function (the useSyncExternalStore contract). */
export function subscribeAvatarCache(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Snapshot for useSyncExternalStore — changes exactly when the cache
 * was cleared, which is the only event avatars need to react to. */
export function getAvatarCacheVersion(): number {
  return cacheVersion
}

/**
 * The Gravatar blob URL for `email`, or null when the setting is off,
 * the contact has no Gravatar, or the fetch failed (mock mode, offline).
 * Reads the preference BEFORE anything else — the privacy enforcement
 * point for the whole feature.
 */
export async function fetchGravatarBlobUrl(
  email: string
): Promise<string | null> {
  const key = normalizeEmail(email)
  if (key === "") return null

  const cached = blobUrlByEmail.get(key)
  if (cached) return cached
  const pending = inFlight.get(key)
  if (pending) return pending

  // PRIVACY ENFORCEMENT POINT: the preference gates the invoke. When it
  // is off (or cannot be confirmed on) we return without touching the
  // Rust side — no IPC, no hash sent anywhere, no network.
  let enabled: boolean
  try {
    enabled = await getGravatarEnabled(resolveExecutor())
  } catch {
    // No database / read failure: fail toward off.
    enabled = false
  }
  if (!enabled) return null

  const promise = (async () => {
    try {
      const base64 = await invoke<string | null>("gravatar_fetch", {
        address: key,
      })
      if (!base64) return null
      const url = blobUrlFromBase64(base64)
      blobUrlByEmail.set(key, url)
      return url
    } catch {
      // Mock mode / offline / no Gravatar plumbing: the initials avatar
      // stays; fetches are best-effort by design.
      return null
    } finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, promise)
  return promise
}

/** base64 (as returned by gravatar_fetch) → object URL over a PNG blob. */
function blobUrlFromBase64(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  return URL.createObjectURL(new Blob([bytes], { type: "image/png" }))
}

/**
 * Revoke every cached blob URL and wake the subscribers. The settings
 * toggle calls this when the Gravatar setting turns OFF — the spec's
 * "disabling the setting SHALL remove cached avatars from display" — and
 * also when it turns ON, so avatars mounted while the setting was off
 * kick their (now permitted) fetches.
 */
export function clearAvatarCache(): void {
  for (const url of blobUrlByEmail.values()) {
    try {
      URL.revokeObjectURL(url)
    } catch {
      // Revocation is best-effort; nothing sensible to do on failure.
    }
  }
  blobUrlByEmail.clear()
  inFlight.clear()
  cacheVersion += 1
  for (const listener of listeners) listener()
}
