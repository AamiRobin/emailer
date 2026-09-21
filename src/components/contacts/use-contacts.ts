import { useEffect, useState } from "react"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import {
  deleteContact,
  getContact,
  listAllContacts,
  listContactThreads,
  updateContact,
  type ContactRow,
} from "@/services/db/contacts"
import {
  deleteCarddavContact,
  pushContactEdit,
} from "@/services/contacts/carddav"
import type { ThreadRow } from "@/services/db/threads"
import { useComposerStore } from "@/stores/composer-store"
import { useUiStore } from "@/stores/ui-store"

/**
 * Contacts-browser data plumbing (task 20.2, contacts spec) — the
 * use-saved-searches.ts / use-todos.ts pattern: an injectable SqlExecutor
 * for tests plus a module-level notify seam. The components live in
 * contacts-browser.tsx and contact-detail.tsx.
 *
 * Every mutation flow funnels through here so the DB write, the notify
 * and any follow-up stay in lockstep:
 * - renameContact / saveContactNotes (the detail's display-name and
 *   notes editors): explicit local edits that never touch mail history.
 * - deleteContactById (the detail's confirmed delete): removes the
 *   address-book row ONLY — messages are untouched, and the contact
 *   reappears automatically on the next correspondence (the normal
 *   upsert/interaction paths).
 * - composeToContact (the detail's Compose action): configures the
 *   composer store FIRST — openNew already sets composer-store.open and
 *   carries the contact's OWNING account, so the compose uses the
 *   identity the correspondence belongs to (the openTodoThread
 *   cross-account philosophy; no account switch) — then flips the shell
 *   flag. MailShell's bridge effect never clobbers an already-open
 *   composer store (reply-opener's ordering contract).
 * - openRelatedThread (a related-thread row click): returns to the
 *   mailbox view the user came from (previousView — the contacts view is
 *   never recorded as previousView) and opens the thread, which the
 *   reading pane resolves from its owning account itself.
 *
 * The list is CROSS-ACCOUNT by design (like the Todos sidebar section):
 * listAllContacts aggregates every known contact, so the hook needs no
 * account id — it reloads on mount, on notifyContactsChanged() and on
 * every search-text change (the local query is fast enough to narrow
 * immediately, per the contacts spec's search scenario).
 */

let browserExecutorOverride: SqlExecutor | null = null

function resolveExecutor(): SqlExecutor {
  return browserExecutorOverride ?? getExecutor()
}

/** Test hook: run the browser's queries against `executor` (node:sqlite
 * under vitest); pass null to restore the production getExecutor()
 * binding. */
export function setContactsBrowserExecutor(executor: SqlExecutor | null): void {
  browserExecutorOverride = executor
}

// ---- Refresh seam: the edit/delete flows notify subscribers after their
// mutation so the browser re-queries SQLite. The registry lives in its
// own module (./contacts-changed) so surfaces that only NOTIFY — the
// settings address-book section — do not have to import this module (its
// composer-store import would drag the send chain into the settings
// graph; design D11). notifyContactsChanged is re-exported here for the
// existing callers. ----

import {
  notifyContactsChanged,
  subscribeContactsChanged,
} from "./contacts-changed"

// Re-exported for the existing callers (the browser tests notify through
// this module's seam).
export { notifyContactsChanged }

/**
 * Every known contact across ALL accounts, most recent correspondence
 * first, narrowed to `query` when non-empty; DB failures render an empty
 * list. Reloads on mount, on notifyContactsChanged() and on query change.
 */
export function useContacts(query: string): ContactRow[] {
  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [revision, setRevision] = useState(0)
  useEffect(() => subscribeContactsChanged(() => setRevision((value) => value + 1)), [])
  useEffect(() => {
    let cancelled = false
    // The promise hop keeps the load (and the no-DB fallback —
    // resolveExecutor() throws outside Tauri) out of the effect body.
    Promise.resolve()
      .then(() => listAllContacts(resolveExecutor(), { query }))
      .then((rows) => {
        if (!cancelled) setContacts(rows)
      })
      .catch((error) => {
        // An unmounted browser discards the answer — late failures
        // (executor torn down by test cleanup, no DB at shutdown) are not
        // worth reporting.
        if (cancelled) return
        console.warn("[contacts-browser] failed to load contacts", error)
        setContacts([])
      })
    return () => {
      cancelled = true
    }
  }, [revision, query])
  return contacts
}

