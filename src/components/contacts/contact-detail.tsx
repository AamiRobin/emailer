import { useState } from "react"
import { Check, Pencil, SquarePen, Trash2, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { AccountBadge } from "@/components/email/account-badge"
import {
  getInitials,
  avatarTokenClass,
  formatFullTimestamp,
} from "@/components/email/message-utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import type { ContactRow } from "@/services/db/contacts"
import type { AccountInfo } from "@/stores/account-store"
import { formatRowTimestamp } from "@/stores/thread-list-store"
import { ContactDeleteDialog } from "./contact-delete-dialog"
import {
  composeToContact,
  openRelatedThread,
  renameContact,
  saveContactNotes,
  useContactThreads,
} from "./use-contacts"

/**
 * The contact detail pane (task 20.2, contacts spec "Contact detail and
 * editing"): the contact's display name, email address, owning account,
 * correspondence count, last-contacted date and related recent threads —
 * plus the editable display name, free-form notes, the compose-to action
 * and the confirmed delete. Edits are explicit local writes (the flows in
 * ./use-contacts) and never alter mail history. Threads are display rows
 * too: clicking one returns to the mailbox view the user came from and
 * opens the thread in the reading pane.
 */

/** The display name shown everywhere for the contact (email fallback). */
function contactDisplayName(contact: ContactRow): string {
  return contact.name ?? contact.email
}

interface ContactDetailProps {
  contact: ContactRow
  account: AccountInfo | null
  onDeleted: () => void
}

export function ContactDetail({
  contact,
  account,
  onDeleted,
}: ContactDetailProps) {
  const [deleting, setDeleting] = useState(false)
  const threads = useContactThreads(contact)
  const displayName = contactDisplayName(contact)

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="contact-detail"
      data-contact-id={contact.id}
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
          <div className="flex items-start gap-3">
            <AvatarBlock contact={contact} />
            <div className="grid min-w-0 flex-1 gap-0.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <NameEditor contact={contact} />
                <span className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Compose to ${displayName}`}
                    title={`Compose to ${displayName}`}
                    onClick={() => composeToContact(contact)}
                  >
                    <SquarePen />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete contact ${displayName}`}
                    title={`Delete contact ${displayName}`}
                    onClick={() => setDeleting(true)}
                  >
                    <Trash2 />
                  </Button>
                </span>
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {contact.email}
              </p>
              {account && (
                <p
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  title={`Known to ${account.email}`}
                >
                  <AccountBadge account={account} />
                  <span className="truncate">{account.email}</span>
                </p>
              )}
            </div>
          </div>
          <CorrespondenceStats contact={contact} />
          <Separator />
          <NotesEditor contact={contact} />
          <Separator />
          <RelatedThreads threads={threads} />
        </div>
      </ScrollArea>
      {deleting && (
        <ContactDeleteDialog
          key={contact.id}
          contact={contact}
          onDeleted={onDeleted}
          onOpenChange={(open) => {
            if (!open) setDeleting(false)
          }}
        />
      )}
    </div>
  )
}

function AvatarBlock({ contact }: { contact: ContactRow }) {
  const initials = getInitials(contact.name, contact.email)
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-medium",
        avatarTokenClass(contact.email)
      )}
    >
      {initials}
    </span>
  )
}

/**
 * The display-name editor (the spec's "Edit a display name" scenario): a
 * pencil toggles an inline input; saving is an explicit renameContact
 * flow whose write the upsert fill policy preserves against later
 * correspondence (the stored name only changes on an explicit edit).
 */
