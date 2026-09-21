import { useEffect, useState, type KeyboardEvent, type Ref } from "react"
import { X } from "lucide-react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { ContactAvatar } from "@/components/contacts/contact-avatar"
import { searchContactsRanked, type ContactRow } from "@/services/db/contacts"
import { getExecutor } from "@/services/db/executor"
import type { Recipient } from "@/stores/composer-store"
import {
  isValidEmail,
  parseRecipients,
  recipientLabel,
} from "./address-validation"

/**
 * Chips recipient field for the composer (task 8.1) with contact
 * autocomplete (task 8.3). The raw input accepts comma/semicolon/space
 * separated addresses (plus the `Name <a@b.com>` display-name form);
 * tokens are parsed into chips on Enter, comma, semicolon, Tab or blur.
 * Per-chip validity is computed here — NOT in the store (the store keeps
 * raw input): invalid chips get the destructive token outline,
 * `data-invalid`, a native-tooltip title and a screen-reader hint,
 * satisfying "invalid addresses visibly flagged before send".
 *
 * Autocomplete (8.3): the segment being composed (everything after the
 * last chip separator) is debounced ~150ms into
 * `searchContactsRanked(getExecutor(), accountId, text)` — the service
 * returns contacts best-first (interaction frequency, prefix matches
 * first, recency) and they render in that order in a listbox below the
 * field. Keyboard contract: ArrowUp/ArrowDown move the highlight, Enter
 * and Tab accept the highlighted contact as a chip, Escape closes the
 * list; clicking a suggestion accepts it. No suggestions while the active
 * text is already a complete, valid address — further input there will be
 * a separator, so a popover would only be noise. The commit path for
 * typed text is unchanged.
 */

/** Quiet period after the last keystroke before a suggestion query runs. */
const SUGGESTION_DEBOUNCE_MS = 150

/** How many ranked contacts to offer at once. */
const SUGGESTION_LIMIT = 8

interface RecipientFieldProps {
  /** Input id; the visible label renders to the left (htmlFor-linked). */
  id: string
  recipients: Recipient[]
  onChange: (recipients: Recipient[]) => void
  placeholder?: string
  /** Ref escape hatch so the composer can focus To on open (8.1). */
  inputRef?: Ref<HTMLInputElement>
  /** Account whose contacts power suggestions (8.3); null/undefined —
   * e.g. no active account — disables autocomplete entirely. */
  accountId?: string | null
}

/** The segment of `draft` currently being composed: everything after the
 * last chip separator, plus the committed prefix before it so accepting a
 * suggestion can splice the chip in without dropping earlier segments. */
function activeSegment(draft: string): { prefix: string; text: string } {
  const start = Math.max(draft.lastIndexOf(","), draft.lastIndexOf(";")) + 1
  return { prefix: draft.slice(0, start), text: draft.slice(start) }
}

