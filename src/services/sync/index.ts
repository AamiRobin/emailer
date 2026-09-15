/**
 * Sync service barrel (tasks 4.3/4.4). Later tasks (the 5.x account
 * flows) import from here:
 *
 *   import { syncImapAccount, syncGmailAccount } from "@/services/sync"
 */

export { syncImapAccount } from "./imap-sync"
export type {
  ImapSyncOptions,
  ImapSyncProgress,
  ImapSyncSummary,
} from "./imap-sync"
export { ensureFolderLabels } from "./imap-sync"

export {
  FLAG_SCAN_WINDOW,
  imapFetchFlagsChanged,
  reconcileAllFolderFlags,
  reconcileFolderFlags,
} from "./flag-sync"
export type {
  CondstoreFolderStatus,
  CondstoreUidFlags,
  FetchFlagsChangedFn,
  FlagReconcileMode,
  FlagReconcileSummary,
  FolderFlagOutcome,
  ImapFlagsChangedResult,
  ReconcileAllFolderFlagsOptions,
  ReconcileFolderFlagsOptions,
} from "./flag-sync"

export { syncGmailAccount, ensureGmailLabels } from "./gmail-sync"
export type {
  GmailSyncOptions,
  GmailSyncProgress,
  GmailSyncSummary,
} from "./gmail-sync"

export {
  AccountSyncAuthError,
  DEFAULT_SYNC_INTERVAL_MS,
  startScheduler,
  stopScheduler,
  syncAccount,
  syncAllAccounts,
  triggerRefresh,
} from "./scheduler"
export type {
  SchedulerOptions,
  SyncAccountError,
  SyncAllResult,
} from "./scheduler"

export {
  deleteFolderSyncState,
  getFolderSyncState,
  listFolderSyncStates,
  upsertFolderSyncState,
} from "./folder-sync-state"
export type {
  FolderSyncStateInput,
  FolderSyncStateRow,
} from "./folder-sync-state"

export {
  findMessageByImapUid,
  findThreadByMessageIdHeader,
  findThreadByReferenceChain,
} from "./thread-lookup"
export type { FoundMessage } from "./thread-lookup"

export {
  groupIntoThreads,
  normalizeMessageId,
  normalizeSubject,
  parseReferences,
} from "./threading"
export type {
  ThreadGroup,
  ThreadableMessage,
  ThreadingOptions,
} from "./threading"
