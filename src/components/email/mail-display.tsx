import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react"
import {
  CalendarPlus,
  ChevronDown,
  File as FileIcon,
  FileArchive as FileArchiveIcon,
  FileCode as FileCodeIcon,
  FileImage as FileImageIcon,
  FileSpreadsheet as FileSpreadsheetIcon,
  FileText as FileTextIcon,
  ImageOff,
  Lock,
  Paperclip,
  Save,
  SendHorizontal,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  combineSignatureStatuses,
  defaultPgpReceiveUiDeps,
  detectPgpContent,
  extractArmoredMessage,
  findInlineArmoredBlocks,
  isPgpEncryptedPayloadAttachment,
  NO_SIGNATURE,
  PgpReceiveError,
  spliceInlineBlocks,
  type DecryptedContent,
  type PgpReceiveUiDeps,
  type SignatureStatus,
  type SignatureTrust,
} from "@/services/crypto/pgp-receive"
import { getAttachmentsForMessage } from "@/services/db/attachments"
import { listContactsByAccount } from "@/services/db/contacts"
import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import type { AttachmentRow, MessageRow } from "@/services/db/messages"
import { parseContacts } from "@/services/db/messages"
import type { EmailAccount } from "@/services/email/types"
import { parseStoredAuthResults } from "@/services/email/auth-results"
import {
  attachmentRisk,
  type AttachmentRisk,
} from "@/services/attachments/attachment-policy"
import type { ScanOutcome } from "@/services/attachments/malware-lookup"
import {
  ensureAttachmentCached,
  getAttachmentContent,
  openAttachment,
  saveAttachmentAs,
  type AttachmentDeps,
  type FileActionDeps,
} from "@/services/attachments"
import {
  analyzePhishing,
  renderPlainTextAsHtml,
  sanitizeEmailHtml,
  type PhishingFinding,
} from "@/services/renderer"
import { markNotSpam } from "@/services/email-actions/thread-actions"
import { getJunkFilterEnabled } from "@/services/settings/preferences"
import {
  isThreadInSentFolder,
  openSendAgainForMessage,
} from "@/services/composer/send-again"
import {
  canUnsubscribe,
  createAutoArchiveRule,
  hasAutoArchiveRule,
  performUnsubscribe,
  unsubscribeTargetsFromHeaders,
  UnsubscribeError,
  type MailtoTarget,
  type UnsubscribeDeps,
} from "@/services/security/unsubscribe"
import { useComposerStore } from "@/stores/composer-store"
import { useUiStore } from "@/stores/ui-store"
import { formatRowTimestamp } from "@/stores/thread-list-store"
import type { MessageSourceDeps } from "@/services/email/message-source"
import { IcsPreviewDialog } from "@/components/calendar/ics-preview-dialog"
import {
  isCalendarAttachment,
  readIcsAttachmentText,
} from "@/services/calendar/ics-detect"
import { SafeEmailFrame } from "@/components/email/safe-email-frame"
import { AuthBadge } from "./auth-badge"
import { PgpPassphraseDialog } from "./pgp-passphrase-dialog"
import { SourceViewDialog } from "./source-view-dialog"
import { TranslateControl } from "./translate-control"
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
 *
 * Phishing checks (task 18.1, design D12): the sanitized body, the From
 * header, the account's contacts and the account's own address run
 * through analyzePhishing once per displayed message (memoized per
 * message id beside the cid cache); findings render as a dismissible
 * warning banner above the body. Advisory only — nothing is blocked.
 *
 * PGP receive (task 18.6, design D11): messages with PGP content —
 * PGP/MIME encrypted (the armored payload rides an attachment row),
 * PGP/MIME signed (detection-only: the exact signed bytes are not
 * stored) or inline armored blocks in the body — are detected per
 * displayed message. Encrypted content is decrypted on demand behind a
 * passphrase prompt (per use, never cached) and the decrypted text is
 * spliced into the body source BEFORE the same sanitized pipeline as
 * any other body (never bypassing it). Signatures get a visible trust
 * banner (valid / invalid / unknown-signer). Every failure — no key,
 * wrong passphrase, no matching key, corrupt armor — shows the
 * ORIGINAL content with an explanatory error banner; the stored message
 * is never altered (decryption is display-time only) and the thread
 * always opens.
 *
 * Attachment security (tasks 18.8/18.9, designs D17/D18): every
 * attachment row carries a warning chip for dangerous formats
 * (attachment-policy tiers), and the Open button runs the file-actions
 * open path — the first-open confirmation and (opt-in) malware hash
 * lookup live there; the row renders the lookup's verdict chip once a
 * scan has happened. Confirm dialogs are the file-actions seam (native
 * plugin-dialog ask), not this component's concern.
 *
 * Junk filter (task 18.10, design D19): a message whose thread sits in
 * the account's Spam folder while the account's local adaptive junk
 * filter is ON shows a classification banner with an inline "Not spam"
 * button — the filter's one-click correction. The action runs the SAME
 * markNotSpam flow as the context menu (thread returns to the inbox; the
 * move op replays server-side) and, because that action trains the
 * filter, the correction also teaches it ham — mistakes are recoverable
 * and immediately retrain the model. Scope decision (documented per the
 * task): the banner keys on threads.is_spam + the per-account toggle —
 * auto-classified and user-marked spam share the affordance rather than
 * carrying extra "auto-junked" state; for IMAP accounts only (gmail is
 * exempt and its spam folder needs no local banner), and it degrades off
 * wherever the db or the account is unavailable.
 *
 * Unsubscribe (task 18.3, design D13): a message whose stored headers
 * carry a parseable List-Unsubscribe shows an Unsubscribe banner. With an
 * RFC 8058 one-click target (the List-Unsubscribe-Post header + an https
 * URL) the click confirms the exact POST target first, then performs it
 * through security/unsubscribe.ts (live POST, or the queued
 * unsubscribe_post op while offline) and toasts the outcome; with only a
 * mailto entry the composer opens pre-addressed (the compose-to-contact
 * seam). After either, the banner offers to auto-archive future mail from
 * the sender — an ordinary from:sender → archive rule via the rules
 * service, visible/deletable in the rules settings.
 *
 * Send again (batch C3): an expanded message whose thread sits in the
 * account's sent folder grows a "Send again" entry beside View source —
 * it reopens the message as a brand-new draft through
 * services/composer/send-again.ts (original recipients/subject/body,
 * fresh threading, attachments restored only when their bytes are
 * recoverable, with a visible notice when they are not).
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
   * Attachment seams for cid: resolution AND the save/open file actions
   * (FileActionDeps extends AttachmentDeps, so the open-path security
   * gates — the D17 confirm and the D18 malware scan — resolve through
   * the same injectable object). Production resolves to the Tauri
   * plugins + global preferences; tests inject fakes.
   */
  attachmentDeps?: FileActionDeps
  /**
   * The PGP receive seams (decrypt/verify) for task 18.6. Production
   * resolves to the openpgp-backed default (lazy-loaded, D11); tests
   * inject fakes so the jsdom realm stays openpgp-free.
   */
  pgpDeps?: PgpReceiveUiDeps
  /**
   * The unsubscribe seams (task 18.3): the one-click POST transport.
   * Production resolves to the Rust command transport
   * (unsubscribe_one_click_post); tests inject a stub so the jsdom realm
   * stays network-free. (Offline detection uses the real online store in
   * both realms.)
   */
  unsubscribeDeps?: UnsubscribeDeps
  /**
   * The raw-source seam (task 1.2): overrides the provider round-trip.
   * Production resolves through the provider factory; tests inject a stub
   * so the jsdom realm stays network-free.
   */
  sourceDeps?: MessageSourceDeps
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
  pgpDeps,
  unsubscribeDeps,
  sourceDeps,
}: MailDisplayProps) {
  const senderName =
    message.from_name || message.from_address || "Unknown sender"
  const initials = getInitials(message.from_name, message.from_address)
  const avatarClass = avatarTokenClass(message.from_address)
  /** Raw-source dialog (task 1.2): mounted fresh per open below. */
  const [sourceOpen, setSourceOpen] = useState(false)

  // Send again (batch C3): the affordance exists only for SENT messages —
  // resolved per message from the ground truth (the thread sits in the
  // account's sent-role folder), the same membership model the Sent list
  // itself uses. A lookup failure degrades to hiding the action, like
  // every other advisory read in this component.
  const [inSentFolder, setInSentFolder] = useState(false)
  useEffect(() => {
    if (!account) return
    let cancelled = false
    resolveExecutor()
      .then((executor) =>
        isThreadInSentFolder(executor, account.id, message.thread_id)
      )
      .then((inSent) => {
        if (!cancelled) setInSentFolder(inSent)
      })
      .catch((error) => {
        console.warn("[mail-display] sent-folder lookup failed", error)
        if (!cancelled) setInSentFolder(false)
      })
    return () => {
      cancelled = true
    }
  }, [account, message.thread_id])

  /** Send again (batch C3): opens the composer prefilled as a NEW message
   * from this sent one — see services/composer/send-again.ts. */
  const handleSendAgain = () => {
    void openSendAgainForMessage(message.id, {
      ...(attachmentDeps ? { attachmentDeps } : {}),
    })
  }

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
          {/* Authentication verdicts (task 2.2, design D10): compact
           * pass/fail/none chips beside the header metadata; absent
           * auth_results renders nothing (spec: no headers, no badge). */}
          <AuthBadge authResults={message.auth_results} />
          {/* Send again (batch C3): sent messages only — reopens the
              message as a brand-new draft (fresh thread, no reply
              headers; attachments restored when their bytes survive). */}
          {inSentFolder && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-muted-foreground"
              data-testid="send-again"
              onClick={handleSendAgain}
            >
              <SendHorizontal className="size-3.5" />
              Send again
            </Button>
          )}
          {/* Raw message source (task 1.2, design D6): fetches through the
           * provider seam on open and renders inert in the sandboxed frame
           * (source-view-dialog) — read-only with an exact-copy affordance,
           * no read-state change beyond the open that already happened. */}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs text-muted-foreground"
            data-testid="view-source"
            onClick={() => setSourceOpen(true)}
          >
            <FileCodeIcon className="size-3.5" />
            View source
          </Button>
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
      {/* Per-message translate control (task 5.1, ai-assistance spec
          "Per-message translation"): mounted directly under the header so
          the translation panel appears beside the original (the body
          below stays fully visible). The control is SELF-gating — AI not
          configured or the translation surface off renders nothing, the
          same QuickReplyChips posture — so this mount carries no gating
          knowledge. (MailDisplay has no thread-level disabled state to
          forward; TranslateControl's disabled prop stays for the thread
          chrome to wire when one lands.) */}
      <TranslateControl message={message} />
      <MessageBody
        message={message}
        imagesAllowed={imagesAllowed}
        onAllowSender={onAllowSender}
        account={account}
        attachmentDeps={attachmentDeps}
        pgpDeps={pgpDeps}
        unsubscribeDeps={unsubscribeDeps}
      />
      <AttachmentList
        message={message}
        account={account}
        attachmentDeps={attachmentDeps}
      />
      {/* Task 1.2: the raw-source dialog behind the View source entry.
          Mounted only while open so every open refetches (design D6: no
          cache) and the loading/copy states start clean. The fetch targets
          the message's OWNING account, like every account-scoped action. */}
      {sourceOpen && (
        <SourceViewDialog
          message={message}
          account={account}
          open
          onOpenChange={setSourceOpen}
          deps={sourceDeps}
        />
      )}
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
// PGP receive (task 18.6)
// ---------------------------------------------------------------------------