export function RecipientField({
  id,
  recipients,
  onChange,
  placeholder,
  inputRef,
  accountId,
}: RecipientFieldProps) {
  const [draft, setDraft] = useState("")
  /** Results of the last completed suggestion query, tagged with the
   * query they answer so results for a superseded segment never render. */
  const [answered, setAnswered] = useState<{
    query: string
    rows: ContactRow[]
  } | null>(null)
  const [highlighted, setHighlighted] = useState(0)
  const suggestionListId = `${id}-suggestions`

  const { prefix, text: activeText } = activeSegment(draft)
  const query = activeText.trim()
  // A complete, valid address means this chip is done being typed — the
  // next character will be a separator, so no suggestions popover.
  const chipComplete = query !== "" && isValidEmail(query)

  useEffect(() => {
    if (!accountId || query === "" || chipComplete) return
    let cancelled = false
    const timer = setTimeout(() => {
      void searchContactsRanked(getExecutor(), accountId, query, {
        limit: SUGGESTION_LIMIT,
      })
        .then((rows) => {
          if (cancelled) return
          setAnswered({ query, rows })
          setHighlighted(0)
        })
        .catch(() => {
          // Suggesting is best-effort; never surface query failures here.
          if (!cancelled) setAnswered(null)
        })
    }, SUGGESTION_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [accountId, query, chipComplete])

  // Show the list only when the answers match the text being composed
  // right now (never for a superseded or finished segment).
  const suggestions =
    answered && answered.query === query && answered.rows.length > 0
      ? answered.rows
      : null

  const commit = () => {
    const parsed = parseRecipients(draft)
    if (parsed.length === 0) return
    onChange([...recipients, ...parsed])
    setDraft("")
  }

  const acceptSuggestion = (row: ContactRow) => {
    onChange([
      ...recipients,
      row.name ? { name: row.name, email: row.email } : { email: row.email },
    ])
    // Splice out only the composed segment; earlier pending text stays.
    setDraft(prefix)
    setAnswered(null)
  }

  const highlightedSuggestion =
    suggestions && suggestions.length > 0
      ? suggestions[Math.min(highlighted, suggestions.length - 1)]
      : null

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (suggestions && suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setHighlighted((index) => (index + 1) % suggestions.length)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setHighlighted(
          (index) => (index - 1 + suggestions.length) % suggestions.length
        )
        return
      }
      if (event.key === "Enter") {
        event.preventDefault()
        if (highlightedSuggestion) acceptSuggestion(highlightedSuggestion)
        return
      }
      if (event.key === "Tab") {
        // Accept the highlighted contact, then let focus move on naturally.
        if (highlightedSuggestion) acceptSuggestion(highlightedSuggestion)
        return
      }
      if (event.key === "Escape") {
        setAnswered(null)
        return
      }
    }
    if (event.key === "Enter" || event.key === "," || event.key === ";") {
      event.preventDefault()
      commit()
      return
    }
    if (event.key === "Tab") {
      // Finalize pending text but let focus move on naturally.
      commit()
      return
    }
    if (event.key === "Backspace" && draft === "" && recipients.length > 0) {
      onChange(recipients.slice(0, -1))
    }
  }

  return (
    <div className="relative flex min-h-8 flex-1 flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-2 py-1 text-sm transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
      {recipients.map((recipient, index) => {
        const invalid = !isValidEmail(recipient.email)
        const chipLabel = recipientLabel(recipient)
        return (
          <span
            key={`${recipient.email}-${index}`}
            data-invalid={invalid || undefined}
            title={
              invalid ? `${chipLabel} is not a valid email address` : chipLabel
            }
            className={cn(
              "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
              invalid
                ? "border-destructive bg-destructive/10 text-destructive"
                : "border-border bg-muted text-foreground"
            )}
          >
            {/* Task 2.5 (spec contacts "Contact avatars"): avatar on
                valid chips only — invalid text is not an address and
                must never be probed against gravatar.com. The component
                itself stays inert (initials or nothing) while the
                setting is off. */}
            {!invalid && (
              <ContactAvatar
                email={recipient.email}
                name={recipient.name}
                className="size-4 shrink-0"
              />
            )}
            <span className="truncate">{chipLabel}</span>
            {invalid ? (
              <span className="sr-only">(invalid address)</span>
            ) : null}
            <button
              type="button"
              aria-label={`Remove ${chipLabel}`}
              onClick={() => onChange(recipients.filter((_, i) => i !== index))}
              className="shrink-0 rounded-sm p-0.5 outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </span>
        )
      })}
      <Input
        id={id}
        ref={inputRef}
        value={draft}
        role="combobox"
        aria-expanded={suggestions !== null}
        aria-controls={suggestionListId}
        aria-autocomplete="list"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          commit()
          setAnswered(null)
        }}
        placeholder={recipients.length === 0 ? placeholder : undefined}
        autoComplete="off"
        className="h-auto min-w-24 flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-sm focus-visible:ring-0 dark:bg-transparent"
      />
      {suggestions && suggestions.length > 0 ? (
        <div
          id={suggestionListId}
          role="listbox"
          aria-label="Contact suggestions"
          className="absolute top-full left-0 z-50 mt-1 flex max-h-56 w-72 min-w-full flex-col overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          {suggestions.map((row, index) => (
            <button
              key={row.id}
              type="button"
              role="option"
              aria-selected={index === highlighted}
              // Keep input focus on mousedown so blur-commit doesn't run
              // before the click accepts the suggestion.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => acceptSuggestion(row)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1 text-start outline-none",
                index === highlighted
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-muted"
              )}
            >
              {/* Task 2.5 (spec contacts "Contact avatars"): the same
                  avatar as everywhere else — initials until the setting
                  is on and a Gravatar resolves. */}
              <ContactAvatar
                email={row.email}
                name={row.name}
                className="size-6 shrink-0"
              />
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-sm">
                  {row.name ?? row.email}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {row.email}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
