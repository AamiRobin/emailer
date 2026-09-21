import { describe, expect, it } from "vitest"

import {
  KNOWN_PROVIDERS,
  brandForAccount,
  defaultImapPort,
  defaultSmtpPort,
  discoverBrandByDomain,
  discoverBrandByEmail,
  discoverByDomain,
  discoverByEmail,
  extractDomain,
  isMicrosoftGraphDomain,
  isMicrosoftGraphEmail,
} from "../provider-discovery"
import type { DiscoveredSettings } from "../provider-discovery"

describe("extractDomain", () => {
  it("returns the lowercased domain of an address", () => {
    expect(extractDomain("User@Mail.Yahoo.COM")).toBe("mail.yahoo.com")
  })

  it("trims whitespace", () => {
    expect(extractDomain("  user@example.com  ")).toBe("example.com")
  })

  it("uses the last @ so quoted or unusual locals do not break it", () => {
    expect(extractDomain("a@b@example.com")).toBe("example.com")
  })

  it("returns null for addresses without a usable domain", () => {
    expect(extractDomain("")).toBeNull()
    expect(extractDomain("nonsense")).toBeNull()
    expect(extractDomain("@example.com")).toBeNull()
    expect(extractDomain("user@")).toBeNull()
    expect(extractDomain("user@@")).toBeNull()
  })
})

describe("discoverByEmail — known providers", () => {
  const expectations: Array<{
    email: string
    imap: [string, number, string]
    smtp: [string, number, string]
  }> = [
    {
      email: "user@outlook.com",
      imap: ["outlook.office365.com", 993, "tls"],
      smtp: ["smtp-office365.com", 587, "starttls"],
    },
    {
      email: "user@hotmail.com",
      imap: ["outlook.office365.com", 993, "tls"],
      smtp: ["smtp-office365.com", 587, "starttls"],
    },
    {
      email: "user@live.com",
      imap: ["outlook.office365.com", 993, "tls"],
      smtp: ["smtp-office365.com", 587, "starttls"],
    },
    {
      email: "user@yahoo.com",
      imap: ["imap.mail.yahoo.com", 993, "tls"],
      smtp: ["smtp.mail.yahoo.com", 465, "tls"],
    },
    {
      email: "user@icloud.com",
      imap: ["imap.mail.me.com", 993, "tls"],
      smtp: ["smtp.mail.me.com", 587, "starttls"],
    },
    {
      email: "user@me.com",
      imap: ["imap.mail.me.com", 993, "tls"],
      smtp: ["smtp.mail.me.com", 587, "starttls"],
    },
    {
      email: "user@fastmail.com",
      imap: ["imap.fastmail.com", 993, "tls"],
      smtp: ["smtp.fastmail.com", 465, "tls"],
    },
    {
      email: "user@gmx.com",
      imap: ["imap.gmx.com", 993, "tls"],
      smtp: ["mail.gmx.com", 465, "tls"],
    },
    {
      email: "user@gmx.net",
      imap: ["imap.gmx.net", 993, "tls"],
      smtp: ["mail.gmx.net", 465, "tls"],
    },
    {
      email: "user@zoho.com",
      imap: ["imap.zoho.com", 993, "tls"],
      smtp: ["smtp.zoho.com", 465, "tls"],
    },
    {
      email: "user@aol.com",
      imap: ["imap.aol.com", 993, "tls"],
      smtp: ["smtp.aol.com", 465, "tls"],
    },
  ]

  for (const expected of expectations) {
    it(`resolves ${expected.email}`, () => {
      const settings = discoverByEmail(expected.email)
      expect(settings).not.toBeNull()
      expect(settings?.imapHost).toBe(expected.imap[0])
      expect(settings?.imapPort).toBe(expected.imap[1])
      expect(settings?.imapSecurity).toBe(expected.imap[2])
      expect(settings?.smtpHost).toBe(expected.smtp[0])
      expect(settings?.smtpPort).toBe(expected.smtp[1])
      expect(settings?.smtpSecurity).toBe(expected.smtp[2])
    })
  }
})

describe("discoverByEmail — matching rules", () => {
  it("matches subdomains of a known domain", () => {
    const settings = discoverByEmail("user@mail.yahoo.com")
    expect(settings?.imapHost).toBe("imap.mail.yahoo.com")
    expect(discoverByDomain("deep.nested.fastmail.com")?.smtpHost).toBe(
      "smtp.fastmail.com"
    )
  })

  it("is case-insensitive and tolerates whitespace", () => {
    expect(discoverByEmail("  USER@ICLOUD.Com ")?.imapHost).toBe(
      "imap.mail.me.com"
    )
  })

  it("returns a fresh copy — mutating the result cannot corrupt the table", () => {
    const first = discoverByEmail("user@fastmail.com")
    expect(first).not.toBeNull()
    ;(first as DiscoveredSettings).imapHost = "tampered.example.com"
    expect(discoverByEmail("other@fastmail.com")?.imapHost).toBe(
      "imap.fastmail.com"
    )
  })

  it("does not let suffix collisions bleed across providers", () => {
    // "mail.yahoo.com" matches yahoo, but "notyahoo.com" must not.
    expect(discoverByDomain("notyahoo.com")).toBeNull()
    expect(discoverByDomain("yahoo.com.evil.example")).toBeNull()
  })

  it("returns null for unknown providers and invalid input", () => {
    expect(discoverByEmail("user@example.com")).toBeNull()
    expect(discoverByEmail("user@")).toBeNull()
    expect(discoverByEmail("not-an-address")).toBeNull()
    expect(discoverByDomain("")).toBeNull()
  })
})

