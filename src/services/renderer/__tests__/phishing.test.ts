import { describe, expect, it } from "vitest"

import { analyzePhishing } from "../phishing"

/**
 * Phishing detector unit tests (task 18.1, design D12). Each detector is
 * exercised with the fixture messages from the task: mismatch flagged,
 * pure-text and same-domain links clean, contact-name spoof flagged,
 * the real contact writing in clean, leet-confusable domain flagged,
 * unrelated domain clean, own-address spoof flagged. The spoof fixtures
 * also pin the spec scenario's "never mailed the user" gate (a known
 * correspondent's address is never name-flagged), and the confusable
 * fixtures cover the homoglyph play in both header encodings (raw UTF-8
 * and punycode xn--).
 */

const CONTACTS = [
  { name: "Ada Lovelace", email: "ada@example.com" },
  { name: "Grace Hopper", email: "grace@navy.mil" },
]

function analyze(overrides: {
  fromName?: string | null
  fromAddress?: string | null
  bodyHtml?: string
  contacts?: typeof CONTACTS
  ownAddresses?: string[]
}) {
  return analyzePhishing({
    fromName: overrides.fromName ?? null,
    fromAddress: overrides.fromAddress ?? null,
    bodyHtml: overrides.bodyHtml ?? "",
    contacts: overrides.contacts ?? CONTACTS,
    ownAddresses: overrides.ownAddresses ?? ["me@example.com"],
  })
}

const kindsOf = (findings: ReturnType<typeof analyze>) =>
  findings.map((finding) => finding.kind)

describe("link-text/href mismatch", () => {
  it("flags a link whose URL-looking text points at another host", () => {
    const findings = analyze({
      bodyHtml:
        '<p>Urgent: <a href="http://evil.ru/login">https://bank.com</a></p>',
    })
    expect(kindsOf(findings)).toEqual(["link-mismatch"])
    expect(findings[0]?.detail).toContain("evil.ru")
    expect(findings[0]?.detail).toContain("bank.com")
  })

  it("flags a bare-domain link text that goes elsewhere", () => {
    const findings = analyze({
      bodyHtml: '<a href="https://evil.ru">bank.com</a>',
    })
    expect(kindsOf(findings)).toEqual(["link-mismatch"])
  })

  it("does not flag pure-text links like “click here”", () => {
    const findings = analyze({
      bodyHtml: '<a href="http://evil.ru">click here</a>',
    })
    expect(findings).toEqual([])
  })

  it("does not flag a sentence merely mentioning a domain", () => {
    const findings = analyze({
      bodyHtml: '<a href="https://blog.example.com">Read about bank.com</a>',
    })
    expect(findings).toEqual([])
  })

  it("does not flag a same-domain link (path and case differences allowed)", () => {
    const findings = analyze({
      bodyHtml:
        '<a href="https://www.BANK.com/secure/login">https://bank.com</a>',
    })
    expect(findings).toEqual([])
  })

  it("ignores mailto and relative hrefs entirely", () => {
    const findings = analyze({
      bodyHtml:
        '<a href="mailto:bank.com@evil.ru">bank.com</a>' +
        '<a href="/secure">bank.com</a>',
    })
    expect(findings).toEqual([])
  })

  it("flags a subdomain-of-text trick (bank.com.evil.ru)", () => {
    const findings = analyze({
      bodyHtml: '<a href="https://bank.com.evil.ru">https://bank.com</a>',
    })
    expect(kindsOf(findings)).toEqual(["link-mismatch"])
  })

  it("does not flag a label naming the same host among other words", () => {
    // "View in browser: https://same.host/news" carries the real host
    // inside the label — hostOf strips only a LEADING scheme, so the
    // candidate must be extracted and compared on its own.
    const findings = analyze({
      bodyHtml:
        '<a href="https://same.host/news">View in browser: https://same.host/news</a>',
    })
    expect(findings).toEqual([])
  })

  it("flags a label naming a DIFFERENT host than the href", () => {
    const findings = analyze({
      bodyHtml:
        '<a href="https://same.host/news">View in browser: https://other.host/x</a>',
    })
    expect(kindsOf(findings)).toEqual(["link-mismatch"])
    expect(findings[0]?.detail).toContain("other.host")
    expect(findings[0]?.detail).toContain("same.host")
  })

  it("does not flag a multi-line label naming the same host", () => {
    const findings = analyze({
      bodyHtml:
        '<a href="https://same.host/news">Read more\nhttps://same.host/news</a>',
    })
    expect(findings).toEqual([])
  })

  it("does not flag a candidate whose host matches with a www/case difference", () => {
    const findings = analyze({
      bodyHtml:
        '<a href="https://www.same.host/news">Read: https://SAME.host/news</a>',
    })
    expect(findings).toEqual([])
  })

  it("reports at most one link-mismatch finding per message", () => {
    const findings = analyze({
      bodyHtml:
        '<a href="http://a.ru">https://x.com</a>' +
        '<a href="http://b.ru">https://y.com</a>',
    })
    expect(kindsOf(findings)).toEqual(["link-mismatch"])
  })
})