/**
 * One decrypt/verify result for a message. `bodySource` carries the
 * inline kind's spliced body source (replaces the raw body BEFORE the
 * sanitized pipeline); `entity` carries the PGP/MIME-encrypted kind's
 * decrypted content (replaces the body-less stored row). Neither is
 * ever written back to the database — decryption is display-time only.
 */
interface PgpEntry {
  /** The detection the result was computed for (see pgpSourceKey). */
  source: string
  bodySource: string | null
  entity: DecryptedContent | null
  signature: SignatureStatus
  /** First block failure detail; null when every block succeeded. */
  error: string | null
}

/** The PGP flow stage: idle (encrypted content waits for the unlock
 * affordance), working (a decrypt attempt runs), prompt (the passphrase
 * dialog is open, with its per-attempt error), done (a result renders)
 * and failed (the error banner shows; the original content stays). */
type PgpStage =
  | { stage: "idle" }
  | { stage: "working" }
  | { stage: "prompt"; error: string | null }
  | { stage: "done"; entry: PgpEntry }
  | { stage: "failed"; error: string }

/** Per-message memo (the resolvedBodyCache pattern): collapse/expand
 * remounts must not re-prompt for the passphrase. Holds the DISPLAY
 * result only — never the passphrase, never unlocked key material. */
