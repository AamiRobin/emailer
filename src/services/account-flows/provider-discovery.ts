import type { SecurityKind } from "../email/types"

/**
 * Auto-discovery of IMAP/SMTP server settings for well-known email
 * providers (task 5.4, accounts spec "Known provider auto-discovery").
 *
 * The table is a curated, static snapshot of the providers' published
 * settings — deliberately no DNS/SRV lookups (offline-first, no network
 * dependency at add time). Matching is by domain suffix so subdomains
 * ("mail.yahoo.com") resolve too; whatever the table suggests is only a
 * prefill — the mandatory connection tests decide whether the settings
 * actually work before anything is saved.
 */

/** Server settings for one provider, in the accounts-table vocabulary. */
export interface DiscoveredSettings {
  imapHost: string
  imapPort: number
  imapSecurity: SecurityKind
  smtpHost: string
  smtpPort: number
  smtpSecurity: SecurityKind
}

interface KnownProvider {
  /** Display name (unused at runtime, documents the row). */
  name: string
  /** Bare registrable domains; subdomains match via suffix rule. */
  domains: string[]
  settings: DiscoveredSettings
}

const imap = (host: string, port: number, security: SecurityKind) => ({
  imapHost: host,
  imapPort: port,
  imapSecurity: security,
})

const smtp = (host: string, port: number, security: SecurityKind) => ({
  smtpHost: host,
  smtpPort: port,
  smtpSecurity: security,
})

/**
 * The discovery table: domain → connection settings. Everything runs
 * implicit TLS on 993/465 except Outlook/Office365 and iCloud SMTP, which
 * require STARTTLS on 587.
 */
export const KNOWN_PROVIDERS: KnownProvider[] = [
  {
    name: "Outlook / Hotmail / Live",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    settings: {
      ...imap("outlook.office365.com", 993, "tls"),
      ...smtp("smtp-office365.com", 587, "starttls"),
    },
  },
  {
    name: "Yahoo Mail",
    domains: ["yahoo.com", "ymail.com", "yahoo.co.uk"],
    settings: {
      ...imap("imap.mail.yahoo.com", 993, "tls"),
      ...smtp("smtp.mail.yahoo.com", 465, "tls"),
    },
  },
  {
    name: "iCloud Mail",
    domains: ["icloud.com", "me.com", "mac.com"],
    settings: {
      ...imap("imap.mail.me.com", 993, "tls"),
      ...smtp("smtp.mail.me.com", 587, "starttls"),
    },
  },
  {
    name: "Fastmail",
    domains: ["fastmail.com", "fastmail.fm"],
    settings: {
      ...imap("imap.fastmail.com", 993, "tls"),
      ...smtp("smtp.fastmail.com", 465, "tls"),
    },
  },
  {
    name: "GMX (international)",
    domains: ["gmx.com"],
    settings: {
      ...imap("imap.gmx.com", 993, "tls"),
      ...smtp("mail.gmx.com", 465, "tls"),
    },
  },
  {
    name: "GMX (Germany)",
    domains: ["gmx.net", "gmx.de"],
    settings: {
      ...imap("imap.gmx.net", 993, "tls"),
      ...smtp("mail.gmx.net", 465, "tls"),
    },
  },
  {
    name: "Zoho Mail",
    domains: ["zoho.com", "zohomail.com"],
    settings: {
      ...imap("imap.zoho.com", 993, "tls"),
      ...smtp("smtp.zoho.com", 465, "tls"),
    },
  },
  {
    name: "AOL Mail",
    domains: ["aol.com"],
    settings: {
      ...imap("imap.aol.com", 993, "tls"),
      ...smtp("smtp.aol.com", 465, "tls"),
    },
  },
]

/** The part after the last "@" of a syntactically plausible address. */
export function extractDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.lastIndexOf("@")
  if (at < 1 || at === trimmed.length - 1) return null
  const domain = trimmed.slice(at + 1)
  return domain.includes("@") ? null : domain
}

/**
 * Settings for a bare domain ("user@mail.yahoo.com" → pass
 * "mail.yahoo.com"): exact match first, then the longest registered
 * suffix (".yahoo.com" matches "mail.yahoo.com"). Null when unknown.
 */
export function discoverByDomain(domain: string): DiscoveredSettings | null {
  const candidate = domain.trim().toLowerCase()
  if (!candidate) return null
  let best: KnownProvider | null = null
  let bestLength = -1
  for (const provider of KNOWN_PROVIDERS) {
    for (const known of provider.domains) {
      const matches = candidate === known || candidate.endsWith(`.${known}`)
      if (matches && known.length > bestLength) {
        best = provider
        bestLength = known.length
      }
    }
  }
  return best ? { ...best.settings } : null
}

/**
 * Discover server settings from an email address. Returns a fresh copy
 * of the settings (callers may edit them as prefill) or null when the
 * address is invalid or the domain is not a known provider — the UI then
 * presents manual server fields per the accounts spec.
 */
export function discoverByEmail(email: string): DiscoveredSettings | null {
  const domain = extractDomain(email)
  return domain ? discoverByDomain(domain) : null
}

/** Conventional IMAP port for a security mode (manual entry defaults). */
export function defaultImapPort(security: SecurityKind): number {
  switch (security) {
    case "tls":
      return 993
    case "starttls":
    case "none":
      return 143
  }
}

/** Conventional SMTP port for a security mode (manual entry defaults). */
export function defaultSmtpPort(security: SecurityKind): number {
  switch (security) {
    case "tls":
      return 465
    case "starttls":
      return 587
    case "none":
      return 25
  }
}
