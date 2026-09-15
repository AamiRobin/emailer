import DOMPurify, { type Config } from "dompurify"

/**
 * Safe email-HTML sanitizer (task 7.2, design D7).
 *
 * Pipeline position: raw message HTML → [task 7.3 image policy may pre- or
 * post-process] → sanitizeEmailHtml → SafeEmailFrame sandboxed iframe.
 * Nothing here touches the DOM of the host app; the output is a plain HTML
 * string meant to be embedded in the frame's srcdoc (an opaque origin).
 *
 * Posture:
 * - Strict allowlist of tags/attributes. Everything not listed is removed,
 *   which by construction strips <script>, <style>, <iframe>, <object>,
 *   <embed>, <form>, <input>, <meta>, <link>, <base>, SVG/MathML and every
 *   on* handler. javascript: (and other dangerous) URLs are rejected by
 *   DOMPurify's default URI policy.
 * - `style` attributes are deliberately NOT on the allowlist. Inline styles
 *   are a style-leak: they would fight the app theme from inside the
 *   style-isolated frame and enable overlay/visibility attacks. Email HTML
 *   renders fine with structural/legacy presentational attributes (width,
 *   bgcolor, …) which ARE allowed.
 * - Links are rewritten to target="_blank" rel="noopener noreferrer". The
 *   actual "open in OS browser" interception lives app-side (opener plugin
 *   in src-tauri lib.rs routes http(s) to the system browser; task 7.4).
 * - Remote images (http/https src) are replaced by a 1x1 transparent
 *   placeholder with the original URL preserved in `data-original-src` so
 *   the "show images" flow (task 7.3) can restore them. `data:` URIs and
 *   `cid:` references pass through untouched (cid resolves to the message's
 *   own attached parts via the attachment cache, D15/task 7.7).
 */

/** 1x1 transparent GIF shown in place of a blocked remote image. */
export const BLOCKED_IMAGE_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"

export interface SanitizeEmailHtmlOptions {
  /**
   * Replace http/https image sources with a transparent placeholder (keeping
   * the original in `data-original-src`). Secure by default (D7: blocked
   * unless allowed); task 7.3 passes `false` for allow-listed senders and
   * the per-message "show images" reload.
   */
  blockRemoteImages?: boolean
}

/**
 * Conservative email allowlist: structure, text formatting, tables, images,
 * and the legacy presentational tags still common in email HTML
 * (<font>, <center>, <nobr>). Deliberately absent: everything interactive,
 * embeddable, scripted, or styling-leaking (no style attr, no id/name).
 * `data-*` attributes pass via DOMPurify's default ALLOW_DATA_ATTR.
 */
const ALLOWED_TAGS = [
  // Text + structure
  "a",
  "abbr",
  "acronym",
  "address",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "big",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "font",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "nobr",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "time",
  "tt",
  "u",
  "ul",
  "var",
  "wbr",
  // Tables
  "col",
  "colgroup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  // Media (images only)
  "img",
]

const ALLOWED_ATTR = [
  "abbr",
  "align",
  "alt",
  "axis",
  "bgcolor",
  "border",
  "cellpadding",
  "cellspacing",
  "char",
  "charoff",
  "charset",
  "cite",
  "class",
  "clear",
  "color",
  "colspan",
  "datetime",
  "dir",
  "face",
  "headers",
  "height",
  "href",
  "hspace",
  "lang",
  "nowrap",
  "rel",
  "rowspan",
  "rules",
  "scope",
  "size",
  "span",
  "src",
  "start",
  "summary",
  "target",
  "title",
  "type",
  "valign",
  "vspace",
  "width",
]

/**
 * Explicit forbidden list. Redundant with the allowlist today (anything not
 * allowed is dropped) but documents intent and guards the day someone edits
 * ALLOWED_TAGS: none of the classic script/style/embed/form vectors can
 * sneak back in through a typo'd tag name.
 */
const FORBID_TAGS = [
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "meta",
  "link",
  "base",
]

const CONFIG: Config = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  FORBID_TAGS,
  // Keep the text inside removed containers (e.g. <form>Signup</form> keeps
  // "Signup"). DOMPurify's default FORBID_CONTENTS still drops the *text
  // content* of script/style/head/title, so payloads do not leak as text.
  KEEP_CONTENT: true,
}

/**
 * Sanitize untrusted email HTML into a string safe to embed in the
 * sandboxed frame (see SafeEmailFrame). Idempotent on already-sanitized
 * input, so callers may run it defensively.
 */
export function sanitizeEmailHtml(
  html: string,
  options: SanitizeEmailHtmlOptions = {}
): string {
  const blockRemoteImages = options.blockRemoteImages ?? true

  // Hooks are per-DOMPurify-instance global state; add → sanitize → remove
  // is atomic because sanitization is synchronous.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A") {
      // Never navigate in-app; opens go through the OS browser (opener
      // plugin) with no opener access granted to the target.
      node.setAttribute("target", "_blank")
      node.setAttribute("rel", "noopener noreferrer")
    } else if (node.nodeName === "IMG" && blockRemoteImages) {
      const src = (node.getAttribute("src") ?? "").trim()
      // Only http/https counts as remote (D7). data: URIs and cid:
      // references pass through untouched.
      if (/^https?:/i.test(src)) {
        node.setAttribute("data-original-src", src)
        node.setAttribute("src", BLOCKED_IMAGE_PLACEHOLDER)
      }
    }
  })

  try {
    return DOMPurify.sanitize(html, CONFIG)
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes")
  }
}
