import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react"
import { Link as LinkExtension } from "@tiptap/extension-link"
import { TextAlign } from "@tiptap/extension-text-align"
import { Underline } from "@tiptap/extension-underline"
import { EditorContent, useEditor } from "@tiptap/react"
import { StarterKit } from "@tiptap/starter-kit"
import { Placeholder } from "@tiptap/extensions"
import { Paperclip } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useAccountStore } from "@/stores/account-store"
import { getComposerPayload, useComposerStore } from "@/stores/composer-store"
import { hasInvalidRecipient } from "./address-validation"
import { addFileAttachments, pickAttachments } from "./attachment-input"
import { AttachmentStrip } from "./attachment-strip"
import { ComposerToolbar } from "./composer-toolbar"
import { RecipientField } from "./recipient-field"
import {
  deleteDraftByKey,
  isDraftEmpty,
  type DraftInput,
} from "@/services/composer/drafts"
import { sendComposerDraft } from "@/services/composer/send"
import { useDraftAutosave } from "@/services/composer/use-draft-autosave"
import { getExecutor } from "@/services/db/executor"

/**
 * The composer view (tasks 8.1 + 8.2): To/Cc/Bcc recipient fields with
 * per-chip validity flags and contact autocomplete (8.3), subject, TipTap
 * rich-text body with a formatting toolbar, and a Send/Discard footer.
 *
 * Self-contained by contract: the mailbox shell decides when this view is
 * mounted (ui-store composerOpen) and calls `composer-store.openNew` to
 * start a blank message; this component renders null while the composer
 * store is closed, so it is safe to keep mounted. Opening a new message
 * puts focus in the To field (mail-composition spec); reply/forward modes
 * pre-fill recipients (task 8.4) and manage their own focus.
 *
 * The editor syncs its HTML into composer-store on every update.
 *
 * Task 8.5 (attachments): the whole composer surface is a dropzone — it
 * highlights on dragover and dropped OS files are read (bytes land in the
 * attachment-bytes registry) and surface as removable chips in the
 * attachment strip above the footer. The footer's "Attach file" button
 * opens the system picker (multiple). Cap breaches and read failures show
 * as an inline error above the footer (see attachment-input.ts).
 *
 * Task 8.6 (draft autosave): the store hands out a fresh `draftKey` per
 * open; this view mounts useDraftAutosave against the composer snapshot
 * (recipients, subject, body, attachment descriptors, reply context) so
 * edits land in `local_drafts` after a 3s quiet period. Explicit close
 * paths flush first, then delete the row by key: a confirmed discard
 * (non-empty drafts require confirmation) and a successful send both end
 * with the draft row gone.
 *
 * Task 8.7 (send): Send enables when the draft is sendable — at least one
 * valid recipient and a subject or body — and calls sendComposerDraft
 * with the payload from getComposerPayload(). Success closes the composer
 * with a toast ("Message queued" when offline); a failure keeps the
 * composer open and shows the sanitized error with a Retry affordance.
 */

/** Token utilities standing in for prose styles (no typography plugin):
 * list markers, paragraph rhythm and link styling inside the editor. */
const EDITOR_CONTENT_CLASS =
  "max-w-none [&_a]:text-primary [&_a]:underline [&_ol]:list-decimal [&_ol]:ps-6 [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p.is-empty:first-child]:before:pointer-events-none [&_p.is-empty:first-child]:before:float-left [&_p.is-empty:first-child]:before:h-0 [&_p.is-empty:first-child]:before:content-[attr(data-placeholder)] [&_p.is-empty:first-child]:before:text-muted-foreground [&_ul]:list-disc [&_ul]:ps-6"

/** Visibility gate: everything expensive (the TipTap instance) mounts
 * only while the composer is open, so a draft rehydrated into the store
 * (task 8.6 resume) is picked up as the editor's initial content. */
export function Composer() {
  const open = useComposerStore((state) => state.open)
  if (!open) return null
  return <ComposerView />
}

