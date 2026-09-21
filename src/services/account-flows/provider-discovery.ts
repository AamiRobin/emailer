import type { AccountType, SecurityKind } from "../email/types"

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

/**
 * Brand identities the UI can render an icon for (see
 * src/components/providers/provider-icon.tsx). Detection is display-time
 * only — the database keeps the coarse gmail/imap AccountType, so known
 * IMAP accounts gain their brand from the email domain with no migration.
 */
export type ProviderBrandId =
  | "gmail"
  | "outlook"
  | "yahoo"
  | "icloud"
  | "fastmail"
  | "gmx"
  | "zoho"
  | "aol"

interface KnownProvider {
  /** Display name (unused at runtime, documents the row). */
  name: string
  /** Bare registrable domains; subdomains match via suffix rule. */
  domains: string[]
  /** Brand the UI renders for this provider's accounts. */
  brand: ProviderBrandId
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
    brand: "outlook",
    settings: {
      ...imap("outlook.office365.com", 993, "tls"),
      ...smtp("smtp-office365.com", 587, "starttls"),
    },
  },
  {
    name: "Yahoo Mail",
    domains: ["yahoo.com", "ymail.com", "yahoo.co.uk"],
    brand: "yahoo",
    settings: {
      ...imap("imap.mail.yahoo.com", 993, "tls"),
      ...smtp("smtp.mail.yahoo.com", 465, "tls"),
    },
  },
  {
    name: "iCloud Mail",
    domains: ["icloud.com", "me.com", "mac.com"],
    brand: "icloud",
    settings: {
      ...imap("imap.mail.me.com", 993, "tls"),
      ...smtp("smtp.mail.me.com", 587, "starttls"),
    },
  },
  {
    name: "Fastmail",
    domains: ["fastmail.com", "fastmail.fm"],
    brand: "fastmail",
    settings: {
      ...imap("imap.fastmail.com", 993, "tls"),
      ...smtp("smtp.fastmail.com", 465, "tls"),
    },
  },
  {
    name: "GMX (international)",
    domains: ["gmx.com"],
    brand: "gmx",
    settings: {
      ...imap("imap.gmx.com", 993, "tls"),
      ...smtp("mail.gmx.com", 465, "tls"),
    },
  },
  {
    name: "GMX (Germany)",
    domains: ["gmx.net", "gmx.de"],
    brand: "gmx",
    settings: {
      ...imap("imap.gmx.net", 993, "tls"),
      ...smtp("mail.gmx.net", 465, "tls"),
    },
  },
  {
    name: "Zoho Mail",
    domains: ["zoho.com", "zohomail.com"],
    brand: "zoho",
    settings: {
      ...imap("imap.zoho.com", 993, "tls"),
      ...smtp("smtp.zoho.com", 465, "tls"),
    },
  },
  {
    name: "AOL Mail",
    domains: ["aol.com"],
    brand: "aol",
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
 * The table's shared matcher: exact domain match first, then the longest
 * registered suffix (".yahoo.com" matches "mail.yahoo.com"). Null when
 * unknown.
 */
function matchProvider(domain: string): KnownProvider | null {
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
  return best
}

/**
 * Settings for a bare domain ("user@mail.yahoo.com" → pass
 * "mail.yahoo.com"): exact match first, then the longest registered
 * suffix (".yahoo.com" matches "mail.yahoo.com"). Null when unknown.
 */
export function discoverByDomain(domain: string): DiscoveredSettings | null {
  const best = matchProvider(domain)
  return best ? { ...best.settings } : null
}

/** Brand for a bare domain, matched exactly like discoverByDomain. */
export function discoverBrandByDomain(
  domain: string
): ProviderBrandId | null {
  return matchProvider(domain)?.brand ?? null
}

/**
 * Brand for an email address. Null when the address is invalid or the
 * domain is not a known provider — the UI falls back to a generic glyph.
 */
export function discoverBrandByEmail(email: string): ProviderBrandId | null {
  const domain = extractDomain(email)
  return domain ? discoverBrandByDomain(domain) : null
}

/**
 * Consumer Microsoft mailbox domains: these addresses are Graph-eligible
 * (parity-round-2 task 3.5) — the "Add Microsoft 365" flow is the right
 * path for them, not IMAP (basic auth is deprecated on M365).
 */
const MICROSOFT_GRAPH_DOMAINS = [
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "passport.com",
]

/**
 * True when the domain is a Microsoft CONSUMER mailbox domain
 * (outlook.com/hotmail.com/live.com/msn.com and friends). Work/school M365
 * tenants use custom domains that cannot be recognized from the address
 * alone — the Add Microsoft 365 flow accepts any address the user enters;
 * this predicate only powers the IMAP flow's "this address should use
 * Microsoft 365 instead" hint and the UI's brand resolution.
 */
export function isMicrosoftGraphDomain(domain: string): boolean {
  const candidate = domain.trim().toLowerCase()
  if (!candidate) return false
  return MICROSOFT_GRAPH_DOMAINS.some(
    (known) => candidate === known || candidate.endsWith(`.${known}`)
  )
}

/**
 * True when the email address is a known Microsoft Graph consumer
 * address. Null-safe for invalid addresses (returns false).
 */
export function isMicrosoftGraphEmail(email: string): boolean {
  const domain = extractDomain(email)
  return domain !== null && isMicrosoftGraphDomain(domain)
}

/**
 * Brand to render for a stored account: gmail accounts are gmail by
 * type, microsoft accounts are outlook by type; IMAP accounts are
 * detected from the email domain, so existing rows gain their brand with
 * no migration.
 */
export function brandForAccount(
  type: AccountType,
  email: string
): ProviderBrandId | null {
  if (type === "gmail") return "gmail"
  if (type === "microsoft") return "outlook"
  return discoverBrandByEmail(email)
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
