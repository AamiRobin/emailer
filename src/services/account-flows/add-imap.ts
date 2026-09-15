import { imapTestConnection, smtpTestConnection } from "../email/invoke"
import type {
  ImapTestResult,
  SmtpTestResult,
  WireSecurity,
} from "../email/invoke"
import type { SecurityKind } from "../email/types"
import type { SqlExecutor } from "../db/executor"
import { getExecutor } from "../db/executor"
import { insertAccount } from "../db/accounts"
import { encryptCredentials } from "../crypto/credentials"
import { useAccountStore } from "../../stores/account-store"
import { triggerRefresh } from "../sync/scheduler"
import { discoverByEmail } from "./provider-discovery"

/**
 * Add-IMAP/SMTP account orchestrator (task 5.4).
 *
 * Mandatory test-before-save (accounts spec "Connection test fails"):
 * BOTH the IMAP and the SMTP connection are tested before anything is
 * written — for auto-discovered and manually entered settings alike. A
 * failed test throws a typed error carrying the server-side reason and
 * guarantees no account row exists. The typed split (ImapTestFailed vs
 * SmtpTestFailed) lets the UI show WHICH side failed and why.
 *
 * Credential hygiene: the password never appears in errors or logs; it
 * is only persisted inside the AES-256-GCM credentials envelope.
 */

/** Server settings as entered/discovered for one IMAP+SMTP provider. */
export interface ImapAccountConfig {
  imapHost: string
  imapPort: number
  imapSecurity: SecurityKind
  smtpHost: string
  smtpPort: number
  smtpSecurity: SecurityKind
}

/** Config plus the login identity the connection tests authenticate as. */
export interface ImapTestConfig extends ImapAccountConfig {
  email: string
}

/** Thrown when the IMAP (incoming) connection test fails; message carries
 * the underlying reason (unreachable host, bad credentials, wrong port). */
export class ImapTestFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ImapTestFailedError"
  }
}

/** Thrown when the SMTP (outgoing) connection test fails. */
export class SmtpTestFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SmtpTestFailedError"
  }
}

/** No manual config given and the domain is not a known provider. */
export class MissingSettingsError extends Error {
  constructor(email: string) {
    super(
      `No server settings known for “${email}” — enter the IMAP and ` +
        "SMTP servers manually."
    )
    this.name = "MissingSettingsError"
  }
}

function asMessage(error: unknown): string {
  // The Rust commands reject with plain error strings describing the
  // connection failure (host, port, auth) — surface them verbatim.
  return error instanceof Error ? error.message : String(error)
}

/** Run the IMAP (incoming) connection test for these settings. */
export function testImapSettings(
  config: ImapTestConfig,
  password: string
): Promise<ImapTestResult> {
  return imapTestConnection({
    host: config.imapHost,
    port: config.imapPort,
    security: config.imapSecurity as WireSecurity,
    username: config.email,
    password,
    acceptInvalidCerts: false,
  })
}

/** Run the SMTP (outgoing) connection test for these settings. */
export function testSmtpSettings(
  config: ImapTestConfig,
  password: string
): Promise<SmtpTestResult> {
  return smtpTestConnection({
    host: config.smtpHost,
    port: config.smtpPort,
    security: config.smtpSecurity as WireSecurity,
    username: config.email,
    password,
    acceptInvalidCerts: false,
  })
}

export interface AddImapOptions {
  email: string
  password: string
  /**
   * Server settings; omitted → auto-discovery from the email's domain.
   * Connection tests run in BOTH cases before the account is saved.
   */
  config?: ImapAccountConfig
  executor?: SqlExecutor
}

export interface AddImapResult {
  accountId: string
  imapTest: ImapTestResult
  smtpTest: SmtpTestResult
}

/**
 * Add an IMAP/SMTP account end to end: resolve settings (given or
 * discovered), test IMAP, test SMTP, then insert the account row with the
 * encrypted password envelope, refresh the account store and kick off the
 * initial sync. Throws (without saving) on the first failing test.
 */
export async function addImapAccount(
  options: AddImapOptions
): Promise<AddImapResult> {
  const { email, password } = options
  // Given settings win; otherwise auto-discovery from the domain. A
  // null here means an unknown provider with no manual fields to use.
  const config: ImapAccountConfig | null =
    options.config ?? discoverByEmail(email)
  if (!config) {
    throw new MissingSettingsError(email)
  }
  const testConfig: ImapTestConfig = { email, ...config }

  const imapTest = await testImapSettings(testConfig, password).catch(
    (error: unknown) => {
      throw new ImapTestFailedError(asMessage(error))
    }
  )
  const smtpTest = await testSmtpSettings(testConfig, password).catch(
    (error: unknown) => {
      throw new SmtpTestFailedError(asMessage(error))
    }
  )

  const credentialsJson = await encryptCredentials({ password })
  // The executor is bound lazily so the mandatory test paths never touch
  // the production database binding before they have earned the insert.
  const row = await insertAccount(options.executor ?? getExecutor(), {
    type: "imap",
    email,
    imapHost: config.imapHost,
    imapPort: config.imapPort,
    imapSecurity: config.imapSecurity,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    smtpSecurity: config.smtpSecurity,
    credentialsJson,
  })

  // Local DB write → the switcher can pick the account up immediately;
  // the initial sync runs in the background and must not block the dialog.
  await useAccountStore.getState().reload()
  void triggerRefresh(row.id).catch((error: unknown) => {
    console.warn(`[add-imap] initial sync for ${row.id} failed to start`, error)
  })

  return { accountId: row.id, imapTest, smtpTest }
}