const pgpEntryCache = new Map<string, PgpEntry>()

/** The error text a banner shows: PgpReceiveError messages are written
 * to be user-facing; anything else degrades to a generic line (the raw
 * error is logged by the caller). */
function pgpErrorMessage(error: unknown): string {
  return error instanceof PgpReceiveError
    ? error.message
    : "the message could not be decrypted"
}

/**
 * Verify every inline clear-signed block in `source` (the passphrase-free
 * auto-check) and splice the signed text back in place of each armor —
 * string surgery on the pre-sanitize source; a failed block keeps its
 * ORIGINAL armored text (the failure path shows the raw content).
 */
async function verifyInlineBlocks(
  source: string,
  verifyClearSigned: (
    clearSigned: string
  ) => Promise<{ content: string; signature: SignatureStatus }>,
  sourceKey: string
): Promise<PgpEntry> {
  const replacements = new Map<string, string | null>()
  const statuses: SignatureStatus[] = []
  let failure: unknown = null
  for (const block of findInlineArmoredBlocks(source)) {
    try {
      const result = await verifyClearSigned(block.block)
      replacements.set(block.block, result.content)
      statuses.push(result.signature)
    } catch (error) {
      replacements.set(block.block, null)
      failure ??= error
    }
  }
  return {
    source: sourceKey,
    bodySource: spliceInlineBlocks(source, replacements),
    entity: null,
    signature:
      statuses.length > 0 ? combineSignatureStatuses(statuses) : NO_SIGNATURE,
    error: failure === null ? null : pgpErrorMessage(failure),
  }
}

interface InlineDecryptOutcome {
  entry: PgpEntry
  /** True when at least one encrypted block decrypted (partial failures
   * still count — the spliced result renders with its error note). */
  decryptedAny: boolean
  /** The first block failure, for the wrong-passphrase re-prompt check. */
  failure: unknown
}

/**
 * Decrypt the inline encrypted blocks of `source` (mixed bodies may also
 * carry clear-signed blocks — they verify alongside), splicing results
 * in place of each armor. A wrong passphrase surfaces through `failure`
 * so the caller can re-prompt inside the dialog.
 */
async function decryptInlineBlocks(
  source: string,
  decryptArmored: (armored: string) => Promise<DecryptedContent>,
  verifyClearSigned: (
    clearSigned: string
  ) => Promise<{ content: string; signature: SignatureStatus }>,
  sourceKey: string
): Promise<InlineDecryptOutcome> {
  const replacements = new Map<string, string | null>()
  const statuses: SignatureStatus[] = []
  let decryptedAny = false
  let failure: unknown = null
  for (const block of findInlineArmoredBlocks(source)) {
    if (block.kind === "encrypted") {
      try {
        const result = await decryptArmored(block.block)
        replacements.set(block.block, result.text ?? result.html ?? "")
        statuses.push(result.signature)
        decryptedAny = true
      } catch (error) {
        replacements.set(block.block, null)
        failure ??= error
      }
    } else {
      try {
        const result = await verifyClearSigned(block.block)
        replacements.set(block.block, result.content)
        statuses.push(result.signature)
      } catch (error) {
        replacements.set(block.block, null)
        failure ??= error
      }
    }
  }
  return {
    entry: {
      source: sourceKey,
      bodySource: spliceInlineBlocks(source, replacements),
      entity: null,
      signature:
        statuses.length > 0 ? combineSignatureStatuses(statuses) : NO_SIGNATURE,
      error: failure === null ? null : pgpErrorMessage(failure),
    },
    decryptedAny,
    failure,
  }
}

/** The trust banner's copy/icon/tint per signature state ("none" never
 * renders a banner). */
const SIGNATURE_BANNER: Record<
  SignatureTrust,
  { text: string; Icon: LucideIcon; className: string }