function ComposerView() {
  const mode = useComposerStore((state) => state.mode)
  const to = useComposerStore((state) => state.to)
  const cc = useComposerStore((state) => state.cc)
  const bcc = useComposerStore((state) => state.bcc)
  const showCc = useComposerStore((state) => state.showCc)
  const showBcc = useComposerStore((state) => state.showBcc)
  const subject = useComposerStore((state) => state.subject)
  const setTo = useComposerStore((state) => state.setTo)
  const setCc = useComposerStore((state) => state.setCc)
  const setBcc = useComposerStore((state) => state.setBcc)
  const setSubject = useComposerStore((state) => state.setSubject)
  const setHtml = useComposerStore((state) => state.setHtml)
  const toggleCc = useComposerStore((state) => state.toggleCc)
  const toggleBcc = useComposerStore((state) => state.toggleBcc)
  const reset = useComposerStore((state) => state.reset)
  const draftKey = useComposerStore((state) => state.draftKey)
  const composerAccountId = useComposerStore((state) => state.activeAccountId)
  // Fall back to the shell's active account (e.g. a composer opened before
  // an account selection landed in the store).
  const shellAccountId = useAccountStore((state) => state.activeAccountId)
  const accountId = composerAccountId ?? shellAccountId

  const toInputRef = useRef<HTMLInputElement>(null)

  // ---- Draft autosave (task 8.6) ----

  const executor = useMemo(() => getExecutor(), [])

  /** Composer store → the serializable DraftInput shape. Cheap read of
   * already-loaded state (the autosave poll calls it every second). */
  const getDraftInput = useCallback((): DraftInput => {
    const state = useComposerStore.getState()
    const reply = state.mode.kind === "reply" ? state.mode : undefined
    const forward = state.mode.kind === "forward" ? state.mode : undefined
    const inReplyTo = reply?.inReplyTo
    const threadId = reply?.sourceThreadId ?? forward?.sourceThreadId
    return {
      to: state.to,
      cc: state.cc,
      bcc: state.bcc,
      subject: state.subject,
      bodyHtml: state.html,
      ...(state.attachments.length > 0
        ? {
            attachments: state.attachments.map((attachment) => ({
              filename: attachment.name,
              size: attachment.size,
            })),
          }
        : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(threadId ? { threadId } : {}),
    }
  }, [])

  const { flush } = useDraftAutosave({
    accountId: accountId ?? "",
    draftKey: draftKey ?? "",
    getDraftInput,
    executor,
    enabled: Boolean(accountId && draftKey),
  })

  // ---- Send (task 8.7) ----

  const [sending, setSending] = useState(false)
  /** Sanitized send-flow failure, shown above the footer with a Retry. */
  const [sendError, setSendError] = useState<string | null>(null)

  // Body HTML mirrors the editor (synced onUpdate); subject/recipients are
  // subscribed above.
  const html = useComposerStore((state) => state.html)

  const recipients = [...to, ...cc, ...bcc]
  const canSend =
    accountId !== null &&
    recipients.length > 0 &&
    !hasInvalidRecipient(recipients) &&
    (subject.trim() !== "" || html.trim() !== "")

  const handleSend = () => {
    if (sending || !accountId || !draftKey || !canSend) return
    setSending(true)
    setSendError(null)
    void (async () => {
      try {
        // Flush pending keystrokes first: it aligns the autosave baseline
        // with the last observed snapshot, so the unmount flush after
        // reset() cannot resurrect the row the send just deleted.
        await flush()
        const result = await sendComposerDraft({
          accountId,
          payload: getComposerPayload(),
          draftKey,
          mode,
        })
        if (result.status === "queued") {
          if (result.queuedOffline) {
            toast.info("Message queued")
          } else {
            toast.success("Message sent")
          }
          reset()
          // sendComposerDraft already deleted the draft row; this sweep
          // also removes snapshots the autosave poll had not observed yet.
          await deleteDraftByKey(executor, accountId, draftKey)
        } else {
          setSendError(result.error)
        }
      } catch (error) {
        // Typed validation errors and local write failures keep the
        // composer open with its content.
        setSendError(error instanceof Error ? error.message : String(error))
      } finally {
        setSending(false)
      }
    })()
  }

  // ---- Discard (task 8.6 confirmation) ----

  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const discardDraft = () => {
    void (async () => {
      // flush() (not saveNow) writes exactly the last observed snapshot,
      // re-aligning the autosave baseline so the unmount flush that fires
      // on reset() is a no-op and cannot re-insert the row deleted below.
      await flush()
      if (accountId && draftKey) {
        await deleteDraftByKey(executor, accountId, draftKey)
      }
      reset()
    })()
  }

  const handleDiscard = () => {
    // Spec: discarding a non-empty draft requires confirmation; an empty
    // one goes immediately.
    if (isDraftEmpty(getDraftInput())) {
      discardDraft()
      return
    }
    setConfirmDiscard(true)
  }

  // ---- Attachments (task 8.5) ----

  /** Depth counter for dragenter/dragleave — child elements fire leave
   * events while still inside the composer surface. */
  const dragDepth = useRef(0)
  const [dragActive, setDragActive] = useState(false)
  /** First cap/read rejection of the last add — cleared by the next one. */
  const [attachmentError, setAttachmentError] = useState<string | null>(null)

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    // preventDefault is what marks the surface as a drop target.
    event.preventDefault()
  }

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return
    void addFileAttachments(files).then((result) =>
      setAttachmentError(result.error ?? null)
    )
  }

  const handleAttachClick = () => {
    void pickAttachments().then((result) =>
      setAttachmentError(result.error ?? null)
    )
  }

  useEffect(() => {
    // Spec: a new compose opens with focus in the To field. Reply/forward
    // (8.4) pre-address the message, so body focus is their call.
    if (mode.kind === "new") {
      toInputRef.current?.focus()
    }
  }, [mode])

  const editor = useEditor({
    extensions: [
      // StarterKit v3 bundles underline + link; they are disabled here and
      // registered explicitly below (documented v3 pattern).
      StarterKit.configure({ link: false, underline: false }),
      Underline,
      LinkExtension.configure({
        // Links in mail open externally (D7); never navigate in-app.
        openOnClick: false,
      }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Placeholder.configure({ placeholder: "Write your message…" }),
    ],
    // Initial content only — rehydrated drafts (task 8.6) set store state
    // before this view mounts.
    content: useComposerStore.getState().html,
    editorProps: {
      attributes: {
        class: "min-h-40 outline-none",
        "aria-label": "Message body",
      },
    },
    onUpdate: ({ editor: current }) => setHtml(current.getHTML()),
  })

  // Cc/Bcc rows auto-reveal when a reply-all pre-fills them (task 8.4).
  const ccVisible = showCc || cc.length > 0
  const bccVisible = showBcc || bcc.length > 0

  return (
    <TooltipProvider delay={0}>
      <section
        aria-label={
          mode.kind === "reply"
            ? "Reply"
            : mode.kind === "forward"
              ? "Forward"
              : "New message"
        }
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex h-full min-h-96 flex-col bg-background ${
          dragActive ? "bg-primary/5 ring-2 ring-primary ring-inset" : ""
        }`}
      >
        <div className="flex flex-col gap-2 px-4 pt-4">
          <div className="flex items-center gap-3">
            <Label
              htmlFor="composer-to"
              className="w-14 shrink-0 text-muted-foreground"
            >
              To
            </Label>
            <RecipientField
              id="composer-to"
              recipients={to}
              onChange={setTo}
              placeholder="name@example.com"
              inputRef={toInputRef}
              accountId={accountId}
            />
            <div className="flex shrink-0 gap-0.5">
              <Button
                variant="ghost"
                size="xs"
                aria-expanded={ccVisible}
                onClick={toggleCc}
              >
                Cc
              </Button>
              <Button
                variant="ghost"
                size="xs"
                aria-expanded={bccVisible}
                onClick={toggleBcc}
              >
                Bcc
              </Button>
            </div>
          </div>

          {ccVisible ? (
            <div className="flex items-center gap-3">
              <Label
                htmlFor="composer-cc"
                className="w-14 shrink-0 text-muted-foreground"
              >
                Cc
              </Label>
              <RecipientField
                id="composer-cc"
                recipients={cc}
                onChange={setCc}
                placeholder="name@example.com"
                accountId={accountId}
              />
            </div>
          ) : null}

          {bccVisible ? (
            <div className="flex items-center gap-3">
              <Label
                htmlFor="composer-bcc"
                className="w-14 shrink-0 text-muted-foreground"
              >
                Bcc
              </Label>
              <RecipientField
                id="composer-bcc"
                recipients={bcc}
                onChange={setBcc}
                placeholder="name@example.com"
                accountId={accountId}
              />
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <Label
              htmlFor="composer-subject"
              className="w-14 shrink-0 text-muted-foreground"
            >
              Subject
            </Label>
            <Input
              id="composer-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Subject"
              autoComplete="off"
              className="border-0 bg-transparent px-0 focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
        </div>

        <Separator className="mt-3" />
        <ComposerToolbar editor={editor} />
        <Separator />

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">
          <div className={EDITOR_CONTENT_CLASS}>
            <EditorContent editor={editor} />
          </div>
        </div>

        {/* Attachment strip + inline cap/read errors (task 8.5). */}
        <AttachmentStrip />
        {attachmentError ? (
          <p role="alert" className="px-4 pb-2 text-xs text-destructive">
            {attachmentError}
          </p>
        ) : null}

        {/* Send-flow failure (task 8.7): sanitized error + Retry; the
            composer stays open with its content. */}
        {sendError ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 px-4 pb-2 text-xs text-destructive"
          >
            <span className="min-w-0 truncate">{sendError}</span>
            <Button variant="outline" size="xs" onClick={handleSend}>
              Retry
            </Button>
          </div>
        ) : null}

        <Separator />
        <footer className="flex items-center gap-2 px-4 py-3">
          <Button
            variant="ghost"
            className="me-auto"
            onClick={handleAttachClick}
          >
            <Paperclip aria-hidden />
            Attach file
          </Button>
          <Button variant="outline" onClick={handleDiscard}>
            Discard
          </Button>
          <Button disabled={!canSend || sending} onClick={handleSend}>
            {sending ? "Sending…" : "Send"}
          </Button>
        </footer>

        {/* Discard confirmation (task 8.6): required for non-empty drafts. */}
        <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Discard draft?</DialogTitle>
              <DialogDescription>
                Your message will be deleted.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setConfirmDiscard(false)}
              >
                Cancel
              </Button>
              <Button variant="destructive" onClick={discardDraft}>
                Discard
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </section>
    </TooltipProvider>
  )
}