describe("display-name spoofing", () => {
  it("flags a display name matching a contact from a different address", () => {
    const findings = analyze({
      fromName: "Ada Lovelace",
      fromAddress: "ceo-paypal-xxx@totally-legit.ru",
    })
    expect(kindsOf(findings)).toEqual(["display-name-spoof"])
    expect(findings[0]?.detail).toContain("ada@example.com")
  })

  it("matches case-insensitively with surrounding whitespace trimmed", () => {
    const findings = analyze({
      fromName: "  ADA LOVELACE ",
      fromAddress: "impostor@elsewhere.net",
    })
    expect(kindsOf(findings)).toEqual(["display-name-spoof"])
  })

  it("flags a display name containing a contact's email", () => {
    const findings = analyze({
      fromName: "Ada Lovelace <ada@example.com>",
      fromAddress: "stranger@spam.io",
    })
    expect(kindsOf(findings)).toEqual(["display-name-spoof"])
  })

  it("does not flag the real contact writing from their own address", () => {
    const findings = analyze({
      fromName: "Ada Lovelace",
      fromAddress: "Ada@Example.com",
    })
    expect(findings).toEqual([])
  })

  it("flags a display name spoofing the user's own address", () => {
    const findings = analyze({
      fromName: "me@example.com",
      fromAddress: "admin@spoof.io",
    })
    expect(kindsOf(findings)).toEqual(["display-name-spoof"])
    expect(findings[0]?.detail).toContain("me@example.com")
  })

  it("does not flag the user's own address writing as itself", () => {
    const findings = analyze({
      fromName: "Me",
      fromAddress: "ME@example.com",
    })
    expect(findings).toEqual([])
  })

  it("does not flag an unknown name from an unknown address", () => {
    const findings = analyze({
      fromName: "Random Stranger",
      fromAddress: "random@stranger.io",
    })
    expect(findings).toEqual([])
  })

  it("does not flag a contact's name from another KNOWN correspondent's address", () => {
    // Spec scenario B requires the underlying address to have never mailed
    // the user; grace@navy.mil is in the contact store, so it has.
    const findings = analyze({
      fromName: "Ada Lovelace",
      fromAddress: "grace@navy.mil",
    })
    expect(findings).toEqual([])
  })

  it("does not flag a contact's name from the user's own address", () => {
    const findings = analyze({
      fromName: "Ada Lovelace",
      fromAddress: "me@example.com",
    })
    expect(findings).toEqual([])
  })
})