> = {
  valid: {
    text: "Signed by a known key — the signature is valid.",
    Icon: ShieldCheck,
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
  },
  invalid: {
    text: "Signature check FAILED — the content was modified after signing or does not match the signer's key.",
    Icon: ShieldAlert,
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  "unknown-signer": {
    text: "Signed by an unknown key — import the signer's public key to verify this signature.",
    Icon: ShieldAlert,
    className: "border-border bg-muted/50 text-muted-foreground",
  },
  none: {
    text: "",
    Icon: ShieldAlert,
    className: "border-border bg-muted/50 text-muted-foreground",
  },
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
  pgpDeps: pgpDepsOverride,
  unsubscribeDeps,
}: {
  message: MessageRow
  imagesAllowed: boolean
  onAllowSender: (senderEmail: string) => void
  account: EmailAccount | null
  attachmentDeps: FileActionDeps | undefined
  pgpDeps: PgpReceiveUiDeps | undefined
  unsubscribeDeps: UnsubscribeDeps | undefined
}) {
  // The PGP seams: the module-level default is stable, so tests that do
  // not inject anything never re-trigger the effects below.
  const pgpDeps = pgpDepsOverride ?? defaultPgpReceiveUiDeps

  // "Show images" applies to this message only (component state); the
  // allowlist decision arrives via the imagesAllowed prop.
  const [showImagesOnce, setShowImagesOnce] = useState(false)
  const effectiveAllowed = imagesAllowed || showImagesOnce

  // ---- PGP receive (task 18.6) ------------------------------------------

  // Detection needs the attachment rows too: the PGP/MIME shapes ride on
  // them (the armored payload / detached signature surface as rows). The
  // same query AttachmentList runs — a local SELECT per expanded message.
  const [pgpAttachments, setPgpAttachments] = useState<AttachmentRow[] | null>(
    null
  )
  useEffect(() => {
    let cancelled = false
    resolveExecutor()
      .then((executor) => getAttachmentsForMessage(executor, message.id))
      .then((rows) => {
        if (!cancelled) setPgpAttachments(rows)
      })
      .catch((error) => {
        // No db (tests/outside Tauri) — PGP/MIME detection degrades off.
        console.warn("[mail-display] attachment lookup failed", error)
        if (!cancelled) setPgpAttachments([])
      })
    return () => {
      cancelled = true
    }
  }, [message.id])

  const pgpDetection = useMemo(
    () =>
      detectPgpContent({
        bodyText: message.body_text,
        bodyHtml: message.body_html,
        attachments:
          pgpAttachments?.map((row) => ({
            filename: row.filename,
            mimeType: row.mime_type,
          })) ?? [],
      }),
    [message.body_text, message.body_html, pgpAttachments]
  )

  // What a cached/in-progress result was computed for — kind + the exact
  // body source (inline kinds) or the payload row ids (PGP/MIME kinds) —
  // so a stale memo never renders for changed content.
  const pgpSourceKey = useMemo(() => {
    if (pgpDetection.kind === "none") return ""
    if (pgpDetection.source === "attachments") {
      return `${pgpDetection.kind}:${pgpAttachments?.map((row) => row.id).join(",") ?? ""}`
    }
    const body =
      pgpDetection.source === "html" ? message.body_html : message.body_text
    return `${pgpDetection.kind}:${pgpDetection.source}:${body}`
  }, [pgpDetection, pgpAttachments, message.body_html, message.body_text])

  // The decrypt/verify result for this message. Read like the cid cache:
  // state seeded at mount, PLUS a pure per-render cache lookup so a
  // collapse/expand remount renders the memoized result immediately.
  const [pgp, setPgp] = useState<PgpStage>(() => {
    const cached = pgpEntryCache.get(message.id)
    return cached ? { stage: "done", entry: cached } : { stage: "idle" }
  })
  // True while the passphrase-free inline signature check is in flight.
  const [pgpChecking, setPgpChecking] = useState(false)
  // The source the auto-verify was last attempted for — a failed check
  // must NOT re-run on every render (the failure banner stands).
  const pgpAttemptedRef = useRef<string | null>(null)
  const cachedPgpEntry = pgpEntryCache.get(message.id)
  const pgpEntry =
    pgp.stage === "done" && pgp.entry.source === pgpSourceKey
      ? pgp.entry
      : cachedPgpEntry && cachedPgpEntry.source === pgpSourceKey
        ? cachedPgpEntry
        : null

  // The auto-verify's skip signal: the source key of a "done" stage's
  // entry, null in every other stage. A narrowed scalar (the union itself
  // carries `entry` only on "done") so the effect below can read it in
  // its body and its deps. "working" never had an entry to compare, so
  // the null falls through to the attempted-ref guard exactly as before.
  const pgpStageEntrySource = pgp.stage === "done" ? pgp.entry.source : null

  // Inline clear-signed blocks verify WITHOUT a passphrase (public keys
  // only), so this runs as soon as the message is displayed — the same
  // once-per-message memo pattern as the phishing analysis above. A
  // cache hit never re-verifies (the render lookup above already shows
  // the memoized result).
  useEffect(() => {
    if (!account || pgpDetection.kind !== "inline-signed") return
    if (pgpStageEntrySource === pgpSourceKey) {
      return
    }
    const source =
      pgpDetection.source === "html" ? message.body_html : message.body_text
    if (!source || pgpAttemptedRef.current === pgpSourceKey) return
    pgpAttemptedRef.current = pgpSourceKey
    let cancelled = false
    ;(async () => {
      setPgpChecking(true)
      try {
        const executor = await resolveExecutor()
        const entry = await verifyInlineBlocks(
          source,
          (clearSigned) =>
            pgpDeps.verifyClearSigned({
              executor,
              accountId: account.id,
              clearSigned,
            }),
          pgpSourceKey
        )
        pgpEntryCache.set(message.id, entry)
        if (!cancelled) setPgp({ stage: "done", entry })
      } catch (error) {
        console.warn("[mail-display] signature verification failed", error)
        if (!cancelled)
          setPgp({ stage: "failed", error: pgpErrorMessage(error) })
      } finally {
        if (!cancelled) setPgpChecking(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    pgpStageEntrySource,
    pgpDetection.kind,
    pgpDetection.source,
    pgpSourceKey,
    account,
    message.id,
    message.body_html,
    message.body_text,
    pgpDeps,
  ])

  /**
   * The passphrase submit: decrypt the detected encrypted content (inline
   * blocks, or the PGP/MIME payload fetched through the attachment cache)
   * and memoize the result. Failures keep the ORIGINAL content visible —
   * a wrong passphrase re-prompts inside the dialog, everything else
   * shows the error banner (spec: the thread always opens).
   */
  async function handlePgpDecrypt(passphrase: string): Promise<void> {
    if (!account) return
    setPgp({ stage: "working" })
    try {
      const executor = await resolveExecutor()
      if (pgpDetection.kind === "inline-encrypted") {
        const source =
          pgpDetection.source === "html" ? message.body_html : message.body_text
        if (!source) {
          throw new PgpReceiveError("bad-armor", "the message body is missing")
        }
        const outcome = await decryptInlineBlocks(
          source,
          (armored) =>
            pgpDeps.decryptArmored({
              executor,
              accountId: account.id,
              passphrase,
              armored,
            }),
          (clearSigned) =>
            pgpDeps.verifyClearSigned({
              executor,
              accountId: account.id,
              clearSigned,
            }),
          pgpSourceKey
        )
        if (outcome.decryptedAny) {
          pgpEntryCache.set(message.id, outcome.entry)
          setPgp({ stage: "done", entry: outcome.entry })
          return
        }
        // Nothing decrypted: the blocks keep their original armor. A wrong
        // passphrase re-prompts; any other failure degrades to the banner.
        if (
          outcome.failure instanceof PgpReceiveError &&
          outcome.failure.kind === "wrong-passphrase"
        ) {
          setPgp({ stage: "prompt", error: outcome.failure.message })
        } else {
          setPgp({ stage: "failed", error: pgpErrorMessage(outcome.failure) })
        }
        return
      }
      if (pgpDetection.kind === "pgp-mime-encrypted") {
        const payload = pgpAttachments?.find((row) =>
          isPgpEncryptedPayloadAttachment({
            filename: row.filename,
            mimeType: row.mime_type,
          })
        )
        if (!payload) {
          throw new PgpReceiveError(
            "bad-armor",
            "the encrypted payload part is missing from this message"
          )
        }
        // The EXISTING attachment-cache seam (D15) fetches the armored
        // part the way open/save do; nothing writes to the message row.
        const bytes = await getAttachmentContent(
          executor,
          account,
          message,
          payload,
          attachmentDeps ?? {}
        )
        const armored = extractArmoredMessage(new TextDecoder().decode(bytes))
        if (!armored) {
          throw new PgpReceiveError(
            "bad-armor",
            "the encrypted payload part does not carry armored PGP data"
          )
        }
        const result = await pgpDeps.decryptArmored({
          executor,
          accountId: account.id,
          passphrase,
          armored,
        })
        if (!result.html && !result.text) {
          throw new PgpReceiveError(
            "bad-armor",
            "the decrypted message is empty"
          )
        }
        const entry: PgpEntry = {
          source: pgpSourceKey,
          bodySource: null,
          entity: result,
          signature: result.signature,
          error: null,
        }
        pgpEntryCache.set(message.id, entry)
        setPgp({ stage: "done", entry })
        return
      }
      setPgp({ stage: "idle" })
    } catch (error) {
      if (
        error instanceof PgpReceiveError &&
        error.kind === "wrong-passphrase"
      ) {
        setPgp({ stage: "prompt", error: error.message })
      } else {
        console.warn("[mail-display] pgp decrypt failed", error)
        setPgp({ stage: "failed", error: pgpErrorMessage(error) })
      }
    }
  }

  // ---- Body source (sanitized pipeline) ----------------------------------

  // Decrypted content re-enters the SAME pipeline as any body: inline
  // results are spliced into the raw body source, PGP/MIME results
  // replace the (body-less) stored row — both then flow through
  // sanitizeEmailHtml below like every other message. Never injected
  // after sanitization.
  const pgpBodySource = pgpEntry?.bodySource ?? null
  const pgpEntity: DecryptedContent | null = pgpEntry?.entity ?? null

  const bodyHtml = useMemo(() => {
    const options = { blockRemoteImages: !effectiveAllowed }
    if (pgpBodySource !== null) {
      return pgpDetection.source === "html"
        ? sanitizeEmailHtml(pgpBodySource, options)
        : sanitizeEmailHtml(renderPlainTextAsHtml(pgpBodySource), options)
    }
    if (pgpEntity !== null) {
      if (pgpEntity.html) return sanitizeEmailHtml(pgpEntity.html, options)
      if (pgpEntity.text) {
        return sanitizeEmailHtml(renderPlainTextAsHtml(pgpEntity.text), options)
      }
    }
    if (message.body_html) {
      return sanitizeEmailHtml(message.body_html, options)
    }
    if (message.body_text) {
      return sanitizeEmailHtml(
        renderPlainTextAsHtml(message.body_text),
        options
      )
    }
    return null
  }, [
    message.body_html,
    message.body_text,
    effectiveAllowed,
    pgpBodySource,
    pgpEntity,
    pgpDetection.source,
  ])

  const hasCidRefs = bodyHtml !== null && extractCidRefs(bodyHtml).length > 0
  const [resolved, setResolved] = useState<ResolvedBody | null>(() =>
    bodyHtml === null ? null : (resolvedBodyCache.get(message.id) ?? null)
  )

  // Phishing analysis (task 18.1, design D12). Runs once per displayed
  // message: the per-message memo below is keyed by message id + source
  // html (the same shape as the cid cache), so collapse/expand remounts
  // and the image-policy reloads never re-analyze. Contacts come from the
  // message's account; own addresses are the account email today (aliases
  // will slot in when they land — see analyzePhishing's docs). Analysis
  // failure degrades to no findings; it must never block the body.
  const [findings, setFindings] = useState<PhishingFinding[]>(() =>
    bodyHtml === null
      ? []
      : phishingCache.get(message.id)?.source === bodyHtml
        ? (phishingCache.get(message.id)?.findings ?? [])
        : []
  )
  const [phishingDismissed, setPhishingDismissed] = useState(false)

  // DMARC failure → phishing treatment (task 2.2, design D10). The
  // stored auth verdicts are parsed with the shared accessor; a dmarc
  // `fail` is folded into the SAME banner the analysis findings drive —
  // D10's "phishing-banner integration reuses the existing warning banner
  // with a dmarc-fail trigger" — as one synthetic finding appended after
  // the analysis results. The display memo (not the cache) carries it, so
  // the ingestion-owned phishingCache stays free of display-side input.
  const authResults = useMemo(
    () => parseStoredAuthResults(message.auth_results),
    [message.auth_results]
  )
  const dmarcFailed = authResults?.dmarc === "fail"
  const displayFindings = useMemo(
    () => (dmarcFailed ? [...findings, DMARC_FAIL_FINDING] : findings),
    [findings, dmarcFailed]
  )

  // ---- Junk filter banner (task 18.10, design D19) -----------------------

  // "junk" shows the banner; "corrected" hides it (the Not-spam click —
  // the thread is on its way back to the inbox). Null = nothing to show.
  const [junkState, setJunkState] = useState<"junk" | "corrected" | null>(null)

  // Banner visibility is read, not stored: spam-placed thread + the
  // account's junk-filter toggle on. IMAP only (gmail is exempt, D19);
  // every failure degrades to no banner — advisory UI must never block
  // the message, same contract as the phishing analysis above. (This
  // component is keyed by message id upstream, so the lookup runs once
  // per mounted message.)
  useEffect(() => {
    if (!account || account.type !== "imap") return
    let cancelled = false
    resolveExecutor()
      .then((executor) =>
        Promise.all([
          getJunkFilterEnabled(executor, account.id),
          executor.select<{ is_spam: number }>(
            "SELECT is_spam FROM threads WHERE id = $1",
            [message.thread_id]
          ),
        ])
      )
      .then(([enabled, rows]) => {
        if (!cancelled && enabled && rows[0]?.is_spam === 1) {
          setJunkState("junk")
        }
      })
      .catch((error) => {
        console.warn("[mail-display] junk banner lookup failed", error)
      })
    return () => {
      cancelled = true
    }
  }, [account, message.thread_id])

  /** The banner's "Not spam" click (D19's one-click retraining): the
   * SAME markNotSpam flow the context menu runs — thread back to the
   * inbox, move op queued, and the action's training hook teaches the
   * filter ham. Failures restore the banner so the correction stays
   * available. */
  function handleJunkNotSpam(): void {
    if (!account) return
    setJunkState("corrected")
    resolveExecutor()
      .then((executor) => markNotSpam(executor, account.id, message.thread_id))
      .catch((error) => {
        console.warn("[mail-display] not-spam correction failed", error)
        setJunkState("junk")
      })
  }

  // The unsubscribe banner (task 18.3), shown beside the junk banner in
  // both body branches — its own component below.
  const unsubscribeBanner = (
    <UnsubscribeBanner
      message={message}
      account={account}
      deps={unsubscribeDeps}
    />
  )

  useEffect(() => {
    if (bodyHtml === null) return
    const cached = phishingCache.get(message.id)
    if (cached && cached.source === bodyHtml) return
    let cancelled = false
    const ownAddresses = account ? [account.email] : []
    const contacts = account
      ? resolveExecutor()
          .then((executor) => loadContactsForAccount(executor, account.id))
          .catch((error) => {
            // No db (tests/outside Tauri) — analyze without contacts.
            console.warn("[mail-display] contacts unavailable", error)
            return []
          })
      : Promise.resolve([])
    contacts
      .then((rows) => {
        if (cancelled) return
        const next = analyzePhishing({
          fromName: message.from_name,
          fromAddress: message.from_address,
          bodyHtml,
          contacts: rows,
          ownAddresses,
        })
        phishingCache.set(message.id, { source: bodyHtml, findings: next })
        setFindings(next)
      })
      .catch((error) => {
        console.warn("[mail-display] phishing analysis failed", error)
        if (!cancelled) setFindings([])
      })
    return () => {
      cancelled = true
    }
  }, [bodyHtml, message, account])

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

  // The PGP banners + passphrase dialog, shown above the body in both the
  // body-less and the body-rendering branches (an undecrypted PGP/MIME
  // message has no stored body — its banner must still appear).
  const signatureBanner =
    pgpChecking === true
      ? {
          trust: "checking" as const,
          text: "Checking signature…",
          Icon: ShieldAlert,
          className: "border-border bg-muted/50 text-muted-foreground",
        }
      : pgpEntry !== null && pgpEntry.signature.trust !== "none"
        ? {
            trust: pgpEntry.signature.trust,
            ...SIGNATURE_BANNER[pgpEntry.signature.trust],
          }
        : null

  const pgpBanners = (
    <>
      {pgpDetection.kind === "pgp-mime-signed" && (
        <div
          data-testid="pgp-mime-signed-banner"
          className="mb-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
        >
          This message is PGP/MIME-signed. Its signature cannot be verified from
          the stored copy.
        </div>
      )}
      {(pgpDetection.kind === "inline-encrypted" ||
        pgpDetection.kind === "pgp-mime-encrypted") &&
        pgpEntry === null &&
        pgp.stage !== "failed" && (
          <div
            data-testid="pgp-encrypted-banner"
            className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
          >
            <Lock className="size-3.5 shrink-0" />
            <span>This message is encrypted.</span>
            {account !== null && (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto h-7"
                data-testid="pgp-decrypt-button"
                onClick={() => setPgp({ stage: "prompt", error: null })}
              >
                Decrypt
              </Button>
            )}
          </div>
        )}
      {signatureBanner !== null && (
        <div
          data-testid="pgp-signature-banner"
          data-signature={signatureBanner.trust}
          className={cn(
            "mb-2 flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
            signatureBanner.className
          )}
        >
          <signatureBanner.Icon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{signatureBanner.text}</span>
        </div>
      )}
      {(pgp.stage === "failed" || (pgpEntry?.error ?? null) !== null) && (
        <div
          data-testid="pgp-error-banner"
          role="alert"
          className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {pgp.stage === "failed" ? pgp.error : pgpEntry?.error}
            </span>
          </div>
        </div>
      )}
      <PgpPassphraseDialog
        open={pgp.stage === "prompt" || pgp.stage === "working"}
        submitting={pgp.stage === "working"}
        error={pgp.stage === "prompt" ? pgp.error : null}
        onSubmit={(passphrase) => {
          void handlePgpDecrypt(passphrase)
        }}
        onCancel={() => setPgp({ stage: "idle" })}
      />
    </>
  )

  // The junk banner, shown above the body in both the body-less and the
  // body-rendering branches (a spammed message may have no stored body —
  // its correction affordance must still appear).
  const junkBanner =
    junkState === "junk" ? (
      <div
        data-testid="junk-banner"
        className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
      >
        <ShieldAlert className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          Your junk filter placed this conversation in Spam.
        </span>
        {account !== null && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7"
            data-testid="junk-not-spam"
            onClick={handleJunkNotSpam}
          >
            Not spam
          </Button>
        )}
      </div>
    ) : null

  if (bodyHtml === null) {
    return (
      <div className="pt-3">
        {junkBanner}
        {unsubscribeBanner}
        {pgpBanners}
        <p className="text-sm text-muted-foreground">(no content)</p>
      </div>
    )
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
      {junkBanner}
      {unsubscribeBanner}
      {displayFindings.length > 0 && !phishingDismissed && (
        <div
          data-testid="phishing-banner"
          role="alert"
          className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Suspicious message</p>
              <ul className="mt-1 grid gap-0.5">
                {displayFindings.map((finding) => (
                  <li key={finding.kind}>{finding.detail}</li>
                ))}
              </ul>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0"
              data-testid="dismiss-phishing"
              onClick={() => setPhishingDismissed(true)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {pgpBanners}
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
// Unsubscribe (task 18.3, design D13)
// ---------------------------------------------------------------------------

/** The banner's stages: offering the action, confirming the exact POST
 * target, and the post-click state (done = outcome text + the
 * auto-archive offer). */
type UnsubscribeStage =
  { stage: "idle" } | { stage: "confirm"; url: string } | { stage: "done" }

/**
 * The Unsubscribe affordance: rendered for a message whose stored headers
 * JSON parses into actionable targets (security/unsubscribe.ts owns the
 * RFC 2369/8058 grammar). One-click targets confirm the exact URL first
 * (the POST leaves the machine — the user sees where it goes), then
 * performUnsubscribe posts live or queues the replay op while offline,
 * with the outcome toasted. A mailto-only message skips the confirm (the
 * composer is itself reviewable) and opens pre-addressed through the same
 * seam compose-to-contact uses. The post-click offer creates an ordinary
 * from:sender → archive rule via the rules service — deduplicated by
 * hasAutoArchiveRule so repeat offers stay a no-op.
 */
function UnsubscribeBanner({
  message,
  account,
  deps,
}: {
  message: MessageRow
  account: EmailAccount | null
  deps: UnsubscribeDeps | undefined
}): ReactElement | null {
  const targets = useMemo(
    () => unsubscribeTargetsFromHeaders(message.headers),
    [message.headers]
  )
  const [stage, setStage] = useState<UnsubscribeStage>({ stage: "idle" })
  // The offer's settled state (rule created or already present) — keeps
  // the banner honest after the click without re-querying per render.
  const [autoArchived, setAutoArchived] = useState(false)

  if (!account || !canUnsubscribe(targets)) return null

  const oneClickUrl = targets.oneClickUrls[0]
  const mailto = targets.mailtos[0]

  function handleUnsubscribe(): void {
    if (!account) return
    if (oneClickUrl) {
      setStage({ stage: "confirm", url: oneClickUrl })
      return
    }
    if (mailto) openUnsubscribeComposer(account, mailto)
  }

  async function handleConfirm(): Promise<void> {
    if (!account || !oneClickUrl) return
    try {
      const executor = await resolveExecutor()
      const outcome = await performUnsubscribe(
        executor,
        account.id,
        oneClickUrl,
        deps
      )
      toast.success(
        outcome.kind === "queued"
          ? "Unsubscribe queued — it will send when you are back online"
          : "Unsubscribed"
      )
      setStage({ stage: "done" })
    } catch (error) {
      console.warn("[mail-display] unsubscribe failed", error)
      toast.error(
        error instanceof UnsubscribeError
          ? error.message
          : "The unsubscribe request failed"
      )
      setStage({ stage: "idle" })
    }
  }

  async function handleAutoArchive(): Promise<void> {
    if (!account || !message.from_address) return
    try {
      const executor = await resolveExecutor()
      if (
        !(await hasAutoArchiveRule(executor, account.id, message.from_address))
      ) {
        await createAutoArchiveRule(executor, account.id, message.from_address)
      }
      setAutoArchived(true)
      toast.success(`Future mail from ${message.from_address} will be archived`)
    } catch (error) {
      console.warn("[mail-display] auto-archive rule failed", error)
      toast.error("Could not create the auto-archive rule")
    }
  }

  return (
    <div
      data-testid="unsubscribe-banner"
      className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      {stage.stage === "idle" && (
        <>
          <span className="min-w-0 flex-1">
            This sender offers an unsubscribe option.
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7"
            data-testid="unsubscribe-button"
            onClick={handleUnsubscribe}
          >
            Unsubscribe
          </Button>
        </>
      )}
      {stage.stage === "confirm" && (
        <>
          <span className="min-w-0 flex-1">
            Send the unsubscribe request to{" "}
            <span className="font-medium break-all text-foreground">
              {stage.url}
            </span>
            ?
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7"
            data-testid="unsubscribe-confirm"
            onClick={() => void handleConfirm()}
          >
            Confirm
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            data-testid="unsubscribe-cancel"
            onClick={() => setStage({ stage: "idle" })}
          >
            Cancel
          </Button>
        </>
      )}
      {stage.stage === "done" && (
        <>
          <span className="min-w-0 flex-1">
            {autoArchived
              ? "Unsubscribed — future mail from this sender will be archived."
              : "Unsubscribed."}
          </span>
          {!autoArchived && message.from_address && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7"
              data-testid="unsubscribe-auto-archive"
              onClick={() => void handleAutoArchive()}
            >
              Auto-archive future mail from this sender
            </Button>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The mailto fallback (the spec's pre-addressed unsubscribe email): the
 * composer opens as a new draft addressed to the list's unsubscribe
 * address — the SAME openNew/setTo bridge composeToContact uses (bridge
 * ordering contract: composer store first, ui-store's composerOpen flag
 * after). Subject: the mailto URI's own ?subject= when present, else the
 * standard "Unsubscribe".
 */
function openUnsubscribeComposer(
  account: EmailAccount,
  target: MailtoTarget
): void {
  const composer = useComposerStore.getState()
  composer.openNew(account.id)
  composer.setTo([{ email: target.address }])
  composer.setSubject(target.subject ?? "Unsubscribe")
  useUiStore.getState().setComposerOpen(true)
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

/**
 * Per-message phishing findings (task 18.1, D12): the analysis result is
 * keyed by message id + the sanitized source html it was computed from,
 * so a displayed message is analyzed exactly once (remounts and the
 * show-images reload read the cache instead).
 */
interface PhishingEntry {
  source: string
  findings: PhishingFinding[]
}

const phishingCache = new Map<string, PhishingEntry>()

/**
 * The synthetic finding a stored DMARC failure rides into the banner
 * (task 2.2, design D10): never produced by analyzePhishing — it comes
 * from the ingested Authentication-Results verdicts — but rendered
 * through the same finding list so the banner copy covers the auth angle.
 */
const DMARC_FAIL_FINDING: PhishingFinding = {
  kind: "dmarc-fail",
  detail:
    "DMARC authentication FAILED — this message may be impersonating the sender it claims to be from.",
}

/**
 * Per-account contacts memo for the phishing analysis: every expanded
 * message of one account used to re-run listContactsByAccount — a full
 * contacts SELECT per message in the thread view. Keyed by the render
 * session's executor → accountId, so a new db session (production
 * re-bootstrap, per-test executors) starts empty with no explicit
 * invalidation. Failures are NOT cached — a transient db error must not
 * pin "no contacts" for the rest of the session.
 */
type ContactRows = Awaited<ReturnType<typeof listContactsByAccount>>

const contactsCacheByExecutor = new WeakMap<
  SqlExecutor,
  Map<string, Promise<ContactRows>>
>()

function loadContactsForAccount(
  executor: SqlExecutor,
  accountId: string
): Promise<ContactRows> {
  let byAccount = contactsCacheByExecutor.get(executor)
  if (!byAccount) {
    byAccount = new Map()
    contactsCacheByExecutor.set(executor, byAccount)
  }
  const cached = byAccount.get(accountId)
  if (cached) return cached
  const loaded = listContactsByAccount(executor, accountId)
  loaded.catch(() => {
    byAccount?.delete(accountId)
  })
  byAccount.set(accountId, loaded)
  return loaded
}

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
  attachmentDeps,
}: {
  message: MessageRow
  account: EmailAccount | null
  attachmentDeps: FileActionDeps | undefined
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
              attachmentDeps={attachmentDeps}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Chip copy/tint per static-policy tier (D17): block formats are
 * outright dangerous, caution formats are macro-capable documents. */
const RISK_CHIP: Record<
  Exclude<AttachmentRisk, "safe">,
  { label: string; variant: "destructive" | "secondary" }
> = {
  block: { label: "Dangerous", variant: "destructive" },
  caution: { label: "Macros", variant: "secondary" },
}

function AttachmentItem({
  attachment,
  message,
  account,
  attachmentDeps,
}: {
  attachment: AttachmentRow
  message: MessageRow
  account: EmailAccount | null
  attachmentDeps: FileActionDeps | undefined
}) {
  // "save" | "open" while the content fetch/file action is in flight.
  const [busy, setBusy] = useState<"save" | "open" | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The malware verdict of the last open attempt (D18) — only ever set
  // after a scan actually ran; unknown/offline outcomes render nothing.
  const [verdict, setVerdict] = useState<ScanOutcome | null>(null)
  // Add-to-calendar preview (task 5.5): opens for .ics / text/calendar
  // rows; the dialog owns parsing + the v1 add/RSVP seam contract.
  const [icsOpen, setIcsOpen] = useState(false)
  const risk = attachmentRisk(attachment.filename)
  const isCalendar = isCalendarAttachment(attachment)

  /** The .ics text loader handed to the preview dialog (D15 seam). */
  const loadIcsText = useCallback(() => {
    if (!account) return Promise.reject(new Error("attachment has no account"))
    return resolveExecutor().then((executor) =>
      readIcsAttachmentText(
        executor,
        account,
        message,
        attachment,
        attachmentDeps ?? {}
      )
    )
  }, [account, message, attachment, attachmentDeps])

  function handleSave(): void {
    if (!account || busy) return
    setBusy("save")
    setError(null)
    resolveExecutor()
      .then((executor) =>
        getAttachmentContent(executor, account, message, attachment)
      )
      .then((bytes) => saveAttachmentAs(attachment, bytes, attachmentDeps))
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
        openAttachment(executor, account, message, attachment, attachmentDeps)
      )
      .then((result) => {
        // null = declined the static first-open warning — not an error.
        if (result === null) return
        setVerdict(result.scan)
      })
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
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {attachment.filename || "(unnamed)"}
          </span>
          {risk !== "safe" && (
            <Badge
              variant={RISK_CHIP[risk].variant}
              className="shrink-0 gap-1"
              data-testid="attachment-risk-chip"
              aria-label={`${RISK_CHIP[risk].label} file type`}
            >
              <ShieldAlert className="size-3" />
              {RISK_CHIP[risk].label}
            </Badge>
          )}
          {verdict?.verdict === "malicious" && (
            <Badge
              variant="destructive"
              className="shrink-0 gap-1"
              data-testid="attachment-verdict-chip"
              aria-label="Flagged malicious by the malware lookup"
            >
              <ShieldAlert className="size-3" />
              Malicious
            </Badge>
          )}
          {verdict?.verdict === "suspicious" && (
            <Badge
              variant="outline"
              className="shrink-0 gap-1"
              data-testid="attachment-verdict-chip"
              aria-label="Flagged suspicious by the malware lookup"
            >
              <ShieldAlert className="size-3" />
              Suspicious
            </Badge>
          )}
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
        {isCalendar && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1"
            data-testid="attachment-add-to-calendar"
            disabled={!account || busy !== null}
            onClick={() => setIcsOpen(true)}
          >
            <CalendarPlus className="size-3.5" />
            Add to calendar
          </Button>
        )}
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
      {isCalendar && (
        <IcsPreviewDialog
          open={icsOpen}
          onOpenChange={setIcsOpen}
          loadIcs={loadIcsText}
        />
      )}
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
