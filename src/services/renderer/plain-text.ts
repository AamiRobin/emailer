/**
 * Plain-text → safe HTML rendering (task 7.2, design D7: plain-text-only
 * messages render as preformatted text with linkified URLs through the same
 * pipeline as HTML mail).
 *
 * Output is safe by construction (everything is escaped; the only markup we
 * emit is our wrapper div and generated anchors) and is additionally stable
 * under {@link sanitizeEmailHtml}: the wrapper marker `data-emailer-plaintext`
 * passes DOMPurify's default data-attribute policy, and the anchors it
 * generates already carry target/rel.
 */

const ESCAPE_PATTERN = /[&<>"']/g

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

function escapeHtml(text: string): string {
  return text.replace(ESCAPE_PATTERN, (char) => ESCAPES[char])
}

/** Bare http/https URLs and www-prefixed hosts. */
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s]+/gi

/** Punctuation that usually trails a URL in prose rather than belonging to it. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}…]+$/

/** Closing entities (from escaped quotes/brackets) that a URL may swallow. */
const TRAILING_ENTITY = /&(?:quot|#39|lt|gt);$/

function trimTrailingNoise(url: string): string {
  let current = url
  for (;;) {
    const next = current
      .replace(TRAILING_ENTITY, "")
      .replace(TRAILING_PUNCTUATION, "")
    if (next === current || next.length === 0) return current
    current = next
  }
}

/**
 * Render a plain-text message body as HTML: HTML-escaped, wrapped in a
 * `data-emailer-plaintext` div (the frame's base style gives that marker
 * `white-space: pre-wrap`, so newlines survive), with bare http/https/www
 * URLs turned into anchors that open externally.
 */
export function renderPlainTextAsHtml(text: string): string {
  const escaped = escapeHtml(text)
  const linkified = escaped.replace(URL_PATTERN, (match) => {
    const url = trimTrailingNoise(match)
    if (url.length === 0) return match
    // Anything trimmed off (trailing punctuation/entities) stays visible as
    // plain text right after the anchor.
    const trailing = match.slice(url.length)
    // "www." has no scheme; assume https so the href is absolute. The
    // escaped text contains no raw quotes (they became entities, which HTML
    // parsers decode *after* attribute delimiting), so embedding in
    // href="…" is injection-safe.
    const href = url.startsWith("www.") ? `https://${url}` : url
    return (
      `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>` +
      trailing
    )
  })
  return `<div data-emailer-plaintext>${linkified}</div>`
}
