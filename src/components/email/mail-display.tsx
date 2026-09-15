import { useEffect, useMemo, useState, type ReactElement } from "react"
import {
  ChevronDown,
  File as FileIcon,
  FileArchive as FileArchiveIcon,
  FileImage as FileImageIcon,
  FileSpreadsheet as FileSpreadsheetIcon,
  FileText as FileTextIcon,
  ImageOff,
  Paperclip,
  Save,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { getAttachmentsForMessage } from "@/services/db/attachments"
import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import type { AttachmentRow, MessageRow } from "@/services/db/messages"
import { parseContacts } from "@/services/db/messages"
import type { EmailAccount } from "@/services/email/types"
import {
  ensureAttachmentCached,
  getAttachmentContent,
  openAttachment,
  saveAttachmentAs,
  type AttachmentDeps,
} from "@/services/attachments"
import { renderPlainTextAsHtml, sanitizeEmailHtml } from "@/services/renderer"
import { formatRowTimestamp } from "@/stores/thread-list-store"
import { SafeEmailFrame } from "@/components/email/safe-email-frame"
import {
  avatarTokenClass,
  formatFullTimestamp,
  getInitials,
  humanFileSize,
} from "./message-utils"

/**
 * MailDisplay — one message inside the thread view (task 7.1). The visual
 * language follows the original mail-display composite (avatar header,
 * clean typography); the mock toolbar/reply form were replaced by the
 * real thread-level toolbar in ThreadView (the inline reply box itself is
 * task 7.6 and mounts under the message list).
 *
 * Read messages collapse to a one-line summary (sender, snippet or
 * subject, time) that expands on click; unread messages render expanded
 * with emphasis — the expanded/collapsed state is owned by ThreadView.
 *
 * Body rendering (tasks 7.2/7.3/7.7): sanitized HTML (or linkified plain
 * text) inside the sandboxed frame. Remote images are blocked unless the
 * sender is allowlisted or the user shows them for this message — when a
 * blocked render contains remote images, an inline banner offers "Show
 * images" (this message only, component state) and "Always allow from
 * sender" (persisted via the image_allowlist table by ThreadView).
 *
 * Inline cid: images (task 7.7): `cid:` refs in the sanitized html resolve
 * to the message's OWN attached parts (attachments with a content_id)
 * through the attachment cache and render as data: URIs — even while
 * remote images stay blocked. See the "Inline cid: images" section.
 *
 * Links: sanitized anchors carry target="_blank" rel="noopener
 * noreferrer" and the sandbox allows popups; the opener plugin routes
 * http(s) to the OS browser (task 7.4). Nothing in this composite
 * intercepts link clicks.
 */

export interface MailDisplayProps {
  message: MessageRow
  threadSubject: string | null
  /** Sender is on the persistent image allowlist. */
  imagesAllowed: boolean
  /** Persist "always allow images from this sender" (image_allowlist). */
  onAllowSender: (senderEmail: string) => void
  /** The message was unread when the thread was opened (visual emphasis). */
  initiallyUnread: boolean
  expanded: boolean
  onToggleExpanded: () => void
  /** Resolved account for attachment content flows; null disables actions. */
  account: EmailAccount | null
  /**
   * Attachment-cache seams for cid: resolution (ensureAttachmentCached
   * deps). Production resolves to the Tauri plugins; tests inject fakes.
   */
  attachmentDeps?: AttachmentDeps
}

export function MailDisplay({
  message,
  threadSubject,
  imagesAllowed,
  onAllowSender,
  initiallyUnread,
  expanded,
  onToggleExpanded,
  account,
  attachmentDeps,
}: MailDisplayProps) {
  const senderName =
    message.from_name || message.from_address || "Unknown sender"
  const initials = getInitials(message.from_name, message.from_address)
  const avatarClass = avatarTokenClass(message.from_address)

  if (!expanded) {
    return (
      <div data-testid="message-collapsed" className="px-4 py-1">
        <button
          type="button"
          data-testid="expand-message"
          aria-expanded={false}
          className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-accent"
          onClick={onToggleExpanded}
        >
          <Avatar size="sm">
            <AvatarFallback className={avatarClass}>{initials}</AvatarFallback>
          </Avatar>
          <span
            className={cn(
              "shrink-0",
              initiallyUnread ? "font-semibold" : "font-medium"
            )}
          >
            {senderName}
          </span>
          <span className="line-clamp-1 min-w-0 flex-1 text-muted-foreground">
            {message.snippet || threadSubject || "(no content)"}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatRowTimestamp(message.date)}
          </span>
        </button>
      </div>
    )
  }

  return (
    <div
      data-testid="message-expanded"
      className={cn("px-4 py-3", initiallyUnread && "bg-accent/40")}
    >
      <div className="flex items-start gap-3">
        <Avatar>
          <AvatarFallback className={avatarClass}>{initials}</AvatarFallback>
        </Avatar>
        <div className="grid min-w-0 flex-1 gap-0.5 text-sm">
          <div className="flex items-center gap-2">
            {initiallyUnread && (
              <span
                data-testid="unread-dot"
                aria-label="Unread"
                className="size-2 shrink-0 rounded-full bg-primary"
              />
            )}
            <span
              className={cn(
                "truncate",
                initiallyUnread ? "font-semibold" : "font-medium"
              )}
            >
              {senderName}
            </span>
            {message.from_address && (
              <span className="truncate text-xs text-muted-foreground">
                &lt;{message.from_address}&gt;
              </span>
            )}
          </div>
          <RecipientLine label="To" contacts={parseContacts(message.to_json)} />
          <RecipientLine label="Cc" contacts={parseContacts(message.cc_json)} />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-xs text-muted-foreground">
            {formatFullTimestamp(message.date)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs text-muted-foreground"
            data-testid="collapse-message"
            aria-expanded={true}
            onClick={onToggleExpanded}
          >
            <ChevronDown className="size-3.5" />
            Collapse
          </Button>
        </div>
      </div>
      <MessageBody
        message={message}
        imagesAllowed={imagesAllowed}
        onAllowSender={onAllowSender}
        account={account}
        attachmentDeps={attachmentDeps}
      />
      <AttachmentList message={message} account={account} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

function RecipientLine({
  label,
  contacts,
}: {
  label: string
  contacts: { name?: string; email: string }[]
}) {
  if (!contacts.length) return null
  return (
    <div data-testid={`recipients-${label.toLowerCase()}`} className="text-xs">
      <span className="font-medium text-muted-foreground">{label}:</span>{" "}
      <span className="text-muted-foreground">
        {contacts.map((contact) => contact.name || contact.email).join(", ")}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Body + remote-image policy (task 7.3)
// ---------------------------------------------------------------------------

function MessageBody({
  message,
  imagesAllowed,
  onAllowSender,
  account,
  attachmentDeps,
}: {
  message: MessageRow
  imagesAllowed: boolean
  onAllowSender: (senderEmail: string) => void
  account: EmailAccount | null
  attachmentDeps: AttachmentDeps | undefined
}) {
  // "Show images" applies to this message only (component state); the
  // allowlist decision arrives via the imagesAllowed prop.
  const [showImagesOnce, setShowImagesOnce] = useState(false)
  const effectiveAllowed = imagesAllowed || showImagesOnce

  const bodyHtml = useMemo(() => {
    if (message.body_html) {
      return sanitizeEmailHtml(message.body_html, {
        blockRemoteImages: !effectiveAllowed,
      })
    }
    if (message.body_text) {
      return sanitizeEmailHtml(renderPlainTextAsHtml(message.body_text), {
        blockRemoteImages: !effectiveAllowed,
      })
    }
    return null
  }, [message.body_html, message.body_text, effectiveAllowed])

  const hasCidRefs = bodyHtml !== null && extractCidRefs(bodyHtml).length > 0
  const [resolved, setResolved] = useState<ResolvedBody | null>(() =>
    bodyHtml === null ? null : (resolvedBodyCache.get(message.id) ?? null)
  )

  // cid: → data: resolution (task 7.7). Runs after sanitize (cid: srcs
  // pass through untouched), before first render when refs exist — until
  // it settles the body shows a loading state. An image-policy change
  // produces a different source html, which invalidates the memo for this
  // message. The memo map is read during render too (pure lookup), so a
  // populated cache renders immediately without a setState round-trip.
  useEffect(() => {
    if (bodyHtml === null || !hasCidRefs || !account) return
    const cached = resolvedBodyCache.get(message.id)
    if (cached && cached.source === bodyHtml) return
    let cancelled = false
    resolveCidImages(message, account, bodyHtml, attachmentDeps ?? {})
      .then((html) => {
        if (cancelled) return
        const entry: ResolvedBody = { source: bodyHtml, html }
        resolvedBodyCache.set(message.id, entry)
        setResolved(entry)
      })
      .catch((error) => {
        // No db / fetch failure — degrade to the unresolved body (refs
        // stay as-is) instead of blocking the message forever.
        console.warn("[mail-display] cid image resolution failed", error)
        if (!cancelled) setResolved({ source: bodyHtml, html: bodyHtml })
      })
    return () => {
      cancelled = true
    }
  }, [bodyHtml, hasCidRefs, message, account, attachmentDeps])

  const effectiveEntry =
    resolved !== null && resolved.source === bodyHtml
      ? resolved
      : bodyHtml === null
        ? null
        : (resolvedBodyCache.get(message.id) ?? null)
  const resolvedHtml =
    effectiveEntry !== null && effectiveEntry.source === bodyHtml
      ? effectiveEntry.html
      : null

  // Blocked renders keep the original URL in data-original-src (see
  // sanitize.ts) — its presence is the "images were hidden" signal.
  const hasBlockedImages =
    bodyHtml !== null &&
    !effectiveAllowed &&
    bodyHtml.includes("data-original-src")

  if (bodyHtml === null) {
    return <p className="pt-3 text-sm text-muted-foreground">(no content)</p>
  }

  // Loading only while an account-backed resolution is in flight; without
  // an account the unresolved body renders directly (refs stay as-is).
  if (hasCidRefs && resolvedHtml === null && account !== null) {
    return (
      <div className="pt-3">
        <p
          data-testid="email-body-loading"
          className="text-sm text-muted-foreground"
        >
          Loading message…
        </p>
      </div>
    )
  }

  return (
    <div className="pt-3">
      {hasBlockedImages && (
        <div
          data-testid="images-banner"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
        >
          <ImageOff className="size-3.5 shrink-0" />
          <span>Images are hidden</span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7"
            data-testid="show-images"
            onClick={() => setShowImagesOnce(true)}
          >
            Show images
          </Button>
          {message.from_address && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              data-testid="allow-sender-images"
              onClick={() => {
                setShowImagesOnce(true)
                if (message.from_address) onAllowSender(message.from_address)
              }}
            >
              Always allow from sender
            </Button>
          )}
        </div>
      )}
      <SafeEmailFrame html={resolvedHtml ?? bodyHtml} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline cid: images (task 7.7)
// ---------------------------------------------------------------------------

/**
 * `cid:xyz` references in a message's html resolve to the message's OWN
 * attached parts (attachment rows with a non-null content_id, via
 * getAttachmentsForMessage). After sanitizeEmailHtml — whose policy passes
 * cid: srcs through untouched whether or not remote images are blocked —
 * each matched ref is swapped for a `data:` URI built from the attachment
 * cache bytes (ensureAttachmentCached), so inline images display even
 * while remote images are blocked (data: URIs are never blocked).
 *
 * Matching is case-insensitive and tolerates angle brackets / a leading
 * "cid:" on the stored content_id (gmail strips them at sync; imap may
 * not). Unmatched refs stay exactly as they are.
 */

interface ResolvedBody {
  /** The sanitized source html this resolution was computed for. */
  source: string
  /** The html after the cid: → data: replacement. */
  html: string
}

/** Per-message memo: collapse/expand remounts must not refetch. */
const resolvedBodyCache = new Map<string, ResolvedBody>()

/** Uint8Array → base64 (chunked so large images never blow the stack). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const CHUNK = 0x8000
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
  }
  return btoa(binary)
}

/** cid: values used in img src attributes of sanitized html. */
function extractCidRefs(html: string): string[] {
  return [...html.matchAll(/\bsrc=(["'])cid:([^"']+)\1/gi)].map(
    (match) => match[2]
  )
}

/** Canonical form for matching an html ref against a stored content_id. */
function normalizeCid(value: string): string {
  return value.trim().replace(/^<|>$/g, "").replace(/^cid:/i, "").toLowerCase()
}

/**
 * Replace every matched cid: src in `html` with a data URI of the cached
 * attachment bytes. Each unique ref is fetched once; unmatched refs and
 * rows without a content_id are ignored. Throws on executor/fetch failure
 * — the caller degrades to the unresolved html.
 */
async function resolveCidImages(
  message: MessageRow,
  account: EmailAccount,
  html: string,
  deps: AttachmentDeps
): Promise<string> {
  const executor = await resolveExecutor()
  const attachments = await getAttachmentsForMessage(executor, message.id)
  const byCid = new Map<string, AttachmentRow>()
  for (const row of attachments) {
    if (row.content_id === null) continue
    byCid.set(normalizeCid(row.content_id), row)
  }
  const uris = new Map<string, string>()
  for (const ref of new Set(extractCidRefs(html).map(normalizeCid))) {
    const row = byCid.get(ref)
    if (!row) continue
    const { bytes } = await ensureAttachmentCached(
      executor,
      account,
      message,
      row,
      deps
    )
    const mime = row.mime_type ?? "application/octet-stream"
    uris.set(ref, `data:${mime};base64,${bytesToBase64(bytes)}`)
  }
  if (uris.size === 0) return html
  return html.replace(
    /\bsrc=(["'])(cid:([^"']+))\1/gi,
    (whole, _quote: string, _cid: string, value: string) => {
      const uri = uris.get(normalizeCid(value))
      return uri ? `src="${uri}"` : whole
    }
  )
}

// ---------------------------------------------------------------------------
// Attachment list (task 7.5 UI half)
// ---------------------------------------------------------------------------

/**
 * Error surfacing: sonner is installed, but no <Toaster> is mounted in the
 * app yet (src/components/ui/sonner.tsx has no consumer), so attachment
 * failures show as inline error text on the failing row instead of
 * toasts. When a global Toaster lands, swap these for toast.error.
 */

function attachmentIcon(mimeType: string | null): LucideIcon {
  const mime = (mimeType ?? "").toLowerCase()
  if (mime.startsWith("image/")) return FileImageIcon
  if (
    mime.includes("zip") ||
    mime.includes("compressed") ||
    mime.includes("rar") ||
    mime.includes("7z") ||
    mime.includes("tar")
  ) {
    return FileArchiveIcon
  }
  if (
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    mime.includes("csv")
  ) {
    return FileSpreadsheetIcon
  }
  if (mime.startsWith("text/") || mime.includes("pdf") || mime.includes("word"))
    return FileTextIcon
  return FileIcon
}

/** The type-appropriate icon element for an attachment row. */
function renderAttachmentIcon(mimeType: string | null): ReactElement {
  const Icon = attachmentIcon(mimeType)
  return <Icon className="size-4 shrink-0 text-muted-foreground" />
}

function AttachmentList({
  message,
  account,
}: {
  message: MessageRow
  account: EmailAccount | null
}) {
  const [attachments, setAttachments] = useState<AttachmentRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    // MailDisplay is keyed by message id upstream, so this effect runs
    // exactly once per mounted list; state updates happen only in the
    // promise callbacks.
    let cancelled = false
    resolveExecutor()
      .then((executor) => getAttachmentsForMessage(executor, message.id))
      .then((rows) => {
        if (!cancelled) setAttachments(rows)
      })
      .catch((error) => {
        console.warn("[mail-display] failed to load attachments", error)
        if (!cancelled) setLoadError("Could not load attachments.")
      })
    return () => {
      cancelled = true
    }
  }, [message.id])

  if (loadError) {
    return (
      <p
        className="pt-3 text-xs text-destructive"
        data-testid="attachments-error"
      >
        {loadError}
      </p>
    )
  }
  if (!attachments?.length) return null

  return (
    <div className="pt-3" data-testid="attachment-list">
      <Separator className="mb-3" />
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Paperclip className="size-3.5" />
        {attachments.length}{" "}
        {attachments.length === 1 ? "attachment" : "attachments"}
      </div>
      <ul className="grid gap-2">
        {attachments.map((attachment) => (
          <li key={attachment.id}>
            <AttachmentItem
              attachment={attachment}
              message={message}
              account={account}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

function AttachmentItem({
  attachment,
  message,
  account,
}: {
  attachment: AttachmentRow
  message: MessageRow
  account: EmailAccount | null
}) {
  // "save" | "open" while the content fetch/file action is in flight.
  const [busy, setBusy] = useState<"save" | "open" | null>(null)
  const [error, setError] = useState<string | null>(null)

  function handleSave(): void {
    if (!account || busy) return
    setBusy("save")
    setError(null)
    resolveExecutor()
      .then((executor) =>
        getAttachmentContent(executor, account, message, attachment)
      )
      .then((bytes) => saveAttachmentAs(attachment, bytes))
      .then((target) => {
        // null = the user cancelled the save dialog — not an error.
        if (target === null) return
      })
      .catch((saveError) => {
        console.warn("[mail-display] attachment save failed", saveError)
        setError("Could not save this file.")
      })
      .finally(() => setBusy(null))
  }

  function handleOpen(): void {
    if (!account || busy) return
    setBusy("open")
    setError(null)
    resolveExecutor()
      .then((executor) =>
        openAttachment(executor, account, message, attachment)
      )
      .catch((openError) => {
        console.warn("[mail-display] attachment open failed", openError)
        setError("Could not open this file.")
      })
      .finally(() => setBusy(null))
  }

  return (
    <div
      data-testid="attachment-item"
      className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
    >
      {renderAttachmentIcon(attachment.mime_type)}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {attachment.filename || "(unnamed)"}
        </div>
        <div className="text-xs text-muted-foreground">
          {humanFileSize(attachment.size)}
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1"
          data-testid="attachment-save"
          disabled={!account || busy !== null}
          onClick={handleSave}
        >
          <Save className="size-3.5" />
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7"
          data-testid="attachment-open"
          disabled={!account || busy !== null}
          onClick={handleOpen}
        >
          {busy === "open" ? "Opening…" : "Open"}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Executor access
// ---------------------------------------------------------------------------

/**
 * Resolve the app executor lazily at call time. getExecutor() throws
 * before database bootstrap (and outside Tauri) — deferring it into the
 * promise chain lets the catch paths treat that as "no data" instead of
 * crashing the message render.
 */
function resolveExecutor(): Promise<SqlExecutor> {
  return Promise.resolve().then(() => getExecutor())
}
