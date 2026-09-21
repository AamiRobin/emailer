import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useAccountStore } from "@/stores/account-store"
import { listCarddavBooks } from "@/services/db/carddav-books"
import type { CarddavBook } from "@/services/db/carddav-books"
import {
  connectCarddavBook,
  discoverCarddavBooks,
  disconnectCarddavBook,
  syncCarddavBook,
} from "@/services/contacts/carddav"
import type { CarddavDiscoveredBook } from "@/services/contacts/carddav"
import { getExecutor } from "@/services/db/executor"
import { notifyContactsChanged } from "@/components/contacts/contacts-changed"

/**
 * Settings "Address book" section (parity-round-2 task 4.3, spec contacts
 * "CardDAV sync"): the CardDAV management surface. Lists the connected
 * address books with their status line (last sync, a READ-ONLY warning
 * when the server refused writes, a skipped-card warning when the last
 * pass could not project cards, and the last error), hosts the connect
 * form — server URL + username + app password (which is SEALED on this
 * device and never leaves it), discovery, per-book choice, connect (the
 * connect flow runs the initial pull so the server's contacts appear in
 * the address book immediately) — and the confirmed disconnect, which
 * removes the book AND its synced contacts.
 *
 * The sync bookkeeping lives on the book row (carddav_books), the
 * credentials in its sealed envelope; this component only orchestrates.
 */
