import { toast } from "sonner"

import { refreshThreadList } from "@/stores/thread-list-store"
import {
  applyBlockToExistingMail,
  blockSender as blockSenderInDb,
  type BlockedSenderAction,
} from "@/services/db/blocked-senders"
import type { SqlExecutor } from "@/services/db/executor"

/**
 * The shared block-sender flow (task 18.2, mail-security spec "Block
 * sender"): every entry point — the thread-list row context menu and the
 * reading-pane toolbar — funnels through here, so the blocklist write,
 * the optional existing-mail cleanup, the toast and the post-block
 * refresh happen exactly once and identically.
 *
 * Blocking is local and per account: blockSender upserts the
 * blocked_senders row (the dialog's action choice decides what future
 * mail from the sender is filed as, via the ingestion hook), and the
 * cleanup option files the sender's current inbox-resident conversations
 * through the BULK thread-actions path (applyBlockToExistingMail — the
 * same local effect + queue ops a user multi-select runs). The list
 * refresh prunes the filed rows from the visible inbox behind whichever
 * surface is open.
 */

/**
 * Block `sender` for `accountId` with the dialog's chosen action and run
 * the optional cleanup + the post-block refresh. Returns false when the
 * blocklist write (or the cleanup) failed — callers treat it as "nothing
 * happened" (no toast was shown, no refresh ran).
 */
export async function blockSenderWithRefresh(
  executor: SqlExecutor,
  accountId: string,
  sender: string,
  action: BlockedSenderAction,
  applyToExisting: boolean
): Promise<boolean> {
  try {
    await blockSenderInDb(executor, accountId, { sender, action })
    const moved = applyToExisting
      ? await applyBlockToExistingMail(executor, accountId, sender, action)
      : 0
    toast.success(
      moved > 0
        ? `Blocked ${sender} — moved ${moved} conversation${
            moved === 1 ? "" : "s"
          }`
        : `Blocked ${sender}`
    )
  } catch (error) {
    console.warn("[block-sender] failed", error)
    return false
  }
  await refreshThreadList()
  return true
}
