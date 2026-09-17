import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import {
  addTodo,
  completeTodo,
  listPendingTodos,
  moveTodo,
  removeTodo,
  type PendingTodoItem,
} from "@/services/db/todos"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import { refreshThreadList } from "@/stores/thread-list-store"
import { useUiStore } from "@/stores/ui-store"

/**
 * Todos-section data plumbing (task 15.2) — the use-saved-searches.ts
 * pattern: an injectable SqlExecutor for tests plus a module-level notify
 * seam. The component lives in todos-section.tsx.
 *
 * Every mutation flow funnels through here (like the snooze/saved-search
 * flows) so the DB write, the notify and any follow-up refresh stay in
 * lockstep:
 * - addThreadToTodos (the reading-pane toolbar's "Add to Todos"): UNIQUE
 *   (thread_id) makes re-adding a benign "move to bottom" (see
 *   services/db/todos.ts), so the button never needs disabling.
 * - completeTodoById (the section row's check button; optional
 *   alsoMarkDone from the row's ⋯ menu): completed rows stay in the
 *   table (audit) and leave the list; marking the thread done ALSO moves
 *   it out of the inbox, so that variant refreshes the list + badges.
 * - removeTodoById (X) and moveTodoById (the reorder arrows).
 * - openTodoThread (row click): sets ui-store activeThread — the reading
 *   pane loads the thread from its OWNING account (task 9.2 semantics),
 *   so a cross-account todo opens without an account switch, exactly
 *   like opening a unified-inbox row.
 *
 * The list is CROSS-ACCOUNT by design (mail-organization spec "Todos…
 * across accounts"): listPendingTodos aggregates every pending todo, so
 * the hook needs no account id — it reloads on mount and on
 * notifyTodosChanged().
 */

let sectionExecutorOverride: SqlExecutor | null = null

function resolveExecutor(): SqlExecutor {
  return sectionExecutorOverride ?? getExecutor()
}

/** Test hook: run the section's queries against `executor` (node:sqlite
 * under vitest); pass null to restore the production getExecutor()
 * binding. */
export function setTodosSectionExecutor(executor: SqlExecutor | null): void {
  sectionExecutorOverride = executor
}

// ---- Refresh seam: the add/complete/remove/move flows notify subscribers
// after their mutation so the section re-queries SQLite. ----

const todosChangedListeners = new Set<() => void>()

/** Tell useTodos subscribers to re-query the pending todos. */
export function notifyTodosChanged(): void {
  for (const listener of todosChangedListeners) listener()
}

/**
 * All pending todos across accounts, in list order; DB failures render an
 * empty list. Reloads on mount and on notifyTodosChanged().
 */
export function useTodos(): PendingTodoItem[] {
  const [todos, setTodos] = useState<PendingTodoItem[]>([])
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const invalidate = (): void => setRevision((value) => value + 1)
    todosChangedListeners.add(invalidate)
    return () => {
      todosChangedListeners.delete(invalidate)
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    // The promise hop keeps the load (and the no-DB fallback —
    // resolveExecutor() throws outside Tauri) out of the effect body.
    Promise.resolve()
      .then(() => listPendingTodos(resolveExecutor()))
      .then((rows) => {
        if (!cancelled) setTodos(rows)
      })
      .catch((error) => {
        console.warn("[todos-section] failed to load todos", error)
        if (!cancelled) setTodos([])
      })
    return () => {
      cancelled = true
    }
  }, [revision])
  return todos
}

// ---- Mutation flows ----

/**
 * Add a thread to Todos (the reading-pane toolbar entry) and notify the
 * section. Idempotent by the service's UNIQUE(thread_id) semantics:
 * re-adding moves the thread to the bottom (and re-activates a completed
 * row) instead of erroring. Best-effort: failures are logged.
 */
export async function addThreadToTodos(
  accountId: string,
  threadId: string
): Promise<void> {
  try {
    await addTodo(resolveExecutor(), accountId, threadId)
  } catch (error) {
    console.warn("[todos-section] add failed", error)
    return
  }
  notifyTodosChanged()
  toast.success("Added to Todos")
}

/**
 * Complete a todo (the section row's check button). With `alsoMarkDone`
 * the thread's own Done state is stamped too — since done moves the
 * thread out of the inbox, that variant also refreshes the thread list
 * and the folder badges (best-effort, like the other local-state flows).
 */
export async function completeTodoById(
  todoId: string,
  options?: { alsoMarkDone?: boolean }
): Promise<void> {
  try {
    await completeTodo(resolveExecutor(), todoId, options)
  } catch (error) {
    console.warn("[todos-section] complete failed", error)
    return
  }
  notifyTodosChanged()
  if (options?.alsoMarkDone) {
    await Promise.all([
      refreshThreadList(),
      useFolderCountsStore.getState().refreshFolderCounts(),
    ]).then(() => undefined)
  }
}

/** Remove a todo (the section row's X button). The thread is untouched. */
export async function removeTodoById(todoId: string): Promise<void> {
  try {
    await removeTodo(resolveExecutor(), todoId)
  } catch (error) {
    console.warn("[todos-section] remove failed", error)
    return
  }
  notifyTodosChanged()
}

/** Move a todo one slot up/down (the section row's reorder arrows). */
export async function moveTodoById(
  todoId: string,
  direction: -1 | 1
): Promise<void> {
  try {
    await moveTodo(resolveExecutor(), todoId, direction)
  } catch (error) {
    console.warn("[todos-section] move failed", error)
    return
  }
  notifyTodosChanged()
}

/**
 * Open a todo's thread in the reading pane (row click): one ui-store
 * write. Cross-account todos need no account switch — the reading pane
 * resolves the thread's owning account itself (task 9.2).
 */
export function openTodoThread(threadId: string): void {
  useUiStore.getState().setActiveThread(threadId)
}
