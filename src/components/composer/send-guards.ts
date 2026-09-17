import { htmlToText } from "@/services/email/mime-builder"

/**
 * Send guards (task 5.3, spec mail-composition "Send guards"): the pure
 * detection behind the composer's two pre-send prompts — the forgotten-
 * attachment reminder and the empty-subject confirmation. The prompts
 * themselves are SendGuardDialogs (send-guard-dialogs.tsx); the composer
 * evaluates this module on every Send click, queues the conditions the
 * account has not suppressed (preferences.ts per-account flags) and has
 * not already confirmed for the attempt, and only proceeds to the send
 * (or the undo-send window) once every prompt is answered.
 */

/** The guards a Send click can raise, in prompt order. */
export type SendGuardKind = "attachment" | "emptySubject"

/**
 * Quoted history (reply.ts buildQuotedHistory) wraps the original message
 * in <blockquote> — a "see attached" downthread is someone else's words
 * and must not trip the guard for a reply that never mentions one.
 * Stripped innermost-first (repeated until stable), which handles nesting.
 */
function stripBlockquotes(html: string): string {
  const innermost =
    /<blockquote\b[^>]*>(?:(?!<blockquote)[\s\S])*?<\/blockquote>/gi
  let previous = ""
  let current = html
  while (current !== previous) {
    previous = current
    current = current.replace(innermost, "")
  }
  return current
}

/** The attachment-wording family the spec calls out ("attached",
 * "attachment", plus the rest of the stem), word-boundary matched so
 * "unattached" and friends stay clean. */
const ATTACHMENT_WORDING = /\battach(?:ed|ing|ments?|es|s)?\b/i

/**
 * True when the VISIBLE body (quoted history excluded) references an
 * attachment — detected over the plain text the MIME builder derives from
 * the HTML, so the guard sees exactly what the recipient reads.
 */
export function bodyReferencesAttachment(html: string): boolean {
  return ATTACHMENT_WORDING.test(htmlToText(stripBlockquotes(html)))
}

/**
 * The guard conditions the draft currently meets, in prompt order: the
 * attachment reminder first (it changes what the message carries), then
 * the empty-subject confirmation. Suppression and once-per-attempt
 * filtering happen at the call site — this stays a pure content read.
 */
export function evaluateSendGuards(input: {
  html: string
  subject: string
  /** True when the outgoing payload will actually carry files. */
  hasAttachments: boolean
}): SendGuardKind[] {
  const guards: SendGuardKind[] = []
  if (!input.hasAttachments && bodyReferencesAttachment(input.html)) {
    guards.push("attachment")
  }
  if (input.subject.trim() === "") guards.push("emptySubject")
  return guards
}
