/**
 * Centralized email actions (task 10.1, design D10) — the ONLY seam UI
 * code uses to act on threads. Both provider models (gmail label
 * membership / imap folders) and the offline queue live behind these
 * functions: each action mutates the local database first (the UI's sole
 * source of truth), then enqueues the server mutation for the queue
 * processor to replay when online.
 *
 * WIRING POINTS (later tasks — do NOT re-derive this logic in UI):
 * - Toolbar (10.1/10.2): the thread-list toolbar's archive / trash /
 *   spam / delete-forever / read-unread / star buttons call
 *   archiveThread(executor, accountId, activeThreadId) etc. with
 *   getExecutor() and useAccountStore.getState().activeAccountId.
 * - Keyboard shortcuts (10.1, D13): the useKeyboardShortcuts binding
 *   table's action entries call the same functions for the focused
 *   thread — e.g. `e` → archiveThread, `#`/Delete → trashThread,
 *   `!` → markSpam, `Shift+I`/`Shift+U` → setThreadRead(..., true/false),
 *   `s` → setThreadStarred(..., !thread.is_starred).
 * - Context menu (10.2): mirror the toolbar + shortcuts entries; add
 *   markNotSpam in the Spam folder and deleteForeverThread (with a
 *   confirm dialog) in Trash — the service itself enforces the
 *   not-in-trash guard (NotInTrashError).
 * - Multi-select (10.3): call bulkApply(executor, accountId, selectedIds,
 *   action) instead of looping — it emits ONE onThreadListChanged event
 *   for the whole batch.
 * - Thread-list refresh: UI caches subscribe via
 *   onThreadListChanged(listener) rather than polling; the listener
 *   receives { action, accountId, threadIds }.
 *
 * Module layout: message-refs.ts builds the per-message queue addresses;
 * thread-actions.ts holds the action implementations, the typed errors
 * and the change hook.
 */

export * from "./message-refs"
export * from "./thread-actions"
