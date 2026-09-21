import { useMemo, useState } from "react"
import { ArrowLeft, Search, Users } from "lucide-react"

import { cn } from "@/lib/utils"
import { AccountBadge } from "@/components/email/account-badge"
import { EmptyState } from "@/components/email/empty-state"
import { ContactAvatar } from "./contact-avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import type { ContactRow } from "@/services/db/contacts"
import { useAccountStore, type AccountInfo } from "@/stores/account-store"
import { formatRowTimestamp } from "@/stores/thread-list-store"
import { useUiStore } from "@/stores/ui-store"
import { ContactDetail } from "./contact-detail"
import { useContacts } from "./use-contacts"

/**
 * The Contacts browser (task 20.2, contacts spec): the address book view
 * behind the sidebar's Contacts entry — a searchable list of every known
 * contact across ALL accounts (each row carries its owning account's
 * badge, like the Todos section) beside the detail pane with editing,
 * notes, compose-to and the confirmed delete. Selected like the settings
 * view ({kind:"contacts"} in ui-store), so it replaces the mailbox panes
 * while the sidebar stays for navigation; the back control restores the
 * previousView the same way the settings page's does.
 *
 * The list is sorted by most recent correspondence (the db query's
 * ordering) and narrows immediately as the search field matches partial
 * names or emails. Selection is by row id; a selected row that the
 * search filters out simply hides the detail pane until the text clears.
 */
export function ContactsBrowser() {
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const contacts = useContacts(query)
  const accounts = useAccountStore((state) => state.accounts)
  const setView = useUiStore((state) => state.setView)
  const previousView = useUiStore((state) => state.previousView)
  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts]
  )
  const selected = contacts.find((contact) => contact.id === selectedId) ?? null

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="contacts-browser"
    >
      <div className="flex items-center gap-1 px-4 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Back to mailbox"
          onClick={() => setView(previousView)}
        >
          <ArrowLeft />
          Back
        </Button>
        <h1 className="truncate text-xl font-bold text-foreground">Contacts</h1>
      </div>
      <Separator />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 w-80 shrink-0 flex-col border-r">
          <div className="p-2">
            <div className="relative">
              <Search
                aria-hidden
                className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Search contacts"
                data-testid="contacts-search"
                value={query}
                placeholder="Search by name or email"
                className="pl-8"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {contacts.length === 0 ? (
              query.trim() === "" ? (
                <EmptyState
                  icon={Users}
                  title="No contacts yet"
                  hint="People you exchange mail with appear here automatically."
                />
              ) : (
                <EmptyState
                  icon={Search}
                  title={`No contacts match “${query.trim()}”`}
                  hint="Search matches partial names and email addresses."
                />
              )
            ) : (
              <ul className="grid gap-0.5 p-1">
                {contacts.map((contact) => (
                  <li key={contact.id}>
                    <ContactRowButton
                      contact={contact}
                      account={accountById.get(contact.account_id) ?? null}
                      selected={contact.id === selectedId}
                      onSelect={() => setSelectedId(contact.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>
        <div className="min-h-0 flex-1">
          {selected ? (
            <ContactDetail
              key={selected.id}
              contact={selected}
              account={accountById.get(selected.account_id) ?? null}
              onDeleted={() => setSelectedId(null)}
            />
          ) : (
            <EmptyState
              icon={Users}
              title={
                contacts.length === 0 ? "No contacts yet" : "Select a contact"
              }
              hint={
                contacts.length === 0
                  ? "People you exchange mail with appear here automatically."
                  : "Choose someone from the list to see their details."
              }
            />
          )}
        </div>
      </div>
    </div>
  )
}

function ContactRowButton({
  contact,
  account,
  selected,
  onSelect,
}: {
  contact: ContactRow
  account: AccountInfo | null
  selected: boolean
  onSelect: () => void
}) {
  const displayName = contact.name ?? contact.email
  return (
    <button
      type="button"
      data-testid="contact-row"
      data-contact-id={contact.id}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start transition-colors hover:bg-accent/50",
        selected && "bg-accent"
      )}
      onClick={onSelect}
    >
      {/* Task 2.5 (spec contacts "Contact avatars"): Gravatar when the
          setting is on and one exists, deterministic initials otherwise;
          the component performs no fetches at all while the setting is
          off. */}
      <ContactAvatar
        email={contact.email}
        name={contact.name}
        className="size-8 shrink-0"
      />
      <span className="grid min-w-0 flex-1 gap-0">
        <span className="truncate text-sm font-medium">{displayName}</span>
        <span className="truncate text-xs text-muted-foreground">
          {contact.email}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        {account && <AccountBadge account={account} />}
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatRowTimestamp(contact.last_interaction_at)}
        </span>
      </span>
    </button>
  )
}
