/**
 * Phishing detectors (task 18.1, design D12).
 *
 * Three pure, unit-testable detectors run once per displayed message over
 * data the render pass already has in hand: the sanitized body HTML, the
 * From header, the account's contacts and the account's own addresses.
 * Each detector returns at most one finding; the aggregate renders as a
 * dismissible warning banner above the message body. NOTHING is blocked —
 * D12 is advisory by design (the spec: "Warning state SHALL NOT block
 * reading the message").
 *
 * Detector semantics and their deliberate limits:
 *
 * 1. Link-text/href mismatch — an <a> whose VISIBLE text looks like a URL
 *    (mentions "http(s)://" anywhere or is entirely a bare domain,
 *    optionally with a path) but whose href resolves to a different host.
 *    EVERY url candidate the text carries is compared against the href
 *    host (a label like "View in browser: https://same.host/news" names
 *    the destination among other words); the finding fires only when at
 *    least one candidate exists and none matches. Comparison is a
 *    case-insensitive host match after stripping scheme, userinfo, port,
 *    path and a leading "www." — exact-host equality, NOT a registrable-
 *    domain (PSL) suffix match, which would need a public-suffix list.
 *    Pure-text anchors ("click here", "our website") are never mismatches,
 *    and anchors whose text merely MENTIONS a bare domain among other
 *    words are skipped (conservative: the whole trimmed text must look
 *    like a bare domain).
 *    Only web links count (http/https, incl. protocol-relative); mailto:/
 *    cid:/relative hrefs are ignored.
 *
 * 2. Display-name spoofing — the From display name impersonates someone
 *    the user knows: it EQUALS (trimmed, case-insensitive) a contact's
 *    name, or CONTAINS a contact's email address (the classic
 *    "Elon Musk <ceo-paypal-xxx@…>" play), while the From address is NOT
 *    itself a known correspondent. That gate is the spec scenario's
 *    second clause: the warning fires when "the underlying email address
 *    has never mailed the user before". The contacts store holds exactly
 *    the addresses the user has exchanged mail with (the composer's send
 *    flow upserts every recipient; ingestion seeds dev data), so a From
 *    address present there — or one of the user's own — is treated as a
 *    legitimate correspondent and never name-flagged (e.g. a contact
 *    whose client carries another contact's name is clean). The user's
 *    own identities are checked separately against `ownAddresses`: a
 *    display name equal to (or containing) one of the user's own
 *    addresses, sent from a different address, is flagged — spoofing your
 *    own address needs no "never mailed" gate. Note ownAddresses are
 *    ADDRESSES, not the account's display name — "your own name" is
 *    approximated by your own address strings for now; the caller passes
 *    [account.email] today and aliases later.
 *
 * 3. Confusable domains — the From address's domain is a look-alike of a
 *    domain the user has corresponded with (contacts' domains + the
 *    account's own domain). Both sides are first puny-decoded (RFC 3492:
 *    xn-- labels → Unicode); then the FROM domain is normalized through
 *    the same confusability map as the KNOWN side's RAW form: Unicode
 *    homoglyphs (Cyrillic/Greek letters that are visually Latin: а→a,
 *    о→o, ο→o, …), leetspeak digits (0→o, 1→l, 3→e, 5→s, 7→t), and the
 *    digraph rules vv→w, rn→m — so аpple.com (any of raw-UTF8 or
 *    xn--80ak6aa92e.com forms) and paypa1.com collapse INTO apple.com /
 *    paypal.com and are caught, and a TLD swap (paypa1.com vs
 *    paypal.org) rides along for free. The check is one-directional ON
 *    PURPOSE: only the sender's domain may normalize INTO a raw known
 *    domain — folding the known side too would flag legitimate mail
 *    whenever a contact's own domain normalizes into it (m3.com vs
 *    me.com). The exact-match skip runs on the DECODED domain, so a
 *    known contact stored as аpple.com writing via its xn-- form is the
 *    same domain, not a finding. Limits, on purpose:
 *    identical-registry-prefix look-alikes (google.com vs
 *    google-mail.com) are NOT caught, and the homoglyph table is a small
 *    deliberate set, not the full IDN confusable tables.
 */

