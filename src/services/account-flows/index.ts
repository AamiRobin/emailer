/**
 * Public surface of the add-account flows (tasks 5.3/5.4). The settings
 * Accounts section (task 11.1) re-exports from here instead of reaching
 * into the individual modules.
 */

export {
  OauthFlowError,
  buildGoogleAuthUrl,
  cancelOauthWait,
  createCodeChallenge,
  createCodeVerifier,
  createOauthState,
  createPkcePair,
  runGoogleConsent,
  GMAIL_SCOPES,
  GOOGLE_AUTH_ENDPOINT,
  OAUTH_LOOPBACK_PORT,
} from "./oauth-pkce"
export type {
  ConsentResult,
  OauthCallback,
  OauthFailureCode,
} from "./oauth-pkce"

export {
  ConsentDeniedError,
  InvalidClientIdError,
  NetworkError,
  OauthCancelledError,
  addGmailAccount,
  fetchGmailProfile,
} from "./add-gmail"
export type {
  AddGmailOptions,
  AddGmailResult,
  GmailFlowStep,
} from "./add-gmail"

export {
  ImapTestFailedError,
  MissingSettingsError,
  SmtpTestFailedError,
  addImapAccount,
  testImapSettings,
  testSmtpSettings,
} from "./add-imap"
export type {
  AddImapOptions,
  AddImapResult,
  ImapAccountConfig,
  ImapTestConfig,
} from "./add-imap"

export { removeAccount } from "./remove-account"

export {
  AccountNotFoundError,
  AccountTypeError,
  reauthGmailAccount,
  reauthImapPassword,
} from "./reauth"
export type { ReauthGmailOptions, ReauthResult } from "./reauth"

export {
  KNOWN_PROVIDERS,
  brandForAccount,
  defaultImapPort,
  defaultSmtpPort,
  discoverBrandByDomain,
  discoverBrandByEmail,
  discoverByDomain,
  discoverByEmail,
  extractDomain,
} from "./provider-discovery"
export type {
  DiscoveredSettings,
  ProviderBrandId,
} from "./provider-discovery"