export function AddressBookSection() {
  const [books, setBooks] = useState<CarddavBook[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [busyBookId, setBusyBookId] = useState<string | null>(null)
  const [bookNotice, setBookNotice] = useState<Record<string, string>>({})
  // The book pending disconnect (the dialog's host remounts state per
  // open — the contact-delete-dialog pattern).
  const [pendingDisconnect, setPendingDisconnect] =
    useState<CarddavBook | null>(null)

  // Connect form state.
  const [serverUrl, setServerUrl] = useState("")
  const [username, setUsername] = useState("")
  const [appPassword, setAppPassword] = useState("")
  const [discoverState, setDiscoverState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; books: CarddavDiscoveredBook[] }
    | { status: "error"; message: string }
  >({ status: "idle" })
  const [selectedBookHref, setSelectedBookHref] = useState<string | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  // Set once the user edits anything: the async initial load must never
  // clobber in-progress form state (reading-section pattern).
  const touchedRef = useRef(false)

  const accounts = useAccountStore((state) => state.accounts)
  const [accountId, setAccountId] = useState<string | null>(null)
  const selectedAccountId = accounts.some((account) => account.id === accountId)
    ? accountId
    : (accounts[0]?.id ?? null)

  async function refreshBooks() {
    try {
      setBooks(await listCarddavBooks(getExecutor()))
      setListError(null)
    } catch {
      setListError("Address books could not be loaded.")
    }
  }

  useEffect(() => {
    // Initial load (every setState inside promise callbacks —
    // getExecutor() may throw before boot).
    void Promise.resolve()
      .then(() => listCarddavBooks(getExecutor()))
      .then((rows) => {
        setBooks(rows)
        setListError(null)
      })
      .catch(() => {
        setListError("Address books could not be loaded.")
      })
  }, [])

  function formCredentials() {
    return {
      serverUrl: serverUrl.trim(),
      username: username.trim(),
      appPassword,
    }
  }

  function formComplete(): boolean {
    const { serverUrl: url, username: user, appPassword: pass } =
      formCredentials()
    return url !== "" && user !== "" && pass !== ""
  }

  async function handleDiscover() {
    setDiscoverState({ status: "loading" })
    try {
      const found = await discoverCarddavBooks(formCredentials())
      setDiscoverState({ status: "ready", books: found })
      setSelectedBookHref(found[0]?.href ?? null)
    } catch (error) {
      setDiscoverState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Discovery failed on the server.",
      })
    }
  }

  async function handleConnect() {
    if (discoverState.status !== "ready") return
    if (!selectedAccountId) {
      setConnectError("Connect a mail account first; synced contacts live in an account's address book.")
      return
    }
    const book =
      discoverState.books.find((entry) => entry.href === selectedBookHref) ??
      null
    if (!book) {
      setConnectError("Choose an address book to sync.")
      return
    }
    setConnecting(true)
    try {
      const stored = await connectCarddavBook(getExecutor(), {
        ...formCredentials(),
        accountId: selectedAccountId,
        book,
      })
      // The connect scenario: the server's contacts appear in the
      // address book — run the initial pull right away.
      const result = await syncCarddavBook(getExecutor(), stored)
      setBookNotice((previous) => ({
        ...previous,
        [stored.id]:
          result.skipped > 0
            ? `Synced with ${result.skipped} card${result.skipped === 1 ? "" : "s"} skipped.`
            : `Synced — ${result.stored} contact${result.stored === 1 ? "" : "s"}.`,
      }))
      notifyContactsChanged()
      // Connected: reset the form and show the new book.
      touchedRef.current = false
      setServerUrl("")
      setUsername("")
      setAppPassword("")
      setDiscoverState({ status: "idle" })
      setSelectedBookHref(null)
      setConnectError(null)
      await refreshBooks()
    } catch (error) {
      setConnectError(
        error instanceof Error ? error.message : "Connecting failed."
      )
      // The stored book may exist with a failed initial pull — keep it
      // listed (its status line carries the error; "Sync now" retries).
      await refreshBooks()
    } finally {
      setConnecting(false)
    }
  }

  // Discovery doubles as the connection test: it exercises the full
  // authenticated chain and reports specific failures (including the
  // typed needs-reauth error for rejected credentials).

  async function handleSyncNow(book: CarddavBook) {
    setBusyBookId(book.id)
    try {
      const result = await syncCarddavBook(getExecutor(), book)
      setBookNotice((previous) => ({
        ...previous,
        [book.id]:
          result.mode === "unchanged"
            ? "Already up to date."
            : result.skipped > 0
              ? `Synced with ${result.skipped} card${result.skipped === 1 ? "" : "s"} skipped.`
              : `Synced — ${result.stored} new or changed, ${result.removed} removed.`,
      }))
      notifyContactsChanged()
      await refreshBooks()
    } catch (error) {
      setBookNotice((previous) => ({
        ...previous,
        [book.id]:
          error instanceof Error ? error.message : "The sync failed.",
      }))
      await refreshBooks()
    } finally {
      setBusyBookId(null)
    }
  }

  async function handleConfirmDisconnect() {
    if (!pendingDisconnect) return
    setBusyBookId(pendingDisconnect.id)
    try {
      await disconnectCarddavBook(getExecutor(), pendingDisconnect.id)
      notifyContactsChanged()
      setPendingDisconnect(null)
      await refreshBooks()
    } catch {
      setListError(
        `The book "${pendingDisconnect.name}" could not be disconnected.`
      )
    } finally {
      setBusyBookId(null)
    }
  }

  function accountEmail(id: string | null): string {
    return accounts.find((account) => account.id === id)?.email ?? ""
  }

  // Local timestamp formatting on purpose: pulling the thread-list
  // store's formatter here would drag the composer send chain into the
  // settings page's static graph (the design D11 lazy-load guard).
  function statusLine(book: CarddavBook): string {
    if (book.lastError) return `Last sync failed: ${book.lastError}`
    if (book.lastSyncedAt === null) return "Not synced yet"
    const formatted = new Date(book.lastSyncedAt * 1000).toLocaleString(
      undefined,
      { dateStyle: "medium", timeStyle: "short" }
    )
    return `Last synced ${formatted}`
  }

  return (
    <section aria-label="Address book" className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Address book
        </h2>
        <p className="text-sm text-muted-foreground">
          Sync a CardDAV address book with your contacts. Synced contacts
          appear, search, and edit exactly like local ones.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {listError !== null && (
          <p role="alert" className="text-sm text-destructive">
            {listError}
          </p>
        )}
        {books.length === 0 && listError === null && (
          <p className="text-sm text-muted-foreground">
            No address books connected yet.
          </p>
        )}
        {books.map((book) => (
          <div
            key={book.id}
            data-testid="carddav-book-row"
            className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2"
          >
            <div className="grid min-w-0 gap-0.5">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {book.name}
                </span>
                {book.readOnly && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    Read-only
                  </span>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {accountEmail(book.accountId)}
              </p>
              <p className="text-xs text-muted-foreground">
                {statusLine(book)}
              </p>
              {(book.lastSkipped ?? 0) > 0 && (
                <p role="status" className="text-xs text-amber-600">
                  {book.lastSkipped} card{book.lastSkipped === 1 ? "" : "s"}{" "}
                  could not be read and were skipped.
                </p>
              )}
              {bookNotice[book.id] && (
                <p role="status" className="text-xs text-muted-foreground">
                  {bookNotice[book.id]}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={busyBookId === book.id}
                aria-label={`Sync ${book.name}`}
                onClick={() => {
                  void handleSyncNow(book)
                }}
              >
                {busyBookId === book.id && (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                )}
                Sync now
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Disconnect ${book.name}`}
                onClick={() => setPendingDisconnect(book)}
              >
                Disconnect
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-border p-4">
        <div className="grid gap-0.5">
          <h3 className="text-sm font-semibold text-foreground">
            Connect a CardDAV server
          </h3>
          <p className="text-xs text-muted-foreground">
            Server URL, username and app password. The password is sealed
            on this device and never leaves it.
          </p>
        </div>
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Connect a mail account first — synced contacts live in an
            account&apos;s address book.
          </p>
        ) : (
          <>
            {accounts.length > 1 && (
              <div className="grid gap-1.5">
                <Label htmlFor="carddav-account">Account</Label>
                <Select
                  value={selectedAccountId ?? undefined}
                  onValueChange={setAccountId}
                >
                  <SelectTrigger id="carddav-account">
                    <SelectValue placeholder="Choose an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="carddav-server-url">Server URL</Label>
              <Input
                id="carddav-server-url"
                placeholder="https://dav.example.com/"
                value={serverUrl}
                onChange={(event) => {
                  touchedRef.current = true
                  setServerUrl(event.target.value)
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="carddav-username">Username</Label>
              <Input
                id="carddav-username"
                autoComplete="off"
                value={username}
                onChange={(event) => {
                  touchedRef.current = true
                  setUsername(event.target.value)
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="carddav-app-password">App password</Label>
              <Input
                id="carddav-app-password"
                type="password"
                autoComplete="new-password"
                value={appPassword}
                onChange={(event) => {
                  touchedRef.current = true
                  setAppPassword(event.target.value)
                }}
              />
            </div>
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  !formComplete() || discoverState.status === "loading"
                }
                onClick={() => {
                  void handleDiscover()
                }}
              >
                Discover address books
              </Button>
            </div>
            {discoverState.status === "error" && (
              <p role="alert" className="text-sm text-destructive">
                {discoverState.message}
              </p>
            )}
            {discoverState.status === "ready" &&
              (discoverState.books.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  The server exposes no address books.
                </p>
              ) : (
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-sm font-medium text-foreground">
                    Address book to sync
                  </legend>
                  {discoverState.books.map((book) => (
                    <label
                      key={book.href}
                      className="flex items-center gap-2 text-sm text-foreground"
                    >
                      <input
                        type="radio"
                        name="carddav-book"
                        value={book.href}
                        checked={selectedBookHref === book.href}
                        onChange={() => setSelectedBookHref(book.href)}
                      />
                      {book.displayName ?? book.href}
                      {book.readOnly === true && (
                        <span className="text-xs text-muted-foreground">
                          (read-only)
                        </span>
                      )}
                    </label>
                  ))}
                </fieldset>
              ))}
            {connectError !== null && (
              <p role="alert" className="text-sm text-destructive">
                {connectError}
              </p>
            )}
            <div>
              <Button
                size="sm"
                disabled={discoverState.status !== "ready" || connecting}
                onClick={() => {
                  void handleConnect()
                }}
              >
                {connecting && (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                )}
                Connect
              </Button>
            </div>
          </>
        )}
      </div>

      {pendingDisconnect && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingDisconnect(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Disconnect address book</DialogTitle>
              <DialogDescription>
                Disconnect{" "}
                <span className="font-medium">{pendingDisconnect.name}</span>?
                Its synced contacts are removed from this device — the
                contacts on the CardDAV server are not affected.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setPendingDisconnect(null)}
                disabled={busyBookId === pendingDisconnect.id}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                aria-label={`Confirm disconnecting ${pendingDisconnect.name}`}
                onClick={() => {
                  void handleConfirmDisconnect()
                }}
                disabled={busyBookId === pendingDisconnect.id}
              >
                {busyBookId === pendingDisconnect.id && (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                )}
                Disconnect
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