function NameEditor({ contact }: { contact: ContactRow }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(contact.name ?? "")
  const [saving, setSaving] = useState(false)

  // Entering edit mode reseeds the draft from the stored name, so
  // external changes (the notify reload after a save) are always picked
  // up without a state-sync effect.
  const start = () => {
    setDraft(contact.name ?? "")
    setEditing(true)
  }

  const cancel = () => {
    setEditing(false)
  }

  const save = async () => {
    setSaving(true)
    const ok = await renameContact(contact.id, draft)
    setSaving(false)
    if (ok) setEditing(false)
  }

  if (editing) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <Input
          aria-label="Display name"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void save()
            }
            if (event.key === "Escape") {
              event.preventDefault()
              cancel()
            }
          }}
          className="h-7"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Save name"
          disabled={saving || draft.trim() === (contact.name ?? "")}
          onClick={() => {
            void save()
          }}
        >
          <Check />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Cancel name edit"
          onClick={cancel}
        >
          <X />
        </Button>
      </span>
    )
  }

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <h2 className="min-w-0 truncate text-lg font-semibold text-foreground">
        {contactDisplayName(contact)}
      </h2>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Rename ${contactDisplayName(contact)}`}
        title="Rename"
        onClick={start}
      >
        <Pencil />
      </Button>
    </span>
  )
}

function CorrespondenceStats({ contact }: { contact: ContactRow }) {
  return (
    <dl className="flex items-start gap-6 text-sm" aria-label="Correspondence">
      <div className="grid gap-0.5">
        <dt className="text-xs tracking-wide text-muted-foreground uppercase">
          Correspondence
        </dt>
        <dd className="font-medium text-foreground tabular-nums">
          {contact.interaction_count}{" "}
          {contact.interaction_count === 1 ? "message" : "messages"}
        </dd>
      </div>
      <div className="grid gap-0.5">
        <dt className="text-xs tracking-wide text-muted-foreground uppercase">
          Last contacted
        </dt>
        <dd className="font-medium text-foreground">
          {contact.last_interaction_at !== null
            ? formatFullTimestamp(contact.last_interaction_at)
            : "Never"}
        </dd>
      </div>
    </dl>
  )
}

/**
 * The free-form notes editor (contacts spec "free-form notes"): a plain
 * textarea whose explicit save runs saveContactNotes. Empty text clears
 * the stored notes (back to NULL).
 */
function NotesEditor({ contact }: { contact: ContactRow }) {
  // Draft state seeds from the stored notes; the browser keys this
  // component by contact id, so switching contacts remounts with fresh
  // state and a successful save's notify reload arrives with the exact
  // saved value (no state-sync effect needed).
  const [draft, setDraft] = useState(contact.notes ?? "")
  const [saving, setSaving] = useState(false)

  const saved = contact.notes ?? ""
  const dirty = draft !== saved

  const save = async () => {
    setSaving(true)
    // Best-effort: a failed write (logged in the flow) leaves the editor
    // open with the unsaved text.
    await saveContactNotes(contact.id, draft)
    setSaving(false)
  }

  return (
    <section className="grid gap-2" aria-label="Notes">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Notes
      </p>
      <Textarea
        aria-label="Contact notes"
        value={draft}
        placeholder="Add a private note about this contact…"
        rows={4}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => {
            void save()
          }}
        >
          Save notes
        </Button>
      </div>
    </section>
  )
}

/**
 * The contact's related recent threads (the spec's detail requirement):
 * subject + last-activity rows, most recent first (the db query's
 * ordering). Clicking a row returns to the mailbox and opens the thread.
 */
function RelatedThreads({
  threads,
}: {
  threads: ReturnType<typeof useContactThreads>
}) {
  return (
    <section className="grid gap-2" aria-label="Recent threads">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Recent threads
      </p>
      {threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No recent threads with this contact.
        </p>
      ) : (
        <ul className="grid gap-0.5">
          {threads.map((thread) => (
            <li key={thread.id}>
              <button
                type="button"
                data-testid="related-thread-row"
                data-thread-id={thread.id}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent"
                onClick={() => openRelatedThread(thread.id)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {thread.subject || "(no subject)"}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {formatRowTimestamp(thread.last_message_at)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