describe("confusable domains", () => {
  it("flags a leet-confusable domain of a contacted domain", () => {
    const findings = analyze({
      fromName: "PayPal Support",
      fromAddress: "support@paypa1.com",
      contacts: [...CONTACTS, { name: "PayPal", email: "service@paypal.com" }],
    })
    expect(kindsOf(findings)).toEqual(["confusable-domain"])
    expect(findings[0]?.detail).toContain("paypa1.com")
    expect(findings[0]?.detail).toContain("paypal.com")
  })

  it("flags the rn→m digraph confusable (from side normalizes INTO the known domain)", () => {
    // The attacker's "rn" renders like the "m" in the real domain:
    // modern.example normalizes into the KNOWN raw modem.example.
    const findings = analyze({
      fromAddress: "warn@modern.example",
      contacts: [{ name: "Modem", email: "hi@modem.example" }],
    })
    expect(kindsOf(findings)).toEqual(["confusable-domain"])
  })

  it("does not flag a from-domain that a KNOWN domain normalizes into", () => {
    // One-directional on purpose: a contact at m3.com must not turn
    // legitimate me.com mail into a finding — only the FROM domain is
    // normalized, and me.com does not normalize into m3.com.
    const findings = analyze({
      fromAddress: "someone@me.com",
      contacts: [{ name: "Em", email: "em@m3.com" }],
    })
    expect(findings).toEqual([])
  })

  it("flags a raw-UTF8 Cyrillic homoglyph of a known domain", () => {
    const findings = analyze({
      fromName: "Apple Support",
      fromAddress: "support@аррӏе.com", // а р р ӏ е are all Cyrillic
      contacts: [{ name: "Apple", email: "service@apple.com" }],
    })
    expect(kindsOf(findings)).toEqual(["confusable-domain"])
    expect(findings[0]?.detail).toContain("apple.com")
  })

  it("flags the punycode (xn--) form of a homoglyph domain", () => {
    // xn--80ak6aa92e decodes to аррӏе (the classic IDN spoof of apple).
    const findings = analyze({
      fromName: "Apple Support",
      fromAddress: "support@xn--80ak6aa92e.com",
      contacts: [{ name: "Apple", email: "service@apple.com" }],
    })
    expect(kindsOf(findings)).toEqual(["confusable-domain"])
    expect(findings[0]?.detail).toContain("apple.com")
  })

  it("does not flag a known domain seen in its other encoding", () => {
    // The contact is stored as the UTF-8 homoglyph form; the mail arrives
    // puny-encoded. After decoding both sides, it is the SAME domain.
    const findings = analyze({
      fromAddress: "support@xn--80ak6aa92e.com",
      contacts: [{ name: "Apple", email: "service@аррӏе.com" }],
    })
    expect(findings).toEqual([])
  })

  it("passes a hostile xn-- label through without throwing", () => {
    // Long degenerate punycode that would overflow the decoder's state —
    // it must degrade to "no finding", never a RangeError.
    const findings = analyze({
      fromAddress: "hi@xn--zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.com",
      contacts: [...CONTACTS, { name: "PayPal", email: "service@paypal.com" }],
    })
    expect(findings).toEqual([])
  })

  it("does not flag an unrelated domain", () => {
    const findings = analyze({
      fromAddress: "news@totally-unrelated.org",
      contacts: [...CONTACTS, { name: "PayPal", email: "service@paypal.com" }],
    })
    expect(findings).toEqual([])
  })

  it("does not flag the known domain itself", () => {
    const findings = analyze({
      fromAddress: "service@paypal.com",
      contacts: [{ name: "PayPal", email: "other@paypal.com" }],
    })
    expect(findings).toEqual([])
  })

  it("recognizes the user's own account domain as known", () => {
    const findings = analyze({
      fromAddress: "someone@examp1e.com",
      contacts: [],
      ownAddresses: ["me@example.com"],
    })
    expect(kindsOf(findings)).toEqual(["confusable-domain"])
  })

  it("treats the confusable comparison case-insensitively", () => {
    const findings = analyze({
      fromAddress: "hi@PAYPA1.COM",
      contacts: [{ name: "PayPal", email: "service@paypal.com" }],
    })
    expect(kindsOf(findings)).toEqual(["confusable-domain"])
  })
})

describe("aggregation", () => {
  it("lists every finding kind at most once, in stable order", () => {
    const findings = analyze({
      fromName: "Ada Lovelace",
      fromAddress: "ada@paypa1.com",
      bodyHtml: '<a href="http://evil.ru">https://bank.com</a>',
      contacts: [...CONTACTS, { name: "PayPal", email: "service@paypal.com" }],
    })
    expect(kindsOf(findings)).toEqual([
      "link-mismatch",
      "display-name-spoof",
      "confusable-domain",
    ])
  })

  it("returns nothing for a clean message", () => {
    const findings = analyze({
      fromName: "Ada Lovelace",
      fromAddress: "ada@example.com",
      bodyHtml: '<p>Hi <a href="https://example.com/paper">the paper</a>.</p>',
    })
    expect(findings).toEqual([])
  })

  it("never throws on empty or malformed input", () => {
    expect(
      analyzePhishing({
        fromName: null,
        fromAddress: null,
        bodyHtml: "",
        contacts: [],
        ownAddresses: [],
      })
    ).toEqual([])
  })
})
