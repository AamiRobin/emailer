import type {
  AccountType,
  EmailAccount,
  EmailProvider,
  ProviderCredentials,
} from "./types"
import { createImapSmtpProvider } from "./imap-smtp-provider"

/**
 * Provider factory (design D2): returns the EmailProvider implementation
 * for an account from a type-keyed registry. Task 4.2 registers the Gmail
 * provider from its own module — `registerProvider("gmail",
 * createGmailProvider)` — without editing this file.
 */

type ProviderCreator = (
  account: EmailAccount,
  credentials: ProviderCredentials
) => EmailProvider

const registry = new Map<AccountType, ProviderCreator>()

/** Register (or replace) the provider implementation for an account type. */
export function registerProvider(
  type: AccountType,
  creator: ProviderCreator
): void {
  registry.set(type, creator)
}

/** Remove a registration — mainly for tests. */
export function unregisterProvider(type: AccountType): void {
  registry.delete(type)
}

/**
 * Build a provider for the account. Not cached: providers are cheap,
 * stateless closures over the given credentials, and callers (scheduler,
 * queue) hold instances for as long as they are valid. Recreate after a
 * credentials change.
 */
export function getProvider(
  account: EmailAccount,
  credentials: ProviderCredentials
): EmailProvider {
  const creator = registry.get(account.type)
  if (!creator) {
    throw new Error(
      `No email provider registered for account type "${account.type}". ` +
        `Registered types: ${[...registry.keys()].join(", ") || "none"}`
    )
  }
  return creator(account, credentials)
}

// The IMAP/SMTP provider ships with the factory; Gmail registers itself
// in its own module (task 4.2).
registerProvider("imap", createImapSmtpProvider)