export type PhishingFindingKind =
  "link-mismatch" | "display-name-spoof" | "confusable-domain"

export interface PhishingFinding {
  kind: PhishingFindingKind
  /** Plain-language, banner-ready description of the finding. */
  detail: string
}

/** Minimal contact identity the detectors need (ContactRow projects to it). */
export interface PhishingContact {
  name?: string | null
  email: string
}

export interface PhishingAnalysisInput {
  /** The message's From display name, or null when the header had none. */
  fromName: string | null
  /** The message's From address, or null when unknown. */
  fromAddress: string | null
  /** The message's sanitized HTML (the string the frame renders). */
  bodyHtml: string
  /** The account's known contacts. */
  contacts: PhishingContact[]
  /**
   * The account's own sending addresses. Today callers pass
   * [account.email]; aliases slot in here when they land.
   */
  ownAddresses: string[]
}

/**
 * Run all three detectors and aggregate their findings (each kind at most
 * once, stable order). Pure: DOMParser on the sanitized string only —
 * jsdom-safe, no app state.
 */
export function analyzePhishing(
  input: PhishingAnalysisInput
): PhishingFinding[] {
  const findings: PhishingFinding[] = []
  const link = detectLinkMismatch(input.bodyHtml)
  if (link) findings.push(link)
  const spoof = detectDisplayNameSpoof(
    input.fromName,
    input.fromAddress,
    input.contacts,
    input.ownAddresses
  )
  if (spoof) findings.push(spoof)
  const confusable = detectConfusableDomain(
    input.fromAddress,
    input.contacts,
    input.ownAddresses
  )
  if (confusable) findings.push(confusable)
  return findings
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Canonical address form: trimmed + lowercased (same rule as contacts.ts). */
function normalizeAddress(email: string): string {
  return email.trim().toLowerCase()
}

/** The domain part of an email address (after the last @), normalized. */
function domainOfAddress(address: string): string {
  const at = address.lastIndexOf("@")
  return at === -1 ? "" : address.slice(at + 1)
}

/**
 * Host of a URL-ish string: strips scheme, userinfo, port, path/query/
 * fragment and a leading "www." — the exact-host comparison the link
 * detector and the domain keys use. Not a full URL parser; input is
 * already sanitized mail or a stored address.
 */
function hostOf(value: string): string {
  let host = value.trim().toLowerCase()
  host = host.replace(/^https?:\/\//i, "")
  host = host.replace(/^\/\//, "") // protocol-relative
  const beforePath = host.split(/[/?#]/)[0] ?? ""
  const withoutUserinfo = beforePath.includes("@")
    ? (beforePath.split("@").pop() ?? "")
    : beforePath
  const withoutPort = withoutUserinfo.split(":")[0] ?? ""
  return withoutPort.replace(/^www\./i, "")
}

// ---------------------------------------------------------------------------
// Detector 1: link text vs href
// ---------------------------------------------------------------------------

/** A bare domain (labels + 2+ alpha TLD), optionally followed by a path. */
const BARE_DOMAIN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:[/?#:]|$)/i

/**
 * The anchor text counts as a destination claim when it mentions an
 * explicit http(s) URL ANYWHERE ("Read more: https://bank.com" — the
 * claim is the URL, whatever else the label says) or is entirely a bare
 * domain (optionally with path/port, line wraps collapsed). Anything
 * else ("click here", "our website", a sentence mentioning a domain) is
 * never treated as a destination claim — that keeps false positives off
 * normal mail.
 */
function looksLikeUrlText(text: string): boolean {
  if (/https?:\/\//i.test(text)) return true
  return BARE_DOMAIN_RE.test(collapseWhitespace(text))
}

/**
 * Every http(s) URL mentioned anywhere in an anchor's text. A label may
 * name the real destination among other words ("View in browser:
 * https://same.host/news") — and hostOf strips only a LEADING scheme, so
 * the candidates must be extracted and compared one by one rather than
 * handing the whole label to hostOf. Global flag: used with .match()
 * only, never .test() (stateful lastIndex).
 */
const URL_IN_TEXT_RE = /https?:\/\/\S+/gi

/** Internal whitespace (incl. the line wraps html mail inserts inside
 * anchor text) collapsed to single spaces, so the anchored bare-domain
 * check still sees one token. */
function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ")
}

/** Trailing punctuation a sentence leaves on an extracted URL
 * ("Visit https://same.host.") must not become part of the host. */
function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]}'"»”]+$/, "")
}

/** Web-ish hrefs only: http(s) or protocol-relative. */
function isWebHref(href: string): boolean {
  return /^(?:https?:\/\/|\/\/)/i.test(href.trim())
}

function detectLinkMismatch(bodyHtml: string): PhishingFinding | null {
  if (!bodyHtml) return null
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(bodyHtml, "text/html")
  } catch {
    return null // no DOM available — degrade to no findings, never throw
  }
  for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = anchor.getAttribute("href") ?? ""
    if (!isWebHref(href)) continue
    const text = (anchor.textContent ?? "").trim()
    if (!text || !looksLikeUrlText(text)) continue
    const hrefHost = hostOf(href)
    if (!hrefHost) continue
    // Compare EVERY URL the text mentions against the href host — the
    // label may name the real destination among other words, and the
    // finding only stands when at least one candidate exists and NONE
    // matches. Without the per-candidate loop, "Read more:
    // https://same.host/x" flagged as mismatched because hostOf strips
    // only a LEADING scheme off the whole label. A bare-domain label
    // ("bank.com") claims the collapsed whole text instead.
    const candidates = (text.match(URL_IN_TEXT_RE) ?? [])
      .map((url) => hostOf(trimTrailingPunctuation(url)))
      .filter((host) => host !== "")
    const claimedHosts =
      candidates.length > 0
        ? candidates
        : [hostOf(collapseWhitespace(text))].filter((host) => host !== "")
    if (claimedHosts.length === 0) continue
    if (claimedHosts.every((host) => host !== hrefHost)) {
      return {
        kind: "link-mismatch",
        detail: `A link labeled “${text}” actually goes to ${hrefHost}, not ${claimedHosts[0]}.`,
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Detector 2: display-name spoofing
// ---------------------------------------------------------------------------

function detectDisplayNameSpoof(
  fromName: string | null,
  fromAddress: string | null,
  contacts: PhishingContact[],
  ownAddresses: string[]
): PhishingFinding | null {
  const name = (fromName ?? "").trim().toLowerCase()
  const address = normalizeAddress(fromAddress ?? "")
  if (!name || !address) return null

  // The user's own identities first: a display name equal to (or
  // containing) one of the user's own addresses, sent from ANY other
  // address, is the self-spoof play.
  for (const own of ownAddresses) {
    const ownEmail = normalizeAddress(own)
    if (!ownEmail || address === ownEmail) continue
    if (name === ownEmail || name.includes(ownEmail)) {
      return {
        kind: "display-name-spoof",
        detail: `The display name “${fromName?.trim()}” claims to be your address ${ownEmail}, but the message is from ${address}.`,
      }
    }
  }

  // Spec scenario gate: the name-spoof play fires only when the From
  // address "has never mailed the user before". The contacts store holds
  // the addresses the user has exchanged mail with, so a From address
  // already known there (or the user's own) is a correspondent — e.g. a
  // contact whose mail client carries a different contact's display name
  // is legitimate, not an impersonation.
  const knownAddresses = new Set<string>()
  for (const contact of contacts) {
    const email = normalizeAddress(contact.email)
    if (email) knownAddresses.add(email)
  }
  for (const own of ownAddresses) {
    const email = normalizeAddress(own)
    if (email) knownAddresses.add(email)
  }
  if (knownAddresses.has(address)) return null

  for (const contact of contacts) {
    const contactEmail = normalizeAddress(contact.email)
    if (!contactEmail || address === contactEmail) continue
    const contactName = (contact.name ?? "").trim().toLowerCase()
    // Name equality (trimmed, case-insensitive) OR the contact's email
    // appearing inside the display name — both with a differing address.
    if (
      (contactName !== "" && name === contactName) ||
      name.includes(contactEmail)
    ) {
      return {
        kind: "display-name-spoof",
        detail: `The display name “${fromName?.trim()}” matches ${contactName || contactEmail} (${contactEmail}), but the message is from ${address}.`,
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Detector 3: confusable (look-alike) sender domains
// ---------------------------------------------------------------------------

/** Leetspeak map applied character-by-character. */
const LEET_MAP: Record<string, string> = {
  "0": "o",
  "1": "l",
  "3": "e",
  "5": "s",
  "7": "t",
}

/**
 * Unicode homoglyph map: Cyrillic and Greek letters that are visually
 * near-identical to Latin ones (the IDN-spoof staples), plus dotless ı.
 * Lowercase only — domains are lowercased before folding. Deliberately a
 * small set of the most-abused characters, not full IDN confusable tables.
 */
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  і: "i",
  ѕ: "s",
  ј: "j",
  ӏ: "l",
  к: "k",
  м: "m",
  // Greek
  ο: "o",
  α: "a",
  ε: "e",
  ρ: "p",
  ι: "i",
  κ: "k",
  ν: "v",
  τ: "t",
  υ: "u",
  χ: "x",
  // Latin-1 dotless i
  ı: "i",
}

const PUNY_BASE = 36
const PUNY_TMIN = 1
const PUNY_TMAX = 26
const PUNY_SKEW = 38
const PUNY_DAMP = 700
const PUNY_INITIAL_BIAS = 72
const PUNY_INITIAL_N = 128

function punyAdapt(
  delta: number,
  numPoints: number,
  firstTime: boolean
): number {
  delta = Math.floor(delta / (firstTime ? PUNY_DAMP : 2))
  delta += Math.floor(delta / numPoints)
  let k = 0
  while (delta > Math.floor(((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) / 2)) {
    delta = Math.floor(delta / (PUNY_BASE - PUNY_TMIN))
    k += PUNY_BASE
  }
  return (
    k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * delta) / (delta + PUNY_SKEW))
  )
}

function punyDecodeDigit(code: number): number | null {
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 // a-z
  if (code >= 0x41 && code <= 0x5a) return code - 0x41 // A-Z
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26 // 0-9
  return null
}

/**
 * RFC 3492 punycode decode of one label; null on malformed input.
 * Overflow-guarded like the reference implementation (a hostile label
 * must never push values out of range), so it never throws.
 * Verified equivalent to the reference implementation on the RFC sample
 * vectors (bcher-kva → bücher, 80ak6aa92e → аррӏе, $-eca117v → ¥€$).
 */
function punyDecode(label: string): string | null {
  const output: number[] = []
  let basic = label.lastIndexOf("-")
  if (basic > 0) {
    for (let j = 0; j < basic; j++) {
      const code = label.charCodeAt(j)
      if (code >= 0x80) return null
      output.push(code)
    }
  } else {
    basic = 0
  }
  let n = PUNY_INITIAL_N
  let i = 0
  let bias = PUNY_INITIAL_BIAS
  let index = basic > 0 ? basic + 1 : 0
  while (index < label.length) {
    const oldI = i
    let weight = 1
    for (let k = PUNY_BASE; ; k += PUNY_BASE) {
      if (index >= label.length) return null
      const digit = punyDecodeDigit(label.charCodeAt(index++))
      if (digit === null) return null
      if (digit > Number.MAX_SAFE_INTEGER / weight) return null
      i += digit * weight
      const t =
        k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias
      if (digit < t) break
      if (weight > Number.MAX_SAFE_INTEGER / (PUNY_BASE - t)) return null
      weight *= PUNY_BASE - t
    }
    const length = output.length
    bias = punyAdapt(i - oldI, length + 1, oldI === 0)
    if (n > Number.MAX_SAFE_INTEGER - Math.floor(i / (length + 1))) return null
    n += Math.floor(i / (length + 1))
    i %= length + 1
    output.splice(i, 0, n)
    i++
  }
  // Only well-formed scalar values may become a string (lone surrogates
  // and out-of-range values would make fromCodePoint throw).
  for (const code of output) {
    if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
      return null
  }
  return String.fromCodePoint(...output)
}

/**
 * Lowercase a domain and decode every xn-- (punycode) label to Unicode,
 * best-effort — malformed or non-punycode labels pass through unchanged.
 * Both sides of the confusable comparison go through this, so a spoofed
 * аpple.com is caught whichever encoding (SMTPUTF8 raw or xn--) the
 * header used, and a known domain seen in its other encoding still
 * counts as exactly known.
 */
function decodeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .split(".")
    .map((label) => {
      if (!label.startsWith("xn--")) return label
      return punyDecode(label.slice(4)) ?? label
    })
    .join(".")
}

/**
 * Normalize a decoded domain through the confusability maps: Unicode
 * homoglyphs, then leetspeak digits, then the digraph rules (vv→w,
 * rn→m). Both sides of every comparison go through this exact function,
 * so paypa1.com, аpple.com and paypal.com collapse to the same form.
 */
function normalizeConfusableDomain(domain: string): string {
  let normalized = domain
  normalized = [...normalized]
    .map((char) => HOMOGLYPH_MAP[char] ?? char)
    .join("")
  normalized = normalized.replace(/[01357]/g, (char) => LEET_MAP[char] ?? char)
  normalized = normalized.replaceAll("vv", "w")
  normalized = normalized.replaceAll("rn", "m")
  return normalized
}

function detectConfusableDomain(
  fromAddress: string | null,
  contacts: PhishingContact[],
  ownAddresses: string[]
): PhishingFinding | null {
  const fromDomain = decodeDomain(
    domainOfAddress(normalizeAddress(fromAddress ?? ""))
  )
  // Require a dotted domain — a bare local part or single label has no
  // meaningful "look-alike" under this scheme.
  if (!fromDomain || !fromDomain.includes(".")) return null

  const known = new Set<string>()
  for (const contact of contacts) {
    const domain = decodeDomain(
      domainOfAddress(normalizeAddress(contact.email))
    )
    if (domain) known.add(domain)
  }
  for (const own of ownAddresses) {
    const domain = decodeDomain(domainOfAddress(normalizeAddress(own)))
    if (domain) known.add(domain)
  }

  // An exact known domain (after decoding) is legitimate correspondence —
  // never a finding. This also covers the same domain seen in its other
  // encoding (contact stored as аpple.com, mail arrives as xn--…).
  if (known.has(fromDomain)) return null

  // Directional confusable check: normalize ONLY the FROM side and
  // compare against the RAW known domains — a look-alike sender domain
  // must collapse INTO a known domain (paypa1.com → paypal.com,
  // аpple.com → apple.com, modern.example → modem.example). Normalizing
  // the KNOWN side too would fold legitimate mail the other way: a
  // contact at m3.com would make every me.com sender a finding, because
  // m3.com normalizes into me.com just as well.
  const fromNormalized = normalizeConfusableDomain(fromDomain)
  for (const domain of known) {
    if (!domain.includes(".")) continue
    if (fromNormalized === domain) {
      return {
        kind: "confusable-domain",
        detail: `The sender's domain ${fromDomain} closely resembles the known domain ${domain} — it may be an impersonation.`,
      }
    }
  }
  return null
}
