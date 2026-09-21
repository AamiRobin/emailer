import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

/**
 * Mailto link handling (task 1.4, spec desktop-integration "Mailto link
 * handling"): RFC 6068 parsing into a composer prefill plus the event
 * bridge that funnels every delivery path into one handler.
 *
 * Delivery paths (all converge on the `deep-link://new-url` event or the
 * boot-time `initial_deep_links` query):
 * - cold start, Windows/Linux: the deep-link plugin scans argv;
 * - cold + warm start, macOS: the OS delivers open-URL events, which the
 *   plugin surfaces on the same event;
 * - warm start, Windows/Linux: the single-instance relay (desktop.rs)
 *   re-emits the second launch's mailto argument on the same event.
 *
 * Outside the Tauri runtime every bridge degrades to a no-op unsubscribe
 * / empty list, like the rest of the desktop module.
 */

/** A composer recipient, as the mailto URL names it (address only — the
 * RFC 6068 grammar has no display names). */
export interface MailtoRecipient {
  email: string
}

/** What a mailto URL asks the composer to prefill. */
export interface MailtoDraft {
  to: MailtoRecipient[]
  cc: MailtoRecipient[]
  bcc: MailtoRecipient[]
  subject: string | null
  body: string | null
}

/**
 * RFC 6068 percent-decoding: `+` is a literal plus (this is NOT
 * form-encoding), invalid escapes decode permissively (the WHATWG
 * fallback — a bare `%` stays literal) so a hand-written link never
 * throws.
 */
function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** A decoded address is only kept when it plausibly names a mailbox —
 * garbage segments in the `to` list are dropped rather than shown as
 * invalid chips. */
function looksLikeAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(value)
}

function parseRecipients(value: string): MailtoRecipient[] {
  return value
    .split(",")
    .map((address) => percentDecode(address.trim()))
    .filter(looksLikeAddress)
    .map((email) => ({ email }))
}

/**
 * Parse a mailto URL into a draft prefill. Returns null for anything
 * that is not a mailto URL (the caller filters delivery paths); a bare
 * `mailto:` parses to an empty draft (open a blank composer).
 */
export function parseMailto(rawUrl: string): MailtoDraft | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== "mailto:") return null

  // `URL` folds the path+query oddly for opaque schemes: the recipient
  // list is everything after "mailto:" up to the first "?". Reconstruct
  // from the raw string to keep percent-encoding intact for addresses.
  const withoutScheme = rawUrl.slice("mailto:".length)
  const [toPart, queryPart = ""] = withoutScheme.split("?")

  const draft: MailtoDraft = {
    to: parseRecipients(toPart ?? ""),
    cc: [],
    bcc: [],
    subject: null,
    body: null,
  }

  for (const pair of queryPart.split("&")) {
    if (pair === "") continue
    const eq = pair.indexOf("=")
    const key = percentDecode(
      eq === -1 ? pair : pair.slice(0, eq)
    ).toLowerCase()
    const value = eq === -1 ? "" : percentDecode(pair.slice(eq + 1))
    switch (key) {
      case "to":
        draft.to.push(...parseRecipients(value))
        break
      case "cc":
        draft.cc.push(...parseRecipients(value))
        break
      case "bcc":
        draft.bcc.push(...parseRecipients(value))
        break
      case "subject":
        draft.subject = value
        break
      case "body":
        draft.body = value
        break
      default:
        // Unknown headers are ignored (RFC 6068 §6: interoperable
        // mailto URLs only use the four defined hnames).
        break
    }
  }

  return draft
}

/**
 * Render the mailto body (plain text per RFC 6068) as composer HTML:
 * escape the text and turn newlines into <br> so the TipTap editor shows
 * the line structure the sender wrote.
 */
export function mailtoBodyToHtml(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  return escaped.split(/\r?\n/).join("<br>")
}

/**
 * Mailto links delivered while the app was already running. Resolves to
 * an unsubscribe function (a no-op one outside Tauri).
 */
export async function onMailtoLink(
  handler: (url: string) => void
): Promise<() => void> {
  try {
    const unlisten = await listen<unknown>("deep-link://new-url", (event) => {
      // The deep-link plugin emits a JSON array of URL strings.
      if (Array.isArray(event.payload)) {
        for (const url of event.payload) {
          if (typeof url === "string" && url.toLowerCase().startsWith("mailto:")) {
            handler(url)
          }
        }
      }
    })
    return unlisten
  } catch {
    return () => {}
  }
}

/**
 * Mailto links that started THIS process (cold start): the event fired
 * before the webview existed, so the links are queried once at boot.
 */
export async function initialMailtoLinks(): Promise<string[]> {
  try {
    const urls = await invoke<unknown>("initial_deep_links")
    if (!Array.isArray(urls)) return []
    return urls.filter(
      (url): url is string =>
        typeof url === "string" && url.toLowerCase().startsWith("mailto:")
    )
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Default mail client (settings toggle)
// ---------------------------------------------------------------------------

/** Mirrors desktop.rs MailtoDefaultState. */
export interface MailtoDefaultState {
  is_default: boolean
  /** The bundle id currently owning mailto: (macOS reports other
   * handlers; Windows/Linux report ours when registered). */
  current_handler: string | null
}

/** Ask the OS who handles mailto: (and whether that is us). */
export async function getMailtoDefaultState(): Promise<MailtoDefaultState | null> {
  try {
    return await invoke<MailtoDefaultState>("mailto_default_state")
  } catch {
    return null
  }
}

/**
 * Take over (enabled=true) or hand back (enabled=false) the mailto:
 * default. `restoreTo` is the recorded previous handler for the unset
 * path on macOS (LaunchServices cannot name it after a takeover).
 */
export async function setMailtoDefault(
  enabled: boolean,
  restoreTo: string | null
): Promise<void> {
  try {
    await invoke("mailto_set_default", { enabled, restoreTo })
  } catch (error) {
    console.warn("[desktop] mailto registration failed", error)
  }
}