describe("KNOWN_PROVIDERS table sanity", () => {
  it("covers the required provider families", () => {
    const domains = KNOWN_PROVIDERS.flatMap((provider) => provider.domains)
    for (const required of [
      "outlook.com",
      "hotmail.com",
      "live.com",
      "yahoo.com",
      "icloud.com",
      "me.com",
      "fastmail.com",
      "gmx.com",
      "gmx.net",
      "zoho.com",
      "aol.com",
    ]) {
      expect(domains).toContain(required)
    }
  })

  it("uses the security vocabulary of the wire protocol and sane ports", () => {
    for (const provider of KNOWN_PROVIDERS) {
      expect(["tls", "starttls", "none"]).toContain(
        provider.settings.imapSecurity
      )
      expect(["tls", "starttls", "none"]).toContain(
        provider.settings.smtpSecurity
      )
      expect(provider.settings.imapPort).toBeGreaterThan(0)
      expect(provider.settings.imapPort).toBeLessThanOrEqual(65535)
      expect(provider.settings.smtpPort).toBeGreaterThan(0)
      expect(provider.settings.smtpPort).toBeLessThanOrEqual(65535)
    }
  })
})

describe("manual-entry default ports", () => {
  it("maps security modes to their conventional ports", () => {
    expect(defaultImapPort("tls")).toBe(993)
    expect(defaultImapPort("starttls")).toBe(143)
    expect(defaultImapPort("none")).toBe(143)
    expect(defaultSmtpPort("tls")).toBe(465)
    expect(defaultSmtpPort("starttls")).toBe(587)
    expect(defaultSmtpPort("none")).toBe(25)
  })
})

describe("brand discovery", () => {
  it("resolves brands for the known providers", () => {
    expect(discoverBrandByEmail("user@outlook.com")).toBe("outlook")
    expect(discoverBrandByEmail("user@hotmail.com")).toBe("outlook")
    expect(discoverBrandByEmail("user@yahoo.co.uk")).toBe("yahoo")
    expect(discoverBrandByEmail("user@me.com")).toBe("icloud")
    expect(discoverBrandByEmail("user@fastmail.fm")).toBe("fastmail")
    expect(discoverBrandByEmail("user@zohomail.com")).toBe("zoho")
    expect(discoverBrandByEmail("user@aol.com")).toBe("aol")
  })

  it("follows the same suffix rule as settings discovery", () => {
    expect(discoverBrandByDomain("mail.yahoo.com")).toBe("yahoo")
    expect(discoverBrandByDomain("notyahoo.com")).toBeNull()
  })

  it("maps both GMX rows to the single gmx brand", () => {
    expect(discoverBrandByDomain("gmx.com")).toBe("gmx")
    expect(discoverBrandByDomain("gmx.net")).toBe("gmx")
    expect(discoverBrandByDomain("gmx.de")).toBe("gmx")
  })

  it("returns null for unknown domains and invalid input", () => {
    expect(discoverBrandByDomain("example.com")).toBeNull()
    expect(discoverBrandByEmail("user@")).toBeNull()
    expect(discoverBrandByEmail("not-an-address")).toBeNull()
    expect(discoverBrandByEmail("user@example.com")).toBeNull()
  })

  it("detects the brand from the account type and email domain", () => {
    // Gmail accounts are gmail by type, whatever the address says.
    expect(brandForAccount("gmail", "user@weird.example")).toBe("gmail")
    expect(brandForAccount("imap", "user@outlook.com")).toBe("outlook")
    // Unknown IMAP domains have no brand — the UI shows the generic glyph.
    expect(brandForAccount("imap", "me@mydomain.com")).toBeNull()
  })

  it("gives every table row a brand", () => {
    for (const provider of KNOWN_PROVIDERS) {
      expect(provider.brand).toBeTruthy()
    }
  })
})

describe("Microsoft Graph eligibility (parity-round-2, task 3.5)", () => {
  it("detects the consumer Microsoft mailbox domains", () => {
    expect(isMicrosoftGraphEmail("me@outlook.com")).toBe(true)
    expect(isMicrosoftGraphEmail("me@hotmail.com")).toBe(true)
    expect(isMicrosoftGraphEmail("me@live.com")).toBe(true)
    expect(isMicrosoftGraphEmail("me@msn.com")).toBe(true)
    // Subdomains match by the same suffix rule as the IMAP table.
    expect(isMicrosoftGraphEmail("me@mail.outlook.com")).toBe(true)
  })

  it("does not claim arbitrary domains (custom M365 tenants stay opt-in)", () => {
    expect(isMicrosoftGraphEmail("me@contoso.com")).toBe(false)
    expect(isMicrosoftGraphEmail("me@gmail.com")).toBe(false)
    expect(isMicrosoftGraphEmail("not-an-address")).toBe(false)
    expect(isMicrosoftGraphDomain("")).toBe(false)
  })

  it("brands stored accounts: gmail → gmail, microsoft → outlook, imap by domain", () => {
    expect(brandForAccount("gmail", "user@weird.example")).toBe("gmail")
    expect(brandForAccount("microsoft", "me@any-tenant.example")).toBe("outlook")
    expect(brandForAccount("imap", "user@outlook.com")).toBe("outlook")
    expect(brandForAccount("imap", "me@mydomain.com")).toBeNull()
  })
})
