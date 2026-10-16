/**
 * Meeting join-link extraction (parity-round-3 task 8.4, design D5):
 * a CURATED matcher over the invitation's text surfaces (LOCATION and
 * DESCRIPTION — the two places organizers put conference links), not a
 * generic URL scrape. The host list is deliberately small (the
 * well-known video-conference providers + the dial-in shape), so random
 * links in a description (maps, agenda docs, unsubscribe pages) never
 * masquerade as the meeting's join button.
 *
 * Extraction scans http(s) URLs in the given text IN ORDER and returns
 * the first one whose host matches the curated list. Dial-in-only text
 * (no URL) matches the tel:/dial-in pattern and is surfaced as a plain
 * label without a clickable URL. Pure and dependency-free.
 */

/** A found join affordance. `url` is null for dial-in-only matches. */
export interface JoinLink {
  url: string | null
  /** Human label — the provider name ("Zoom") or "Dial-in". */
  label: string
}

/** The curated video-conference hosts (suffix match on registrable
 * domain: "zoom.us" matches zoom.us and *.zoom.us). */
const VIDEO_HOSTS: { suffix: string; label: string }[] = [
  { suffix: "zoom.us", label: "Zoom" },
  { suffix: "meet.google.com", label: "Google Meet" },
  { suffix: "teams.microsoft.com", label: "Microsoft Teams" },
  { suffix: "teams.live.com", label: "Microsoft Teams" },
  { suffix: "webex.com", label: "Webex" },
  { suffix: "join.me", label: "Join.me" },
  { suffix: "gotomeeting.com", label: "GoToMeeting" },
  { suffix: "whereby.com", label: "Whereby" },
  { suffix: "meet.jit.si", label: "Jitsi" },
]

/** Dial-in affordances without a URL: tel: links and the "Dial-in"/"One-tap" wording organizers embed. */
const DIAL_IN_PATTERN = /\btel:[+\d][^\s,;)]*|(?:^|\n)\s*(?:dial[- ]?in|one[- ]tap|call[- ]in)\b/i

/** Every http(s) URL in the text, in order (trailing punctuation stripped — sentences end with periods). */
function extractUrls(text: string): string[] {
  const matches = text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)
  return [...matches].map((match) => match[0].replace(/[.,;:]+$/, ""))
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** True when `host` is `suffix` itself or a subdomain of it. */
function hostMatchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

/**
 * Find the meeting join affordance in the invitation's text surfaces.
 * Scans `surfaces` in order (call it with the higher-priority surface
 * first — LOCATION before DESCRIPTION, matching how the card displays
 * them); within a surface the first curated-host URL wins. Dial-in
 * patterns are matched only when no video URL was found. Null when the
 * text carries neither.
 */
export function extractJoinLink(...surfaces: (string | null | undefined)[]): JoinLink | null {
  for (const surface of surfaces) {
    if (!surface) continue
    for (const url of extractUrls(surface)) {
      const host = hostOf(url)
      if (!host) continue
      for (const entry of VIDEO_HOSTS) {
        if (hostMatchesSuffix(host, entry.suffix)) {
          return { url, label: entry.label }
        }
      }
    }
  }
  for (const surface of surfaces) {
    if (!surface) continue
    const match = DIAL_IN_PATTERN.exec(surface)
    if (match) {
      const tel = match[0]
      return {
        url: tel.startsWith("tel:") ? tel : null,
        label: "Dial-in",
      }
    }
  }
  return null
}
