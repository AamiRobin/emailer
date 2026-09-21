import { useEffect, useMemo, useState, type ReactElement } from "react"
import {
  ArrowLeft,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  LayoutGrid,
  List,
  Mail,
  Paperclip,
  Save,
  Search,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/email/empty-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import type { AccountAttachmentRow } from "@/services/db/attachment-search"
import {
  ATTACHMENT_TYPE_CATEGORIES,
  attachmentCategoryLabel,
  attachmentTypeCategory,
  filterAccountAttachments,
  type AttachmentTypeCategory,
} from "@/services/attachments/attachment-categories"
import {
  attachmentPdfDataUrl,
  attachmentPreviewKind,
} from "@/components/composer/attachment-preview"
import { useAccountStore } from "@/stores/account-store"
import { formatRowTimestamp } from "@/stores/thread-list-store"
import { humanFileSize } from "@/components/email/message-utils"
import { useUiStore } from "@/stores/ui-store"
import {
  fetchAttachmentPreviewBytes,
  openAttachmentSourceMessage,
  saveAttachmentToDisk,
  useAccountAttachments,
} from "./use-attachment-browser"

/**
 * The Attachments browser (task 3.7, design D14; mailbox-ui spec
 * "Attachments browser"): the current account's attachment index behind
 * the sidebar's Attachments entry — a searchable, type-filterable list of
 * every attachment (name, sender, date, size) with grid/list
 * presentation, inline preview for images and PDFs, save-to-disk through
 * the existing OS save-dialog path, and a jump to the source message.
 *
 * Selected like the settings/contacts views ({kind:"attachments"} in
 * ui-store), so it replaces the mailbox panes while the sidebar stays for
 * navigation; the back control restores the previousView the same way the
 * Contacts browser's does. Per D14 no new storage and no duplicated
 * bytes: entries come straight from the attachment index (filtered
 * in-process), and previews/saves stream through the existing
 * cache/download services (use-attachment-browser.ts).
 */
export function AttachmentsBrowser() {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState<AttachmentTypeCategory | "all">("all")
  const [layout, setLayout] = useState<"grid" | "list">("grid")
  // The entry whose inline preview is expanded (click an entry to toggle;
  // one at a time keeps the list calm and the fetches lazy per entry).
  const [previewId, setPreviewId] = useState<string | null>(null)
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const attachments = useAccountAttachments(activeAccountId)
  const setView = useUiStore((state) => state.setView)
  const previousView = useUiStore((state) => state.previousView)
  const filtered = useMemo(
    () => filterAccountAttachments(attachments, { query, category }),
    [attachments, query, category]
  )

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="attachments-browser"
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
        <h1 className="truncate text-xl font-bold text-foreground">
          Attachments
        </h1>
        {/* Grid/list presentation toggle (the pane-header segmented
            control pattern). */}
        <div
          role="group"
          aria-label="Presentation"
          data-testid="attachments-layout-toggle"
          className="ml-auto flex items-center rounded-lg border bg-muted/40 p-0.5 text-xs"
        >
          <button
            type="button"
            aria-label="Grid view"
            aria-pressed={layout === "grid"}
            data-testid="attachments-layout-grid"
            className={cn(
              "rounded-md px-2 py-1 transition-colors",
              layout === "grid"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setLayout("grid")}
          >
            <LayoutGrid className="size-4" />
          </button>
          <button
            type="button"
            aria-label="List view"
            aria-pressed={layout === "list"}
            data-testid="attachments-layout-list"
            className={cn(
              "rounded-md px-2 py-1 transition-colors",
              layout === "list"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setLayout("list")}
          >
            <List className="size-4" />
          </button>
        </div>
      </div>
      <Separator />
      {/* Toolbar: free-text search + the type filter chips (D14's
          in-process filter). */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <div className="relative min-w-48 flex-1">
          <Search
            aria-hidden
            className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search attachments"
            data-testid="attachments-search"
            value={query}
            placeholder="Search by filename"
            className="pl-8"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div
          role="group"
          aria-label="Filter by type"
          data-testid="attachments-type-filter"
          className="flex flex-wrap items-center gap-1"
        >
          {(["all", ...ATTACHMENT_TYPE_CATEGORIES] as const).map((option) => (
            <button
              key={option}
              type="button"
              data-testid="attachments-filter-chip"
              data-category={option}
              aria-pressed={category === option}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                category === option
                  ? "border-foreground bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setCategory(option)}
            >
              {attachmentCategoryLabel(option)}
            </button>
          ))}
        </div>
      </div>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        {attachments.length === 0 ? (
          <EmptyState
            icon={Paperclip}
            title="No attachments yet"
            hint="Attachments from this account's mail appear here automatically."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Search}
            title={`No attachments match “${query.trim()}”`}
            hint="Search matches attachment filenames; try another term or type filter."
          />
        ) : layout === "grid" ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 p-3">
            {filtered.map((entry) => (
              <li key={entry.id}>
                <AttachmentCard
                  entry={entry}
                  previewed={previewId === entry.id}
                  onTogglePreview={() =>
                    setPreviewId(previewId === entry.id ? null : entry.id)
                  }
                />
              </li>
            ))}
          </ul>
        ) : (
          <ul className="grid gap-1.5 p-2">
            {filtered.map((entry) => (
              <li key={entry.id}>
                <AttachmentListRow
                  entry={entry}
                  previewed={previewId === entry.id}
                  onTogglePreview={() =>
                    setPreviewId(previewId === entry.id ? null : entry.id)
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}

/** The type-appropriate file icon for an entry's collapsed tile/row. */
function typeIcon(category: AttachmentTypeCategory): LucideIcon {
  switch (category) {
    case "images":
      return FileImage
    case "pdfs":
    case "documents":
      return FileText
    case "spreadsheets":
      return FileSpreadsheet
    case "archives":
      return FileArchive
    case "other":
      return File
  }
}

/** The icon element itself, built in a plain helper (like mail-display's
 * renderAttachmentIcon) so components never hold a component created
 * during render. */
function renderTypeIcon(
  category: AttachmentTypeCategory,
  className: string
): ReactElement {
  const Icon = typeIcon(category)
  return <Icon aria-hidden className={className} />
}

/** Shared per-entry data line: sender · date (the row's secondary text). */
function entrySender(entry: AccountAttachmentRow): string {
  return entry.from_name ?? entry.from_address ?? "Unknown sender"
}

function AttachmentActions({
  entry,
  className,
}: {
  entry: AccountAttachmentRow
  className?: string
}) {
  const [saving, setSaving] = useState(false)
  return (
    <div className={cn("flex shrink-0 items-center gap-1", className)}>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2"
        data-testid="attachment-save"
        disabled={saving}
        onClick={() => {
          setSaving(true)
          void saveAttachmentToDisk(entry).finally(() => setSaving(false))
        }}
      >
        <Save className="size-3.5" />
        {saving ? "Saving…" : "Save"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2"
        data-testid="attachment-show-message"
        onClick={() => openAttachmentSourceMessage(entry.thread_id)}
      >
        <Mail className="size-3.5" />
        Show in message
      </Button>
    </div>
  )
}

function AttachmentCard({
  entry,
  previewed,
  onTogglePreview,
}: {
  entry: AccountAttachmentRow
  previewed: boolean
  onTogglePreview: () => void
}) {
  const category = attachmentTypeCategory(entry)
  return (
    <div
      data-testid="attachment-entry"
      data-attachment-id={entry.id}
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-lg border border-border",
        previewed && "ring-2 ring-ring/50"
      )}
    >
      {/* The tile is the preview toggle: collapsed it shows the type
          icon; expanded it swaps in the lazily-fetched inline preview. */}
      <button
        type="button"
        aria-expanded={previewed}
        className="flex min-h-0 flex-1 flex-col gap-2 p-3 text-start transition-colors hover:bg-accent/50"
        onClick={onTogglePreview}
      >
        <span className="flex h-24 items-center justify-center rounded-md bg-muted/40">
          {previewed ? (
            <AttachmentInlinePreview key={entry.id} entry={entry} />
          ) : (
            renderTypeIcon(category, "size-8 text-muted-foreground")
          )}
        </span>
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-sm font-medium">
            {entry.filename || "(unnamed)"}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {entrySender(entry)}
          </span>
        </span>
        <span className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
          <span>{formatRowTimestamp(entry.message_date)}</span>
          <span>{humanFileSize(entry.size)}</span>
        </span>
      </button>
      <AttachmentActions
        entry={entry}
        className="border-t px-1.5 py-1"
      />
    </div>
  )
}

function AttachmentListRow({
  entry,
  previewed,
  onTogglePreview,
}: {
  entry: AccountAttachmentRow
  previewed: boolean
  onTogglePreview: () => void
}) {
  const category = attachmentTypeCategory(entry)
  return (
    <div
      data-testid="attachment-entry"
      data-attachment-id={entry.id}
      className={cn(
        "rounded-lg border border-border",
        previewed && "ring-2 ring-ring/50"
      )}
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          aria-expanded={previewed}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-start transition-colors hover:bg-accent/50"
          onClick={onTogglePreview}
        >
          {renderTypeIcon(category, "size-4 shrink-0 text-muted-foreground")}
          <span className="grid min-w-0 flex-1 gap-0">
            <span className="truncate text-sm font-medium">
              {entry.filename || "(unnamed)"}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {entrySender(entry)}
            </span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatRowTimestamp(entry.message_date)}
          </span>
          <span className="w-16 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
            {humanFileSize(entry.size)}
          </span>
        </button>
        <AttachmentActions entry={entry} />
      </div>
      {previewed && (
        <div className="border-t p-3">
          <AttachmentInlinePreview key={entry.id} entry={entry} />
        </div>
      )}
    </div>
  )
}

type PreviewState =
  | { stage: "loading" }
  | { stage: "error" }
  | { stage: "ready"; bytes: Uint8Array }

/**
 * One entry's inline preview (images and PDFs; anything else shows an
 * explanatory fallback). Bytes are fetched lazily — only when the entry
 * is expanded — through the existing cache/download path, then rendered
 * as an object URL (images) or a PDF data URL first-page render (the
 * composer preview's WKWebView-safe approach, task 2.8).
 */
function AttachmentInlinePreview({ entry }: { entry: AccountAttachmentRow }) {
  // "loading" is the initial stage; the fetch promise below settles into
  // ready/error (the parent keys this component by entry id, so a new
  // entry remounts instead of reusing a stale stage).
  const [state, setState] = useState<PreviewState>({ stage: "loading" })
  const kind = attachmentPreviewKind({
    name: entry.filename ?? "",
    mimeType: entry.mime_type ?? undefined,
  })

  useEffect(() => {
    let cancelled = false
    fetchAttachmentPreviewBytes(entry)
      .then((bytes) => {
        if (!cancelled) setState({ stage: "ready", bytes })
      })
      .catch((error) => {
        console.warn("[attachments-browser] preview failed", error)
        if (!cancelled) setState({ stage: "error" })
      })
    return () => {
      cancelled = true
    }
  }, [entry])

  // Image bytes → object URL, revoked when it changes/unmounts. PDFs use
  // a data URL instead (no revoke lifecycle needed — see
  // attachment-preview.ts for the WKWebView rationale).
  const objectUrl = useMemo(() => {
    if (state.stage !== "ready" || kind !== "image") return null
    return URL.createObjectURL(new Blob([state.bytes as BlobPart]))
  }, [state, kind])
  useEffect(() => {
    if (!objectUrl) return
    return () => URL.revokeObjectURL(objectUrl)
  }, [objectUrl])

  return (
    <div
      data-testid="attachment-preview"
      className="flex w-full items-center justify-center"
    >
      {state.stage === "loading" && (
        <p className="text-xs text-muted-foreground">Loading preview…</p>
      )}
      {state.stage === "error" && (
        <p className="text-xs text-destructive">
          Could not load a preview of this file.
        </p>
      )}
      {state.stage === "ready" && kind === "image" && objectUrl && (
        <img
          src={objectUrl}
          alt={`Preview of ${entry.filename || "attachment"}`}
          data-testid="attachment-preview-image"
          className="max-h-48 max-w-full rounded-md"
        />
      )}
      {state.stage === "ready" && kind === "pdf" && (
        <object
          data={attachmentPdfDataUrl(state.bytes)}
          type="application/pdf"
          aria-label={`Preview of ${entry.filename || "attachment"}`}
          data-testid="attachment-preview-pdf"
          className="h-48 w-full rounded-md"
        />
      )}
      {state.stage === "ready" && kind === "other" && (
        <p className="text-xs text-muted-foreground">
          No inline preview for this file type — use Save to keep a copy.
        </p>
      )}
    </div>
  )
}
