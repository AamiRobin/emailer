import { useMemo } from "react"
import { Check, ChevronDown, ChevronUp, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { AccountBadge } from "@/components/email/account-badge"
import type { PendingTodoItem } from "@/services/db/todos"
import { useAccountStore, type AccountInfo } from "@/stores/account-store"
import {
  completeTodoById,
  moveTodoById,
  openTodoThread,
  removeTodoById,
  useTodos,
} from "./use-todos"
import { TodoRowMenu } from "./todo-row-menu"

/**
 * The Todos sidebar section (task 15.2, mail-organization spec "view
 * Todos in a dedicated sidebar section across accounts"): every pending
 * todo from ALL accounts in the manual list order, each row showing the
 * thread's subject with its owning account's badge (the rows are
 * cross-account, so identity travels with the row like in the unified
 * inbox). Row actions: check = complete (the row leaves the list; the
 * row's ⋯ menu offers "complete and mark thread done" as the optional
 * done-marking), hover arrows reorder, X removes. A row click opens the
 * thread in the reading pane (which resolves the owning account itself,
 * so no account switch happens).
 *
 * Renders only while pending todos exist, and — like the Snoozed and
 * Saved Searches sections — yields to the icon rail (mounted expanded-
 * only by the sidebar). Completed rows stay in the `todos` table for
 * audit but are deliberately not listed (the list is an inventory of
 * pending work, like Snoozed). Data flows through useTodos
 * (./use-todos, the use-saved-searches.ts pattern).
 */
export function TodosSection() {
  const todos = useTodos()
  const accounts = useAccountStore((state) => state.accounts)
  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts]
  )
  if (todos.length === 0) return null
  return (
    <>
      <Separator />
      <nav
        aria-label="Todos"
        data-testid="todos-section"
        className="grid items-start gap-0.5 p-2"
      >
        <p className="px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Todos
        </p>
        {todos.map((todo, index) => (
          <TodoRow
            key={todo.id}
            todo={todo}
            isFirst={index === 0}
            isLast={index === todos.length - 1}
            account={accountById.get(todo.account_id) ?? null}
          />
        ))}
      </nav>
    </>
  )
}

function TodoRow({
  todo,
  isFirst,
  isLast,
  account,
}: {
  todo: PendingTodoItem
  isFirst: boolean
  isLast: boolean
  account: AccountInfo | null
}) {
  const subject = todo.subject || "(no subject)"
  return (
    <div
      data-testid="todo-row"
      data-todo-id={todo.id}
      className="group/todo flex w-full items-center gap-0.5 rounded-md pr-0.5 hover:bg-accent/50"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Complete todo ${subject}`}
        onClick={() => {
          void completeTodoById(todo.id)
        }}
      >
        <Check />
      </Button>
      <button
        type="button"
        title={todo.snippet ?? undefined}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-0.5 py-1 text-start"
        onClick={() => openTodoThread(todo.thread_id)}
      >
        {/* Cross-account identity (task 9.2's badge reused): the owning
            account travels with the row. */}
        {account && <AccountBadge account={account} />}
        <span className="min-w-0 truncate text-sm">{subject}</span>
      </button>
      <span
        className={cn(
          "flex shrink-0 items-center transition-opacity",
          "opacity-0 group-hover/todo:opacity-100 focus-within:opacity-100"
        )}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Move ${subject} up`}
          disabled={isFirst}
          onClick={() => {
            void moveTodoById(todo.id, -1)
          }}
        >
          <ChevronUp />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Move ${subject} down`}
          disabled={isLast}
          onClick={() => {
            void moveTodoById(todo.id, 1)
          }}
        >
          <ChevronDown />
        </Button>
      </span>
      <TodoRowMenu
        subject={subject}
        onCompleteMarkDone={() => {
          void completeTodoById(todo.id, { alsoMarkDone: true })
        }}
        onRemove={() => {
          void removeTodoById(todo.id)
        }}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${subject} from Todos`}
        onClick={() => {
          void removeTodoById(todo.id)
        }}
      >
        <X />
      </Button>
    </div>
  )
}
