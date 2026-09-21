import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { AccountAttachmentRow } from "@/services/db/attachment-search"
import { listAccountAttachments } from "@/services/db/attachment-search"
import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import { getAccount, toEmailAccount } from "@/services/db/accounts"
import {
  getAttachmentContent,
  saveAttachmentAs,
  type AttachmentDeps,
  type FileActionDeps,
} from "@/services/attachments"
import { useUiStore } from "@/stores/ui-store"

/**
 * Attachments-browser data plumbing (task 3.7, design D14) — the
 * use-contacts.ts pattern: an injectable SqlExecutor for tests plus the
 * existing attachment service paths for content. No new storage and no
 * duplicated bytes: the list reads the existing attachment index
 * (listAccountAttachments), and every byte motion (preview, save) goes
 * through the existing cache/download + save-dialog services (task 7.5,
 * D15) exactly like the reading pane's attachment list.
 *
 * - useAccountAttachments: the CURRENT account's rows, newest message
 *   first; DB failures render an empty list. Reloads on mount and on
 *   every account switch (the browser is account-scoped).
 * - fetchAttachmentPreviewBytes: lazy bytes for one entry's inline
 *   preview (images/PDFs) via getAttachmentContent — server fetch on
 *   first access, the D15 disk cache afterwards.
 * - saveAttachmentToDisk: getAttachmentContent → saveAttachmentAs (OS
 *   save dialog + write; the dialog plugin widens the fs scope itself),
 *   with the app's sonner toast as the completion confirmation. Resolves
 *   "cancelled" when the user backs out of the dialog — not an error.
 */

let browserExecutorOverride: SqlExecutor | null = null

function resolveExecutor(): SqlExecutor {
  return browserExecutorOverride ?? getExecutor()
}

/** Test hook: run the browser's queries against `executor` (node:sqlite
 * under vitest); pass null to restore the production getExecutor()
 * binding. */
export function setAttachmentBrowserExecutor(
  executor: SqlExecutor | null
): void {
  browserExecutorOverride = executor
}

/**
 * Every attachment of one account, newest message first; DB failures
 * render an empty list. Reloads on mount and whenever `accountId`
 * changes; the list is pure metadata (D14), so no notify seam is needed —
 * nothing in the browser mutates attachment rows (saving writes outside
 * the database, and the cache bookkeeping never changes what is listed).
 */
export function useAccountAttachments(
  accountId: string | null
): AccountAttachmentRow[] {
  const [attachments, setAttachments] = useState<AccountAttachmentRow[]>([])
  useEffect(() => {
    let cancelled = false
    // The promise hop keeps the load (and the no-DB fallback —
    // resolveExecutor() throws outside Tauri) out of the effect body.
    Promise.resolve()
      .then(() =>
        accountId
          ? listAccountAttachments(resolveExecutor(), accountId)
          : []
      )
      .then((rows) => {
        if (!cancelled) setAttachments(rows)
      })
      .catch((error) => {
        // An unmounted browser discards the answer — late failures are
        // not worth reporting (the use-contacts.ts rule).
        if (cancelled) return
        console.warn("[attachments-browser] failed to load attachments", error)
        setAttachments([])
      })
    return () => {
      cancelled = true
    }
  }, [accountId])
  return attachments
}

/**
 * Bytes for one entry's inline preview (task 3.7): the existing
 * getAttachmentContent path — ensures the content is cached (server on
 * first access, D15 disk cache afterwards) and returns the decoded
 * bytes. `deps` mirrors AttachmentDeps for tests; production omits it.
 */
export async function fetchAttachmentPreviewBytes(
  entry: AccountAttachmentRow,
  deps: AttachmentDeps = {}
): Promise<Uint8Array> {
  const executor = resolveExecutor()
  const accountRow = await getAccount(executor, entry.account_id)
  if (!accountRow) throw new Error("the attachment's account no longer exists")
  return getAttachmentContent(
    executor,
    toEmailAccount(accountRow),
    entry,
    entry,
    deps
  )
}

/** The outcome of a browser save attempt. */
export type SaveAttachmentOutcome = "saved" | "cancelled" | "failed"

/**
 * "Save to disk" from the browser (the spec's save-to-disk scenario):
 * fetch/cache through the existing path, then the existing OS save
 * dialog + write (saveAttachmentAs, task 7.5). A completed save toasts
 * the chosen path (the app's confirmation); a dialog cancel resolves
 * "cancelled" silently; any failure toasts an error. The browser passes
 * `deps` only in tests.
 */
export async function saveAttachmentToDisk(
  entry: AccountAttachmentRow,
  deps: FileActionDeps & AttachmentDeps = {}
): Promise<SaveAttachmentOutcome> {
  try {
    const executor = resolveExecutor()
    const accountRow = await getAccount(executor, entry.account_id)
    if (!accountRow) throw new Error("the attachment's account no longer exists")
    const bytes = await getAttachmentContent(
      executor,
      toEmailAccount(accountRow),
      entry,
      entry,
      deps
    )
    const target = await saveAttachmentAs(entry, bytes, deps)
    if (target === null) return "cancelled"
    toast.success(`Saved ${entry.filename ?? "attachment"} to ${target}`)
    return "saved"
  } catch (error) {
    console.warn("[attachments-browser] attachment save failed", error)
    toast.error(`Could not save ${entry.filename ?? "this attachment"}.`)
    return "failed"
  }
}

/**
 * Jump to source (the spec's "jump to source message" scenario): back to
 * the mailbox view the user came from (previousView — the attachments
 * view is never recorded as previousView), then into the reading pane,
 * which resolves the thread's owning account itself (the openRelatedThread
 * semantics from the Contacts browser's use-contacts.ts).
 */
export function openAttachmentSourceMessage(threadId: string): void {
  const ui = useUiStore.getState()
  ui.setView(ui.previousView)
  ui.setActiveThread(threadId)
}