/**
 * The selected contact's related recent threads (the detail pane's list);
 * DB failures render an empty list. Reloads when the selection changes.
 */
export function useContactThreads(contact: ContactRow | null): ThreadRow[] {
  const contactId = contact?.id ?? null
  const accountId = contact?.account_id ?? null
  const email = contact?.email ?? null
  const [threads, setThreads] = useState<ThreadRow[]>([])
  useEffect(() => {
    let cancelled = false
    // The promise hop keeps the load (and the no-selection reset) out of
    // the effect body; resolveExecutor() throws outside Tauri.
    Promise.resolve()
      .then(() =>
        contactId && accountId && email
          ? listContactThreads(resolveExecutor(), accountId, email)
          : []
      )
      .then((rows) => {
        if (!cancelled) setThreads(rows)
      })
      .catch((error) => {
        // Same discard-on-unmount rule as useContacts above.
        if (cancelled) return
        console.warn("[contacts-browser] failed to load threads", error)
        setThreads([])
      })
    return () => {
      cancelled = true
    }
  }, [contactId, accountId, email])
  return threads
}

// ---- Mutation flows ----

/**
 * Apply an explicit display-name edit (the detail's rename). The local
 * row updates first; a CARDDAV-sourced contact then pushes the edit to
 * the server (last write wins on conflict — the Rust side refetches a
 * fresh ETag and re-PUTs the local version). Best-effort: failures are
 * logged and reported so the editor stays open; the next successful sync
 * converges either way.
 */
export async function renameContact(
  contactId: string,
  name: string
): Promise<boolean> {
  try {
    await updateContact(resolveExecutor(), contactId, { name })
    await pushContactEdit(resolveExecutor(), contactId, { name })
  } catch (error) {
    console.warn("[contacts-browser] rename failed", error)
    return false
  }
  notifyContactsChanged()
  return true
}

/**
 * Save free-form notes (the detail's notes editor). Same flow and
 * write-back contract as renameContact.
 */
export async function saveContactNotes(
  contactId: string,
  notes: string
): Promise<boolean> {
  try {
    await updateContact(resolveExecutor(), contactId, { notes })
    await pushContactEdit(resolveExecutor(), contactId, { notes })
  } catch (error) {
    console.warn("[contacts-browser] notes save failed", error)
    return false
  }
  notifyContactsChanged()
  return true
}

/**
 * Delete the contact (the detail's confirmed delete). For a CARDDAV-
 * sourced contact the server DELETE goes first — a failed push keeps the
 * row (a local-only delete would resurrect on the next sync); local
 * rows delete as before. Messages are never touched, and a local contact
 * reappears on the next correspondence (contacts spec "Contact
 * lifecycle").
 */
export async function deleteContactById(contactId: string): Promise<void> {
  try {
    const contact = await getContact(resolveExecutor(), contactId)
    if (contact?.source === "carddav") {
      // Server first; the row goes with it (or is kept on failure).
      await deleteCarddavContact(resolveExecutor(), contactId)
    } else {
      await deleteContact(resolveExecutor(), contactId)
    }
  } catch (error) {
    console.warn("[contacts-browser] delete failed", error)
    return
  }
  notifyContactsChanged()
}

/**
 * Start a new message addressed to the contact (the spec's compose-to:
 * "the composer opens with that contact in the To field"). One action —
 * see the module docstring for the bridge-ordering contract.
 */
export function composeToContact(contact: ContactRow): void {
  const composer = useComposerStore.getState()
  composer.openNew(contact.account_id)
  composer.setTo(
    contact.name
      ? [{ name: contact.name, email: contact.email }]
      : [{ email: contact.email }]
  )
  useUiStore.getState().setComposerOpen(true)
}

/**
 * Open one of the contact's related threads (a row click): back to the
 * mailbox view, then into the reading pane — which resolves the thread's
 * owning account itself (task 9.2 semantics, like the Todos rows).
 */
export function openRelatedThread(threadId: string): void {
  const ui = useUiStore.getState()
  ui.setView(ui.previousView)
  ui.setActiveThread(threadId)
}
