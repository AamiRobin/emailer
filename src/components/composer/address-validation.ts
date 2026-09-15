import type { Recipient } from "@/stores/composer-store"

/**
 * Pure address validation/parsing for the composer (task 8.1). The store
 * keeps raw input; these helpers are what the recipient chips call to
 * decide per-chip validity ("invalid addresses visibly flagged before
 * send" — mail-composition spec) and to split free-text input into
 * `Recipient` values.
 *
 * `isValidEmail` is deliberately pragmatic rather than fully RFC 5322:
 * it accepts the dot-atom local part (incl. `+` tags) and requires a
 * domain of dot-separated labels with an alphabetic TLD of 2+ letters.
 * Rejected on purpose: quoted local parts, IP-literal domains, and
 * dot-less hosts ("user@localhost") — none sendable through real
 * providers anyway.
 */

const LOCAL_PART = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+"
const DOMAIN_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?"

const EMAIL_PATTERN = new RegExp(
  `^${LOCAL_PART}(?:\\.${LOCAL_PART})*` +
    `@${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*\\.[A-Za-z]{2,}$`
)

/** True when `address` is a sendable email address (pragmatic RFC 5322). */
export function isValidEmail(address: string): boolean {
  return EMAIL_PATTERN.test(address.trim())
}

/** Split free-text input on the accepted separators (comma, semicolon,
 * whitespace) into trimmed, non-empty tokens. */
export function parseAddressInput(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

/**
 * Parse one token into a Recipient, accepting the RFC 5322 display-name
 * form `Name <local@domain>` (quotes around the name are stripped) and
 * the bare address form. No validation here — validity is `isValidEmail`.
 */
export function parseRecipient(token: string): Recipient {
  const trimmed = token.trim()
  const match = /^(.*)<([^<>]+)>$/.exec(trimmed)
  if (!match) return { email: trimmed }
  const name = match[1]
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim()
  const email = match[2].trim()
  return name ? { name, email } : { email }
}

/** Parse a whole input string ("a@x.com, Ada <ada@y.com>") into
 * recipients. Comma/semicolon segments containing a `<...>` group are kept
 * whole (display names may contain spaces); bare segments still split on
 * whitespace so "a@x.com b@x.com" yields two chips. */
export function parseRecipients(raw: string): Recipient[] {
  const recipients: Recipient[] = []
  for (const segment of raw.split(/[,;]+/)) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    if (trimmed.includes("<")) {
      recipients.push(parseRecipient(trimmed))
    } else {
      for (const token of parseAddressInput(trimmed)) {
        recipients.push(parseRecipient(token))
      }
    }
  }
  return recipients
}

/** Chip display text: the name when present, otherwise the bare address. */
export function recipientLabel(recipient: Recipient): string {
  return recipient.name ?? recipient.email
}

/** True when any recipient would fail validation (send-gating helper). */
export function hasInvalidRecipient(recipients: Recipient[]): boolean {
  return recipients.some((recipient) => !isValidEmail(recipient.email))
}
