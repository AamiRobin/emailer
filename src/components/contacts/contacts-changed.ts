/**
 * The contacts-changed refresh seam (parity-round-2): the tiny pub-sub
 * the address-book surfaces use to re-query SQLite after a mutation —
 * the sync service (CardDAV connect/sync/disconnect), the contacts
 * browser's edit/delete flows, and any other contact writer.
 *
 * This lives in its own module so surfaces like the settings page can
 * notify without importing the contacts browser's data plumbing
 * (use-contacts pulls the composer store, which drags the composer send
 * chain into the settings page's static graph — the design D11
 * lazy-load guard forbids that edge).
 */

const contactsChangedListeners = new Set<() => void>()

/** Tell useContacts subscribers to re-query the address book. */
export function notifyContactsChanged(): void {
  for (const listener of contactsChangedListeners) listener()
}

/** Subscribe to contact changes; returns the unsubscribe function. */
export function subscribeContactsChanged(listener: () => void): () => void {
  contactsChangedListeners.add(listener)
  return () => {
    contactsChangedListeners.delete(listener)
  }
}
