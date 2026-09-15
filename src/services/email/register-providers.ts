import { registerGmailProvider } from "./gmail-provider"

/**
 * Registers every provider implementation shipped with the app in the
 * provider factory. Import this module (or call registerEmailProviders)
 * from bootstrap — before any getProvider call (scheduler, add-account
 * flow, organization actions). Registration is idempotent: the factory
 * replaces existing entries.
 */
export function registerEmailProviders(): void {
  registerGmailProvider()
}

// Side-effect registration so a bare `import "./email/register-providers"`
// is sufficient at call sites.
registerEmailProviders()
