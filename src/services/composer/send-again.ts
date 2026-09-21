import type { AttachmentDeps } from "@/services/attachments"
import { getAttachmentContent } from "@/services/attachments/cache"
import { setAttachmentBytes } from "@/components/composer/attachment-bytes"
import { useComposerStore } from "@/stores/composer-store"
import { useUiStore } from "@/stores/ui-store"
import { toast } from "sonner"

import { getAccount, toEmailAccount } from "../db/accounts"
import type { SqlExecutor } from "../db/executor"
import { findLabelsBySpecialUse } from "../db/labels"
import { getMessage } from "../db/messages"
import { getExecutor } from "../db/executor"
import { renderPlainTextAsHtml } from "../renderer"

/**
 * Send again (batch C3): re-open a SENT message as a brand-new draft. The
 * reading pane's "Send again" action (mail-display.tsx, beside View
 * source) lands here; the composer opens prefilled with the original
 * recipients, the subject EXACTLY as sent (no Re:/Fwd: handling — the
 * subject is copied verbatim) and the original sent body HTML.
 *
 * Everything else about the new message is deliberately fresh:
 * - From = the account that sent the original (the message's own
 *   account_id, not the currently active one) — the composer's From
 *   picker preselects that account's default alias as usual.
 * - The mode is `{ kind: "new" }`, so the send path builds NO
 *   In-Reply-To/References headers and files the message into its OWN
 *   provisional sent thread — a completely independent message, never a
 *   reply linked to the old one.
 *
 * Attachments are re-attached from the stored message, but only when
 * their bytes are actually recoverable: the attachments table carries
 * metadata for server-synced copies (provisional sent rows written by the
 * send flow carry no attachment rows at all — the server copy replaces
 * them on the next sync), and the bytes come from the regular attachment
 * content seam (disk cache, else the provider fetch — the same path the
 * Save/Open buttons use). Inline body parts (cid: images) are skipped —
 * they belong to the stored HTML, not the attachment list. ANY attachment
 * whose bytes cannot be loaded is never silently dropped: the composer
 * opens with whatever restored, and a dismissible notice line
 * ("Original attachments couldn't be restored") records the difference.
 * A message with no attachment rows at all opens silently — there is
 * nothing to differ from.
 *
 * Same bridge-ordering contract as reply-opener.ts: the composer store is
 * configured first (openWith resets + opens) and ui-store's composerOpen
 * flag is flipped afterwards. Attachment BYTES are loaded BEFORE openWith
 * (which clears the session registry) and registered after it, exactly
 * like the draft-resume path.
 */

/** The dismissible composer notice when attachments could not be restored. */
export const SEND_AGAIN_ATTACHMENT_NOTICE =
  "Original attachments couldn't be restored"

export interface OpenSendAgainOptions {
  /** Defaults to the shared app executor (getExecutor()); tests inject. */
  executor?: SqlExecutor
  /** Attachment content seams (disk cache fs / provider fetch); tests
   * inject fakes, production resolves to the Tauri plugins. */
  attachmentDeps?: AttachmentDeps
}

/**
 * Whether the message's thread sits in the account's sent folder — the
 * visibility condition for the "Send again" action. Covers both folder
 * membership models (gmail/microsoft thread_labels, imap folder_label_id)
 * so the check does not depend on the account type; a missing sent-role
 * label reads as false.
 */
export async function isThreadInSentFolder(
  executor: SqlExecutor,
  accountId: string,
  threadId: string
): Promise<boolean> {
  const sentLabels = await findLabelsBySpecialUse(executor, accountId, "sent")
  const sentLabel = sentLabels[0]
  if (!sentLabel) return false
  const byLabels = await executor.select<{ thread_id: string }>(
    "SELECT thread_id FROM thread_labels WHERE thread_id = $1 AND label_id = $2",
    [threadId, sentLabel.id]
  )
  if (byLabels.length > 0) return true
  const byFolder = await executor.select<{ id: string }>(
    "SELECT id FROM threads WHERE id = $1 AND folder_label_id = $2 LIMIT 1",
    [threadId, sentLabel.id]
  )
  return byFolder.length > 0
}

/**
 * Open the composer prefilled as a new message from the sent one.
 * Resolves to false (composer untouched) when the message or its account
 * is gone or the db is unavailable; failures are logged, never thrown.
 */
export async function openSendAgainForMessage(
  messageId: string,
  options: OpenSendAgainOptions = {}
): Promise<boolean> {
  let executor: SqlExecutor
  try {
    executor = options.executor ?? getExecutor()
  } catch (error) {
    console.warn("[send-again] db unavailable", error)
    return false
  }
  try {
    const message = await getMessage(executor, messageId)
    if (!message) return false
    const accountRow = await getAccount(executor, message.account_id)
    if (!accountRow) return false
    const account = toEmailAccount(accountRow)

    // Attachment bytes BEFORE openWith (which clears the registry) — the
    // resume-path discipline. Metadata-only rows and inline body parts
    // never enter the list; anything whose bytes fail to load is counted
    // for the notice instead of being silently dropped.
    const attachmentRows = message.attachments.filter(
      (row) => row.content_id === null && row.is_inline !== 1
    )
    interface RestoredAttachment {
      id: string
      name: string
      size: number
      mimeType?: string
      bytes: Uint8Array
    }
    const restored: RestoredAttachment[] = []
    let failed = 0
    for (const row of attachmentRows) {
      try {
        const bytes = await getAttachmentContent(
          executor,
          account,
          message,
          row,
          options.attachmentDeps ?? {}
        )
        restored.push({
          id: row.id,
          name: row.filename ?? "(unnamed)",
          size: bytes.byteLength,
          ...(row.mime_type !== null ? { mimeType: row.mime_type } : {}),
          bytes,
        })
      } catch (error) {
        console.warn("[send-again] attachment restore failed", error)
        failed += 1
      }
    }

    const composer = useComposerStore.getState()
    // { kind: "new" }: fresh thread, no reply headers on the next send.
    composer.openWith({ kind: "new" }, message.account_id)
    composer.setTo(
      message.to.filter((recipient) => recipient.email?.trim() !== "")
    )
    composer.setCc(
      message.cc.filter((recipient) => recipient.email?.trim() !== "")
    )
    composer.setBcc(
      message.bcc.filter((recipient) => recipient.email?.trim() !== "")
    )
    // The subject exactly as sent — verbatim, no prefix handling.
    composer.setSubject(message.subject ?? "")
    composer.setHtml(
      message.body_html ??
        (message.body_text ? renderPlainTextAsHtml(message.body_text) : "")
    )
    if (restored.length > 0) {
      for (const attachment of restored) {
        setAttachmentBytes(attachment.id, attachment.bytes)
      }
      composer.setAttachments(
        restored.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          size: attachment.size,
          ...(attachment.mimeType !== undefined
            ? { mimeType: attachment.mimeType }
            : {}),
        }))
      )
    }
    if (failed > 0) {
      composer.setAttachmentNotice(SEND_AGAIN_ATTACHMENT_NOTICE)
    }
    useUiStore.getState().setComposerOpen(true)
    return true
  } catch (error) {
    console.warn("[send-again] failed to open send-again", error)
    toast.error("Could not reopen this message")
    return false
  }
}
