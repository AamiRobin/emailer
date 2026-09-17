import { useEffect, useRef } from "react"
import type { FormEvent } from "react"
import { SearchIcon, XIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useUiStore } from "@/stores/ui-store"
import { CreateFilterButton } from "./create-filter-button"
import { SaveAsSplitButton } from "./save-as-split-button"
import { SaveSearchButton } from "./save-search-button"

/**
 * The list-header search field (task 9.2, mail-search spec "Search
 * results presentation"). Enter submits the typed query as a
 * {kind:"search"} view — ui-store records the prior non-search view, so
 * clearing restores it — and while a search view is active the query
 * shows as a chip with a clear action next to the input. The input
 * mirrors the active query, so searches started from the palette
 * ("Search mail") appear here too, and leaving the search view (via the
 * chip, a folder click or a new search) resets the field. Everything is
 * in-memory: submitting and clearing work offline against the local
 * index.
 *
 * The input is deliberately uncontrolled: the draft never enters React
 * state, so no effect needs to push store state back into it (lint rule
 * react-hooks/set-state-in-effect) — submit reads the DOM value, and the
 * one effect below keeps the DOM value in step with the active query.
 */
export function SearchField({ className }: { className?: string }) {
  const view = useUiStore((state) => state.view)
  const setView = useUiStore((state) => state.setView)
  const clearSearch = useUiStore((state) => state.clearSearch)
  const activeQuery = view.kind === "search" ? view.query : null
  const inputRef = useRef<HTMLInputElement>(null)

  // Keep the field in step with the active search: it shows the query of
  // a search started anywhere (palette, keyboard) and clears when the
  // mailbox leaves the search view. Uncontrolled input → write the DOM
  // value directly.
  useEffect(() => {
    const input = inputRef.current
    if (input && input.value !== (activeQuery ?? "")) {
      input.value = activeQuery ?? ""
    }
  }, [activeQuery])

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const query = new FormData(event.currentTarget)
      .get("search-query")
      ?.toString()
      .trim()
    // An empty submit is a no-op — a search view with no usable terms
    // would render an empty result for no reason (searchThreadsQuery
    // returns [] for empty queries).
    if (!query) return
    setView({ kind: "search", query })
  }

  return (
    <form
      role="search"
      data-testid="mail-search"
      className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
      onSubmit={submit}
    >
      <div className="relative min-w-0 flex-1">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          name="search-query"
          // Static: a query-dependent defaultValue would flip the prop on an
          // uncontrolled input (React warning). The effect below owns the
          // DOM value; this only seeds the initial render.
          defaultValue=""
          placeholder="Search mail…"
          aria-label="Search mail"
          autoComplete="off"
          className="ps-8"
        />
      </div>
      {activeQuery !== null && (
        <>
          <SaveSearchButton query={activeQuery} />
          <CreateFilterButton query={activeQuery} />
          <SaveAsSplitButton query={activeQuery} />
          <Badge
            variant="secondary"
            data-testid="search-query-chip"
            className="h-6 max-w-56 gap-0.5 ps-2.5"
          >
            <span className="truncate">{activeQuery}</span>
            <button
              type="button"
              aria-label="Clear search"
              onClick={clearSearch}
              className="rounded-full p-1 hover:bg-accent"
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          </Badge>
        </>
      )}
    </form>
  )
}
