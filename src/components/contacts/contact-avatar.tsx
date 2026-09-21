import { useEffect, useState, useSyncExternalStore } from "react"

import {
  getInitials,
  avatarTokenClass,
} from "@/components/email/message-utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  fetchGravatarBlobUrl,
  getAvatarCacheVersion,
  subscribeAvatarCache,
} from "@/services/contacts/avatars"

/**
 * Contact avatar (task 2.5, spec contacts "Contact avatars", design D12):
 * the Gravatar for the contact's email address when avatar loading is
 * enabled and one exists, otherwise the deterministic local initial-based
 * avatar (the same getInitials/avatarTokenClass pairing the initials-only
 * era used, so colors are stable across the rollout).
 *
 * Privacy/no-render-fetch contract:
 * - the effect per email kicks the fetch AFTER mount — nothing network-y
 *   happens during render, and initials render until (unless) a blob URL
 *   resolves;
 * - when the setting is off, `fetchGravatarBlobUrl` returns null WITHOUT
 *   any invoke, so a mounted avatar costs zero IPCs and zero network;
 * - `clearAvatarCache()` (settings toggle) bumps the cache version this
 *   component subscribes to via useSyncExternalStore, so every mounted
 *   avatar re-runs its effect and revoked URLs leave display.
 */
export function ContactAvatar({
  email,
  name,
  className,
}: {
  email: string
  /** Display name for the initials fallback (email local-part fallback). */
  name?: string | null
  className?: string
}) {
  const cacheVersion = useSyncExternalStore(
    subscribeAvatarCache,
    getAvatarCacheVersion
  )
  const [resolved, setResolved] = useState<{
    key: string
    version: number
    url: string
  } | null>(null)
  // The Rust command normalizes identically; normalizing here keys the
  // effect (and avoids refetch noise for casing/whitespace variants).
  const normalizedEmail = email.trim().toLowerCase()
  // Derived during render, not reset in the effect: a result is displayed
  // only while its (email, cache-version) pair is current, so a changed
  // email or a cleared cache drops the old URL with no setState-in-effect
  // and no stale-avatar flash.
  const blobUrl =
    resolved &&
    resolved.key === normalizedEmail &&
    resolved.version === cacheVersion
      ? resolved.url
      : null

  useEffect(() => {
    let cancelled = false
    void fetchGravatarBlobUrl(normalizedEmail)
      .then((url) => {
        if (!cancelled && url) {
          setResolved({ key: normalizedEmail, version: cacheVersion, url })
        }
      })
      .catch(() => {
        // Best-effort by design: fetch failures keep the initials.
      })
    return () => {
      cancelled = true
    }
  }, [normalizedEmail, cacheVersion])

  return (
    // Decorative everywhere it renders: the name/email are adjacent text
    // (the same aria-hidden contract the initials spans had).
    <Avatar aria-hidden className={className}>
      <AvatarFallback className={avatarTokenClass(email)}>
        {getInitials(name, email)}
      </AvatarFallback>
      {blobUrl && <AvatarImage src={blobUrl} alt="" />}
    </Avatar>
  )
}
