import { encryptCredentials } from "../services/crypto/credentials"
import { upsertContact } from "../services/db/contacts"
import { allowSender } from "../services/db/image-allowlist"
import type { LabelInput, SpecialUse } from "../services/db/labels"
import { insertLabel } from "../services/db/labels"
import type { SqlExecutor } from "../services/db/executor"
import type { AttachmentInput, ContactRef } from "../services/db/messages"
import { insertMessage } from "../services/db/messages"
import {
  insertThread,
  recomputeThreadCaches,
  setThreadFolder,
  setThreadLabels,
  setThreadStarred,
} from "../services/db/threads"
import { saveDraft } from "../services/composer/drafts"
import { enqueueOperation } from "../services/queue/operation"
import { SETTINGS_KEYS, setSetting } from "../services/db/settings"
import { upsertFolderSyncState } from "../services/sync/folder-sync-state"
import {
  GMAIL_ACCOUNT_ID,
  GMAIL_HISTORY_ID,
  GMAIL_SYSTEM_LABELS,
  GMAIL_USER_LABELS,
  gmailSystemLabelId,
  gmailUserLabelId,
  IMAP_ACCOUNT_ID,
  IMAP_FOLDERS,
  imapFolderByPath,
  imapFolderLabelId,
  ME_GMAIL,
  ME_IMAP,
  PEOPLE,
} from "./fixture-data"

/**
 * Fixture seeder for the mock harness (mock dev mode only). Writes a
 * realistic two-account mailbox through the app's own query modules —
 * insertThread/insertMessage/setThreadLabels — so thread caches,
 * participants JSON, label membership and the FTS5 triggers are built by
 * exactly the code paths production sync uses. Dates are computed
 * relative to seed time; every address, token and credential is fake
 * (credentials_json holds a real AES-GCM envelope of mock values so the
 * sync scheduler can decrypt it without errors).
 */

/** Small visible PNG (96x32, three color blocks) used as the inline
 * data-URI image that actually renders in mock mode. */
const INLINE_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAAAgCAIAAABiouoDAAAAVklEQVR42u3QMQ0AIAwAsP08WEAXajCCj0lAED8qdpA0qYLGHKdUz1Xq7lYqBAkSJEiQIEGCBAkSJEiQIEGCBAkSJEiQIEGCBAkSJEiQIEGCBAn6N+gBttG08QivXRYAAAAASUVORK5CYII="

const NOW = Math.floor(Date.now() / 1000)
const HOUR = 3600
const DAY = 24 * HOUR

function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 140 ? `${flat.slice(0, 137)}...` : flat
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

/** Plain text → simple paragraph html (matches how bodies seed by default). */
function htmlOf(text: string): string {
  return text
    .split("\n\n")
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("\n")
}

// ---------------------------------------------------------------------------
// Seed specs
// ---------------------------------------------------------------------------

interface SeedMessageSpec {
  from: ContactRef
  to?: ContactRef[]
  cc?: ContactRef[]
  /** Seconds before seed time. */
  age: number
  body: string
  /** Overrides the derived paragraph html. */
  html?: string
  /** null bodyHtml (plain-text-only message). */
  htmlNone?: boolean
  attachments?: AttachmentInput[]
  unread?: boolean
}

interface SeedThreadSpec {
  subject: string
  messages: SeedMessageSpec[]
  /** Gmail label keys: "INBOX"/"SENT"/"DRAFT"/"SPAM"/"TRASH" or a user label name. */
  labels?: string[]
  /** IMAP folder path (account 2 threads). */
  folder?: string
  starred?: boolean
}

// ---------------------------------------------------------------------------
// Seeding state (deterministic ids/counters)
// ---------------------------------------------------------------------------

let threadSeq = 0
let messageHeaderSeq = 0
let gmailMessageSeq = 0
let attachmentSeq = 0
const imapUidCounters = new Map<string, number>()

function nextThreadId(): string {
  threadSeq += 1
  return `mock-thread-${threadSeq}`
}

function nextMessageHeader(): string {
  messageHeaderSeq += 1
  return `<mock-msg-${messageHeaderSeq}@mock.local>`
}

function nextGmailMessageId(): string {
  gmailMessageSeq += 1
  return `18f0a${gmailMessageSeq.toString(16).padStart(12, "0")}`
}

function nextAttachmentId(): string {
  attachmentSeq += 1
  return `mock-att-${attachmentSeq}`
}

function nextImapUid(folderPath: string): number {
  const next = (imapUidCounters.get(folderPath) ?? 0) + 1
  imapUidCounters.set(folderPath, next)
  return next
}

function attachment(
  filename: string,
  mimeType: string,
  size: number,
  extra: Partial<AttachmentInput> = {}
): AttachmentInput {
  return {
    id: nextAttachmentId(),
    filename,
    mimeType,
    size,
    providerPartId: `part-${attachmentSeq}`,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Thread/message writers (via the app's own query modules)
// ---------------------------------------------------------------------------

async function seedThread(
  executor: SqlExecutor,
  spec: SeedThreadSpec,
  accountId: string
): Promise<void> {
  const threadId = nextThreadId()
  const newest = spec.messages.reduce(
    (min, message) => Math.min(min, message.age),
    Number.POSITIVE_INFINITY
  )
  const oldest = spec.messages.reduce(
    (max, message) => Math.max(max, message.age),
    0
  )
  const isGmail = accountId === GMAIL_ACCOUNT_ID

  await insertThread(executor, {
    id: threadId,
    accountId,
    subject: spec.subject,
    firstMessageAt: NOW - oldest,
    lastMessageAt: NOW - newest,
    gmailThreadId: isGmail
      ? `gth${(threadSeq * 7919).toString(16)}`
      : undefined,
    folderLabelId:
      !isGmail && spec.folder
        ? imapFolderLabelId(imapFolderByPath(spec.folder) ?? IMAP_FOLDERS[0])
        : undefined,
  })

  let previousHeader: string | undefined
  for (const [index, message] of spec.messages.entries()) {
    const header = nextMessageHeader()
    await insertMessage(executor, {
      id: `${threadId}-m${index + 1}`,
      threadId,
      accountId,
      gmailMessageId: isGmail ? nextGmailMessageId() : undefined,
      imapUid:
        isGmail && spec.folder !== undefined
          ? undefined
          : isGmail
            ? undefined
            : spec.folder
              ? nextImapUid(spec.folder)
              : undefined,
      imapFolder: !isGmail && spec.folder ? spec.folder : undefined,
      messageIdHeader: header,
      inReplyTo: index > 0 ? previousHeader : undefined,
      referencesHeader:
        index > 0 && previousHeader ? previousHeader : undefined,
      subject: spec.subject,
      fromName: message.from.name ?? undefined,
      fromAddress: message.from.email,
      to:
        message.to ?? (accountId === GMAIL_ACCOUNT_ID ? [ME_GMAIL] : [ME_IMAP]),
      cc: message.cc,
      date: NOW - message.age,
      snippet: snippetOf(message.body),
      bodyHtml: message.htmlNone
        ? undefined
        : (message.html ?? htmlOf(message.body)),
      bodyText: message.body,
      sizeEstimate: 1800 + message.body.length * 7,
      isRead: !message.unread,
      isFlagged: spec.starred === true && index === spec.messages.length - 1,
      hasAttachments: (message.attachments?.length ?? 0) > 0,
      attachments: message.attachments,
    })
    previousHeader = header
  }

  if (isGmail) {
    await setThreadLabels(
      executor,
      threadId,
      resolveGmailLabelIds(spec.labels ?? ["INBOX"])
    )
  } else if (spec.folder) {
    // The folder label was stamped at insert; rebuild the archive/trash/
    // spam caches from it exactly like the imap sync does.
    await setThreadFolder(
      executor,
      threadId,
      imapFolderLabelId(imapFolderByPath(spec.folder) ?? IMAP_FOLDERS[0])
    )
  }
  if (spec.starred) {
    await setThreadStarred(executor, threadId)
  }
  await recomputeThreadCaches(executor, threadId)
}

const GMAIL_LABEL_IDS = new Map<string, string>()

function registerGmailLabelIds(): void {
  for (const label of GMAIL_SYSTEM_LABELS) {
    GMAIL_LABEL_IDS.set(
      label.id,
      gmailSystemLabelId(label.specialUse ?? "inbox")
    )
  }
  for (const label of GMAIL_USER_LABELS) {
    GMAIL_LABEL_IDS.set(label.id, gmailUserLabelId(label.id))
  }
}

function resolveGmailLabelIds(labels: string[]): string[] {
  return labels
    .map((label) => GMAIL_LABEL_IDS.get(label))
    .filter((id): id is string => id !== undefined)
}

// ---------------------------------------------------------------------------
// Fixture catalog — account 1 (gmail)
// ---------------------------------------------------------------------------

function gmailInboxThreads(): SeedThreadSpec[] {
  const curated: SeedThreadSpec[] = [
    {
      subject: "Invoice #2847 for March retainer",
      labels: ["INBOX", "Finance"],
      messages: [
        {
          from: { name: "Daniel Okafor", email: "d.okafor@brightlane.io" },
          age: 2 * DAY + 3 * HOUR,
          body: "Hi Amir,\n\nAttached is invoice #2847 for the March retainer — 42 hours at the agreed rate, covering the sync engine work and the two urgent fixes.\n\nPayment terms as usual: net 14. Let me know if you need it split across quarters.\n\nBest,\nDaniel",
          attachments: [
            attachment("invoice-2847.pdf", "application/pdf", 48213),
          ],
        },
        {
          from: { name: "Daniel Okafor", email: "d.okafor@brightlane.io" },
          age: 22 * HOUR,
          body: "Morning Amir — just a gentle nudge on invoice #2847 from last week. If the transfer already went out, feel free to ignore this.",
          unread: true,
        },
      ],
    },
    {
      subject: "Q2 quarterly report — draft for review",
      labels: ["INBOX", "Work"],
      starred: true,
      messages: [
        {
          from: {
            name: "Maya Lindholm",
            email: "maya.lindholm@northwind-analytics.com",
          },
          age: 3 * DAY,
          body: "Team,\n\nFirst full draft of the Q2 report is attached. Headline numbers: revenue up 12% QoQ, churn flat at 2.1%, and the platform migration landed two weeks early.\n\nPlease comment directly in the doc by Thursday — I want to lock figures Friday morning.\n\nMaya",
          attachments: [
            attachment("q2-report-v3.pdf", "application/pdf", 1_248_400),
          ],
        },
        {
          from: { name: "Priya Raghavan", email: "priya@fernwoodlabs.com" },
          age: 2 * DAY + 10 * HOUR,
          body: 'Great draft. One gap: the migration section says "two weeks early" but the appendix table still shows the original timeline. Worth reconciling before this goes to the board.',
        },
        {
          from: {
            name: "Maya Lindholm",
            email: "maya.lindholm@northwind-analytics.com",
          },
          age: 30 * HOUR,
          body: "Fixed — appendix now matches. I also added the cost-per-tenant chart Priya asked for in the last review. Final comments by Thursday please.",
        },
      ],
    },
    {
      subject: "Flight BA286 confirmation — OSL → LHR, 24 Sep",
      labels: ["INBOX", "Travel"],
      messages: [
        {
          from: { name: "Clara Nilsen", email: "clara@oslofjordtravel.no" },
          age: 7 * HOUR,
          unread: true,
          body: "Your booking is confirmed. British Airways BA286, Oslo Gardermoen (OSL) → London Heathrow (LHR), departs 24 Sep at 10:35, arrives 12:15 local. Seat 14A, one checked bag included.\n\nCheck-in opens 24 hours before departure. The calendar invite and full itinerary are attached.",
          html: `<div>
<h2>Booking confirmed — BA286</h2>
<p>Your flight is booked. Present the reference <b>FGK4Q2</b> at check-in.</p>
<img src="https://images.example.com/banners/oslofjord-air-header.png" alt="Airline banner" width="600" height="90">
<ul>
  <li><b>Route:</b> Oslo Gardermoen (OSL) → London Heathrow (LHR)</li>
  <li><b>Departs:</b> 24 Sep, 10:35 CEST</li>
  <li><b>Arrives:</b> 24 Sep, 12:15 BST</li>
  <li><b>Seat:</b> 14A — one checked bag included</li>
</ul>
<blockquote>Check-in opens 24 hours before departure at ba.com.</blockquote>
<p>Safe travels!<br>Clara, Oslofjord Travel</p>
</div>`,
          attachments: [
            attachment("ba286-itinerary.ics", "text/calendar", 1284),
          ],
        },
      ],
    },
    {
      subject: "[emailer] PR #212 opened: fix FTS5 snippet edge case",
      labels: ["INBOX"],
      messages: [
        {
          from: { name: "GitHub", email: "notifications@github.com" },
          age: 45 * 60,
          unread: true,
          body: "noah-kim opened a pull request in robinlabs/emailer:\n\nfix(renderer): handle snippet truncation on multibyte boundaries\n\nThe trigram tokenizer can cut a snippet in the middle of a multibyte character when the query term sits at the 137-char boundary. This switches the truncation to grapheme-aware slicing.\n\n+214 −12 across 4 files · 2 checks pending",
        },
      ],
    },
    {
      subject: "[emailer] CI failed on main (run #1882)",
      labels: ["INBOX"],
      messages: [
        {
          from: { name: "GitHub", email: "notifications@github.com" },
          age: 26 * HOUR,
          body: "Run #1882 of CI on main failed.\n\nJob: frontend-tests — 1014 passed, 1 failed\nFailing test: thread-list › collapses 12+ message threads behind a counter\n\nLast 200 lines of log are attached to the run page.",
        },
      ],
    },
    {
      subject: "React Radar #142 — Server Components, one year in",
      labels: ["INBOX", "Newsletters"],
      messages: [
        {
          from: { name: "React Radar", email: "hello@reactradar.dev" },
          age: 5 * HOUR,
          unread: true,
          body: "Server Components, one year in. What actually shipped, what stayed experimental, and three patterns worth stealing for local-first apps. Plus: the state of WebSQLite runtimes and why your ORM cares.",
          html: `<div>
<h2>React Radar #142</h2>
<p><b>Server Components, one year in.</b> Twelve months after stable, the ecosystem has settled into three camps: framework-coupled, runtime-agnostic, and holdouts. We read all the postmortems so you don't have to.</p>
<h3>Three patterns worth stealing</h3>
<ul>
  <li><b>Fetch in the leaf, render in the root</b> — colocating data requirements with the components that own them.</li>
  <li><b>Serializable props discipline</b> — treating every client boundary like a wire format catches abstraction leaks early.</li>
  <li><b>Local-first as a cache tier</b> — SQLite in the browser behind a react hook keeps server round-trips rare.</li>
</ul>
<h3>From the community</h3>
<blockquote>"We replaced our REST layer with a synced local database and cut p95 interaction latency by 80%. The interesting part was the invalidation story, not the sync." — from this week's featured write-up</blockquote>
<p>Also inside: WebSQLite runtimes compared, and a deep dive on trigram search indexes for mail-style datasets.</p>
<hr>
<p>You are receiving this because you subscribed at reactradar.dev. <a href="https://example.com/unsubscribe">Unsubscribe</a></p>
</div>`,
        },
      ],
    },
    {
      subject: "Build server migration window — Saturday 02:00 CEST",
      labels: ["INBOX"],
      messages: [
        {
          from: { name: "Ingrid Weiss", email: "ingrid.weiss@stahl-nord.de" },
          age: 2 * DAY + 5 * HOUR,
          htmlNone: true,
          body: "Amir,\n\nShort version: we are moving the shared build servers to the new rack this Saturday. Downtime window is 02:00-06:00 CEST. If you have cron jobs touching stahl-nord infrastructure, pause them Friday evening.\n\nLong version: the old switches are end-of-life and the new top-of-rack units give us 10G to the host. Migration plan and rollback plan are on the internal wiki, page 'Rack migration W38'.\n\nRegards,\nIngrid Weiss\nStahl Nord GmbH, IT Operations\nPhone: +49 40 555 0182",
        },
      ],
    },
    {
      subject: "Fernwood brand refresh — logo pack v2",
      labels: ["INBOX", "Work"],
      messages: [
        {
          from: { name: "Priya Raghavan", email: "priya@fernwoodlabs.com" },
          age: 30 * HOUR,
          body: "Hi Amir,\n\nLogo pack v2 is ready. The primary mark is embedded below; the full set (mono, dark-mode, favicon) is in the attached guidelines PDF.\n\nWe moved the wordmark 4px left to optically center it — see page 3 if you are curious about the reasoning.",
          html: `<div>
<p>Hi Amir,</p>
<p>Logo pack v2 is ready. The primary mark, inline:</p>
<img src="cid:fernwood-logo@mock.local" alt="Fernwood Labs logo" width="96" height="32">
<p>And the flat accent strip that ships with the dark-mode variant:</p>
<img src="${INLINE_PNG_DATA_URI}" alt="Accent strip" width="96" height="32">
<p>The full set (mono, dark-mode, favicon) is in the attached guidelines PDF.</p>
</div>`,
          attachments: [
            attachment("fernwood-logo.png", "image/png", 512, {
              contentId: "fernwood-logo@mock.local",
              isInline: true,
            }),
            attachment("brand-guidelines-v2.pdf", "application/pdf", 3_402_112),
          ],
        },
      ],
    },
    {
      subject: "Re: Emailer v2 launch checklist",
      labels: ["INBOX", "Work"],
      starred: true,
      messages: [
        {
          from: {
            name: "Maya Lindholm",
            email: "maya.lindholm@northwind-analytics.com",
          },
          age: 8 * DAY,
          body: "Starting the v2 launch checklist. Tentative scope: local-first storage, background sync, attachments, and the composer rewrite. I will keep the top post updated — reply with additions.",
        },
        {
          from: { name: "Daniel Okafor", email: "d.okafor@brightlane.io" },
          age: 8 * DAY - 2 * HOUR,
          body: "Adding: invoice-ready activity export. Accounting asked for it twice last quarter.",
        },
        {
          from: { name: "Amir Robin", email: "amir@robinlabs.dev" },
          age: 7 * DAY - 5 * HOUR,
          body: "Checklist updated. Storage and sync are on track; attachments need the virus-scan decision first. Composer rewrite starts after the FTS index lands.",
        },
        {
          from: { name: "Priya Raghavan", email: "priya@fernwoodlabs.com" },
          age: 7 * DAY - 6 * HOUR,
          body: "Virus scan: clamd in a sidecar was 40ms median on our corpus. Good enough. I can own that workstream.",
        },
        {
          from: {
            name: "Maya Lindholm",
            email: "maya.lindholm@northwind-analytics.com",
          },
          age: 6 * DAY - 4 * HOUR,
          body: "Priya owns virus-scan then. Next open question: do we ship search before or after attachments? Search has one hard dependency left (snippet quality).",
        },
        {
          from: { name: "Amir Robin", email: "amir@robinlabs.dev" },
          age: 6 * DAY - 2 * HOUR,
          body: "Search after attachments. Snippet quality lands with the trigram index next week; I would rather not ship it half-done.",
        },
        {
          from: { name: "Daniel Okafor", email: "d.okafor@brightlane.io" },
          age: 5 * DAY - 7 * HOUR,
          body: "Works for me. Client demo on the 30th — can we have attachments AND search by then, even behind a flag?",
        },
        {
          from: { name: "Amir Robin", email: "amir@robinlabs.dev" },
          age: 5 * DAY - 2 * HOUR,
          body: "Behind a flag, yes. Demo build would be: local DB, sync on, attachments on, search behind #launch-demo-search.",
        },
        {
          from: { name: "Priya Raghavan", email: "priya@fernwoodlabs.com" },
          age: 4 * DAY - 6 * HOUR,
          body: "Virus scan sidecar passes staging: 38ms median, 0 false positives on the corpus. PR up this week. One open item: memory ceiling on the mini PC is 512MB, clamd needs a cap.",
        },
        {
          from: {
            name: "Maya Lindholm",
            email: "maya.lindholm@northwind-analytics.com",
          },
          age: 3 * DAY - 3 * HOUR,
          body: "Cap it at 256MB and document it. Rehearsal for the demo: Thursday next week, 15:00. Bring the checklist.",
        },
        {
          from: { name: "Daniel Okafor", email: "d.okafor@brightlane.io" },
          age: 2 * DAY - 8 * HOUR,
          body: "Thursday 15:00 works. I will demo from the invoice flow — activity export included if it lands in time.",
          unread: true,
        },
        {
          from: { name: "Amir Robin", email: "amir@robinlabs.dev" },
          age: 20 * HOUR,
          body: "Checklist current as of now: 11 of 14 items done, 2 in review, 1 blocked (demo laptop HDMI adapter — ordered). See everyone Thursday.",
        },
      ],
    },
    {
      subject: "Lunch on Thursday?",
      labels: ["INBOX", "Personal"],
      messages: [
        {
          from: { name: "Amelia Clarke", email: "amelia@papercrane.studio" },
          age: DAY + 4 * HOUR,
          body: "Long time! Are you around Thursday? There is a new ramen place two streets from your office and I have opinions about it.",
        },
        {
          from: { name: "Amir Robin", email: "amir@robinlabs.dev" },
          age: DAY + 3 * HOUR,
          body: "Around from 12. Only if we can also talk about the papercrane site copy — I have notes.",
        },
        {
          from: { name: "Amelia Clarke", email: "amelia@papercrane.studio" },
          age: DAY + 1 * HOUR,
          body: "Deal. 12:30 at the ramen place, notes welcome. Booking under my name.",
        },
      ],
    },
    {
      subject: "Dev Weekly #381 — SQLite in the browser",
      labels: ["INBOX", "Newsletters"],
      messages: [
        {
          from: { name: "Dev Weekly", email: "digest@devweekly.dev" },
          age: 27 * HOUR,
          body: "This week: SQLite compiled to WASM goes mainstream, a love letter to Makefiles, and why your side project needs boring infrastructure. Plus 14 links worth your Sunday coffee.",
        },
      ],
    },
    {
      subject: "Standup digest — week 38",
      labels: ["INBOX", "Work"],
      messages: [
        {
          from: { name: "Noah Kim", email: "noah.kim@pinecrest.dev" },
          age: 3 * HOUR,
          unread: true,
          body: "Week 38 digest:\n\n- Sync engine: delta pass moved behind a feature flag, no regressions\n- Composer: autosave edge case fixed (draft key reset after send)\n- Infra: build server migration Saturday, see Ingrid's note\n- Blockers: none\n\nFull notes in the usual doc.",
        },
      ],
    },
    {
      subject: "Contract renewal timeline",
      labels: ["INBOX"],
      messages: [
        {
          from: {
            name: "Rafael Duarte",
            email: "rafael.duarte@meridianlegal.pt",
          },
          age: 4 * DAY + 2 * HOUR,
          body: "Hi Amir,\n\nThe current services agreement expires on 31 October. To renew without a gap we should start paperwork by mid-October. Two open points from our side: the liability cap and whether the audit clause survives unchanged.\n\nCan we book 30 minutes next week?\n\nRafael",
        },
        {
          from: {
            name: "Rafael Duarte",
            email: "rafael.duarte@meridianlegal.pt",
          },
          age: 3 * DAY + 20 * HOUR,
          body: "Following up — does Tuesday or Wednesday suit you for the renewal call? I have held both 10:00-10:30 Lisbon time.",
        },
      ],
    },
    {
      subject: "Payment confirmation — #VP-90412",
      labels: ["INBOX", "Finance"],
      messages: [
        {
          from: { name: "Jonas Vermeulen", email: "jonas@veldpay.com" },
          age: 5 * DAY,
          body: "Payment #VP-90412 of €1,850.00 to Brightlane Consulting was settled today. Reference: INV-2847. The confirmation PDF is available in your Veldpay dashboard for 90 days.",
        },
      ],
    },
    {
      subject: "Pairing session notes + next steps",
      labels: ["INBOX"],
      messages: [
        {
          from: { name: "Tomás Herrera", email: "tomas@casacoding.com" },
          age: 9 * HOUR,
          body: "Thanks for the pairing session! Notes: the queue replay bug was a missing status guard between 'processing' and 'done'. I will send a PR with the fix plus a regression test tomorrow.",
        },
        {
          from: { name: "Tomás Herrera", email: "tomas@casacoding.com" },
          age: 7 * HOUR,
          body: "PR is up: 24 lines changed, includes the regression test we discussed. CI green. Whenever you have 15 minutes for review.",
          unread: true,
        },
      ],
    },
    {
      subject: "Guest post schedule for October",
      labels: ["INBOX", "Work"],
      messages: [
        {
          from: { name: "Sofia Petrov", email: "sofia@lumen-press.co" },
          age: 3 * DAY + 4 * HOUR,
          body: "October slots are filling: we can offer the 8th or the 22nd for your local-first email piece. Draft due one week before publication, ~1,200 words, we edit lightly.\n\nThe September piece (build log format) performed well — 4.1k reads, best this quarter.",
        },
      ],
    },
  ]

  const generated: SeedThreadSpec[] = [
    {
      subject: "Re: Design review — settings screen",
      messages: [
        {
          from: {
            name: "Maya Lindholm",
            email: "maya.lindholm@northwind-analytics.com",
          },
          age: 9 * HOUR,
          unread: true,
          body: "Recording and notes from yesterday's review are up. Main ask: move the accent color picker into its own section — people kept missing it.",
        },
      ],
    },
    {
      subject: "Design review decision log",
      messages: [
        {
          from: {
            name: "Maya Lindholm",
            email: "maya.lindholm@northwind-analytics.com",
          },
          age: 11 * HOUR,
          body: "Decision log from today's review is in the doc. Consensus: keep the density presets, ship the accent picker as-is, and revisit the font-size scale after usability sessions.",
        },
      ],
    },
    {
      subject: "Your Fastmail storage is at 62%",
      messages: [
        {
          from: { name: "Fastmail", email: "service@fastmail.com" },
          age: 2 * DAY + 8 * HOUR,
          body: "Your mailbox has used 6.2 GB of the 10 GB included in your plan. Files stored in Fastmail Drive count separately. Manage attachments under Settings → Storage.",
        },
      ],
    },
    {
      subject: "[emailer] Issue #198 closed: composer attachments",
      messages: [
        {
          from: { name: "GitHub", email: "notifications@github.com" },
          age: 2 * DAY + 12 * HOUR,
          body: "Issue #198 (composer attachments: deduplicate identical files) was closed by amirobin with commit 4f9c1e2.",
        },
      ],
    },
    {
      subject: "[emailer] Release v2.3.1 tagged",
      messages: [
        {
          from: { name: "GitHub", email: "notifications@github.com" },
          age: 4 * DAY,
          body: "v2.3.1 was tagged and released. Changes: 6 bug fixes, 2 dependency bumps. Upgrade notes on the releases page.",
        },
      ],
    },
    {
      subject: "Notes from the Northwind kickoff",
      messages: [
        {
          from: {
            name: "Maya Lindholm",
            email: "maya.lindholm@northwind-analytics.com",
          },
          age: 5 * DAY + 6 * HOUR,
          body: "Notes from the kickoff are in the shared drive. Your action item: a one-page technical risk summary by Friday week. Everyone else's are in section 3.",
        },
      ],
    },
    {
      subject: "Re: Portfolio feedback — round 2",
      starred: true,
      messages: [
        {
          from: { name: "Amelia Clarke", email: "amelia@papercrane.studio" },
          age: 5 * DAY + 9 * HOUR,
          body: "Round 2 of the portfolio is live. The case studies have real numbers now and I killed the parallax effect you called 'aggressively decorative'.",
        },
      ],
    },
    {
      subject: "Tax summary for the retainer agreement",
      messages: [
        {
          from: {
            name: "Rafael Duarte",
            email: "rafael.duarte@meridianlegal.pt",
          },
          age: 6 * DAY,
          body: "Attaching the fiscalisation summary for the retainer as requested. Portugal-side withholding stayed at the treaty rate; the year-end declaration should mirror last year's structure.",
        },
      ],
    },
    {
      subject: "Re: Guest post draft — local-first sync",
      messages: [
        {
          from: { name: "Sofia Petrov", email: "sofia@lumen-press.co" },
          age: 6 * DAY + 3 * HOUR,
          body: "Editorial pass on your draft is done. Structural comments only — the section on conflict resolution is the strongest part, consider promoting it.",
        },
      ],
    },
    {
      subject: "Weekly metrics snapshot",
      messages: [
        {
          from: { name: "Marcus Bell", email: "marcus@quartzmail.com" },
          age: 6 * DAY + 7 * HOUR,
          unread: true,
          body: "Snapshot: 812 active mailboxes, median sync latency 1.4s, p95 3.9s. Error budget at 71% remaining. Details in the dashboard, export attached.",
        },
      ],
    },
    {
      subject: "Re: Pairing session — queue replay bug",
      messages: [
        {
          from: { name: "Tomás Herrera", email: "tomas@casacoding.com" },
          age: 7 * DAY,
          body: "Can we do another pairing session this week? I want to walk you through the queue replay fix before I open the PR.",
        },
      ],
    },
    {
      subject: "Conference ticket confirmation — NDC Oslo",
      starred: true,
      messages: [
        {
          from: { name: "Clara Nilsen", email: "clara@oslofjordtravel.no" },
          age: 7 * DAY + 2 * HOUR,
          body: "Your NDC Oslo ticket is confirmed: order #NDC-88213, workshop day included. Name badge will be printed at registration — bring photo ID.",
        },
      ],
    },
    {
      subject: "Hotel booking — Signalistgatan 9, Solna",
      messages: [
        {
          from: { name: "Clara Nilsen", email: "clara@oslofjordtravel.no" },
          age: 7 * DAY + 4 * HOUR,
          body: "Hotel for the conference week is booked: three nights, breakfast included, free cancellation until 48h before arrival. Confirmation number in the attachment.",
        },
      ],
    },
    {
      subject: "Re: Reading group — DDIA chapter 7",
      messages: [
        {
          from: { name: "Noah Kim", email: "noah.kim@pinecrest.dev" },
          age: 8 * DAY,
          body: "Chapter 7 discussion is moved to Wednesday. We cover transactions and isolation levels; bring one real-world example of a anomaly you have hit.",
        },
      ],
    },
    {
      subject: "Pricing page A/B results",
      messages: [
        {
          from: { name: "Priya Raghavan", email: "priya@fernwoodlabs.com" },
          age: 8 * DAY + 2 * HOUR,
          body: "Two-week A/B test concluded: variant B (annual toggle first) won on conversion +6.8%, but support tickets about billing went up. Recommendation in the doc.",
        },
      ],
    },
    {
      subject: "Dev Weekly #380 — the boring web",
      messages: [
        {
          from: { name: "Dev Weekly", email: "digest@devweekly.dev" },
          age: 8 * DAY + 5 * HOUR,
          body: "Issue 380: in praise of the boring web, a practical guide to font loading, and the hidden complexity of 'just add a calendar widget'.",
        },
      ],
    },
    {
      subject: "Re: Q2 quarterly report — slides",
      messages: [
        {
          from: {
            name: "Maya Lindholm",
            email: "maya.lindholm@northwind-analytics.com",
          },
          age: 9 * DAY,
          body: "Board slides are cut down to 18 pages. Anything above 20 gets skipped live, so we are safe. Comments by Friday please.",
        },
      ],
    },
    {
      subject: "Coffee chat follow-up",
      messages: [
        {
          from: { name: "Marcus Bell", email: "marcus@quartzmail.com" },
          age: 9 * DAY + 1 * HOUR,
          unread: true,
          body: "Good catching up today. As promised: the intro to the sync-farm people, plus the article about quota-aware IMAP clients we discussed.",
        },
      ],
    },
    {
      subject: "Mentorship session — October slots",
      messages: [
        {
          from: { name: "Noah Kim", email: "noah.kim@pinecrest.dev" },
          age: 9 * DAY + 4 * HOUR,
          body: "October mentorship slots are open: three Thursday afternoons. Same format — you bring a hard problem, we whiteboard it.",
        },
      ],
    },
    {
      subject: "Fernwood labs — contract signed",
      messages: [
        {
          from: { name: "Priya Raghavan", email: "priya@fernwoodlabs.com" },
          age: 9 * DAY + 6 * HOUR,
          unread: true,
          body: "Signed! The brand refresh contract is countersigned and in your inbox via the e-sign service. Kickoff call proposal coming tomorrow.",
        },
      ],
    },
    {
      subject: "Stahl Nord: API rate limits increase",
      messages: [
        {
          from: { name: "Ingrid Weiss", email: "ingrid.weiss@stahl-nord.de" },
          age: 9 * DAY + 8 * HOUR,
          body: "Per your request, the API rate limit for your tenant is raised from 600 to 2400 requests/hour, effective immediately. The burst ceiling stays at 50/min.",
        },
      ],
    },
    {
      subject: "Re: Standup digest — week 37",
      messages: [
        {
          from: { name: "Noah Kim", email: "noah.kim@pinecrest.dev" },
          age: 10 * DAY,
          body: "Week 37 digest: search index migration rehearsal passed on staging copies, composer toolbar shipped behind a flag, one incident (notification dupes) RCA'd and fixed.",
        },
      ],
    },
    {
      subject: "Board deck — final read",
      messages: [
        {
          from: {
            name: "Maya Lindholm",
            email: "maya.lindholm@northwind-analytics.com",
          },
          age: 10 * DAY + 2 * HOUR,
          body: "Final read of the board deck before Thursday: slide 9 now carries the migration chart, the appendix table matches, and the churn axis starts at zero. No further changes from my side.",
        },
      ],
    },
    {
      subject: "Board deck comments",
      messages: [
        {
          from: {
            name: "Maya Lindholm",
            email: "maya.lindholm@northwind-analytics.com",
          },
          age: 10 * DAY + 5 * HOUR,
          body: "Left 14 comments on the deck, mostly on slides 4-6. The one to fix before anyone else sees it: the churn chart y-axis starts at 1.5% which makes it look flat.",
        },
      ],
    },
    {
      subject: "Security review questionnaire",
      starred: true,
      messages: [
        {
          from: {
            name: "Rafael Duarte",
            email: "rafael.duarte@meridianlegal.pt",
          },
          age: 10 * DAY + 7 * HOUR,
          body: "The client's security team sent their standard questionnaire: 41 questions across encryption, data residency and incident response. Most answers exist in our docs; the data-residency section needs your input.",
        },
      ],
    },
    {
      subject: "Re: Flight BA286 — seat upgrade offer",
      messages: [
        {
          from: { name: "Clara Nilsen", email: "clara@oslofjordtravel.no" },
          age: 10 * DAY + 9 * HOUR,
          body: "The airline opened premium economy upgrades on your flight for GBP 89. Upgrade closes at check-in; say the word and I will add it to the booking.",
        },
      ],
    },
    {
      subject: "Veldpay: new invoice features",
      messages: [
        {
          from: { name: "Jonas Vermeulen", email: "jonas@veldpay.com" },
          age: 11 * DAY,
          body: "Shipped this month: recurring invoices, SEPA instant payouts, and automatic late-payment reminders (toggle in Settings → Reminders).",
        },
      ],
    },
    {
      subject: "Casa Coding sprint review invite",
      messages: [
        {
          from: { name: "Tomás Herrera", email: "tomas@casacoding.com" },
          age: 11 * DAY + 2 * HOUR,
          body: "Sprint review Friday 14:00 — we demo the new offline queue. Remote link in the calendar invite. Bring hard questions.",
        },
      ],
    },
    {
      subject: "Lumen Press: style guide update",
      messages: [
        {
          from: { name: "Sofia Petrov", email: "sofia@lumen-press.co" },
          age: 11 * DAY + 4 * HOUR,
          unread: true,
          body: "Style guide updated: em-dashes are out (house style), headings in sentence case, and code blocks must declare their language. Applies from October 1.",
        },
      ],
    },
    {
      subject: "Re: Build server migration window",
      messages: [
        {
          from: { name: "Ingrid Weiss", email: "ingrid.weiss@stahl-nord.de" },
          age: 11 * DAY + 6 * HOUR,
          body: "Reminder: pause anything touching the build cluster Friday 18:00. The migration window is confirmed for Saturday 02:00 CEST.",
        },
      ],
    },
    {
      subject: "[emailer] Discussion #44 — mock mode for UI work",
      messages: [
        {
          from: { name: "GitHub", email: "notifications@github.com" },
          age: 11 * DAY + 8 * HOUR,
          body: "New discussion: 'Can we get a browser mock mode so UI tweaks do not need the full Tauri stack?' — 3 upvotes, 2 comments so far.",
        },
      ],
    },
    {
      subject: "Quartzmail weekly digest",
      messages: [
        {
          from: { name: "Marcus Bell", email: "marcus@quartzmail.com" },
          age: 12 * DAY,
          body: "Your week on Quartzmail: 214 messages received, 96 sent, 12 new contacts auto-learned. Median response time: 3h 40m. You are quicker than 78% of users.",
        },
      ],
    },
    {
      subject: "Papercrane studio — illustration quote",
      messages: [
        {
          from: { name: "Amelia Clarke", email: "amelia@papercrane.studio" },
          age: 12 * DAY + 3 * HOUR,
          body: "Quote for the six spot illustrations: 1,900 EUR fixed, two revision rounds included, delivery in three weeks from go-ahead. Valid until end of month.",
        },
      ],
    },
    {
      subject: "Re: Notes from the Northwind kickoff",
      messages: [
        {
          from: {
            name: "Maya Lindholm",
            email: "maya.lindholm@northwind-analytics.com",
          },
          age: 12 * DAY + 6 * HOUR,
          unread: true,
          body: "Bumping the risk summary deadline to Wednesday — the steering group moved a week earlier. Same format as last time works.",
        },
      ],
    },
    {
      subject: "Your weekly product metrics are ready",
      messages: [
        {
          from: { name: "Marcus Bell", email: "marcus@quartzmail.com" },
          age: 12 * DAY + 9 * HOUR,
          body: "Weekly product metrics: activation 44% (+2), week-4 retention 61% (flat), top drop-off step remains first-sync. Unsubscribe any time in settings.",
        },
      ],
    },
    {
      subject: "October newsletter: community highlights",
      messages: [
        {
          from: { name: "React Radar", email: "hello@reactradar.dev" },
          age: 13 * DAY,
          body: "Community highlights: three local-first app postmortems, a WebAssembly runtime benchmark suite, and the SQLite WASM adoption survey results.",
        },
      ],
    },
    {
      subject: "Re: Security review questionnaire",
      messages: [
        {
          from: {
            name: "Rafael Duarte",
            email: "rafael.duarte@meridianlegal.pt",
          },
          age: 13 * DAY + 2 * HOUR,
          body: "Draft answers for sections 1-3 are in the shared doc. Section 4 (data residency) is marked for you — client legal wants precise wording on where message bodies rest.",
        },
      ],
    },
    {
      subject: "Re: Design review — settings screen",
      messages: [
        {
          from: {
            name: "Maya Lindholm",
            email: "maya.lindholm@northwind-analytics.com",
          },
          age: 13 * DAY + 5 * HOUR,
          body: "Second round of settings mocks attached. Kept the sectioned accent picker, dropped the toggle grid nobody understood. Final call in Thursday's review.",
          attachments: [
            attachment("settings-mocks-r2.pdf", "application/pdf", 811_233),
          ],
        },
      ],
    },
  ]

  return [...curated, ...generated]
}

function gmailSentThreads(): SeedThreadSpec[] {
  const daniel = { name: "Daniel Okafor", email: "d.okafor@brightlane.io" }
  const maya = {
    name: "Maya Lindholm",
    email: "maya.lindholm@northwind-analytics.com",
  }
  const priya = { name: "Priya Raghavan", email: "priya@fernwoodlabs.com" }
  const noah = { name: "Noah Kim", email: "noah.kim@pinecrest.dev" }
  const rafael = {
    name: "Rafael Duarte",
    email: "rafael.duarte@meridianlegal.pt",
  }
  const amelia = { name: "Amelia Clarke", email: "amelia@papercrane.studio" }
  const tomas = { name: "Tomás Herrera", email: "tomas@casacoding.com" }
  const sofia = { name: "Sofia Petrov", email: "sofia@lumen-press.co" }
  const clara = { name: "Clara Nilsen", email: "clara@oslofjordtravel.no" }
  const jonas = { name: "Jonas Vermeulen", email: "jonas@veldpay.com" }
  const ingrid = { name: "Ingrid Weiss", email: "ingrid.weiss@stahl-nord.de" }

  return [
    {
      subject: "Re: Invoice #2847 for March retainer",
      labels: ["SENT"],
      messages: [
        {
          from: ME_GMAIL,
          to: [daniel],
          age: DAY + 6 * HOUR,
          body: "Hi Daniel,\n\nInvoice #2847 is approved and went into today's payment run — it should land within two business days. I flagged the Q2 split question to Rafael so the tax treatment is right.\n\nThanks for the clean breakdown of hours.\n\nAmir",
        },
      ],
    },
    {
      subject: "Re: Q2 quarterly report — draft for review",
      labels: ["SENT"],
      messages: [
        {
          from: ME_GMAIL,
          to: [maya],
          cc: [priya],
          age: 29 * HOUR,
          body: "Reviewed the draft — numbers section is solid. One comment in the margin on the churn chart baseline; everything else is good to lock on Friday.",
        },
      ],
    },
    {
      subject: "Re: Emailer v2 launch checklist",
      labels: ["SENT"],
      messages: [
        {
          from: ME_GMAIL,
          to: [maya, priya],
          age: 19 * HOUR,
          body: "Checklist updated: virus-scan PR merged, demo flag wired. Only the HDMI adapter blocks now (order tracking says Thursday). Rehearsal agenda follows Wednesday.",
        },
      ],
    },
    {
      subject: "Welcome aboard — onboarding details",
      labels: ["SENT"],
      messages: [
        {
          from: ME_GMAIL,
          to: [noah],
          age: 2 * DAY + 2 * HOUR,
          body: "Welcome to the mentorship track, Noah! Details: Thursdays 15:00, 45 minutes, one hard problem each session. Bring the sync-engine question first — it is a good one.",
        },
      ],
    },
    {
      subject: "Re: Contract renewal timeline",
      labels: ["SENT"],
      messages: [
        {
          from: ME_GMAIL,
          to: [rafael],
          age: 3 * DAY + 12 * HOUR,
          body: "Wednesday 10:00 Lisbon works. I will send the data-residency wording before the call so we can close section 4 in one pass.",
        },
      ],
    },
    {
      subject: "Re: Portfolio feedback — round 2",
      labels: ["SENT"],
      messages: [
        {
          from: ME_GMAIL,
          to: [amelia],
          age: 4 * DAY + 8 * HOUR,
          body: "Round 2 is a big step up — the numbers make the case studies believable. Two small notes sent separately. The parallax will be missed by no one.",
        },
      ],
    },
    {
      subject: "Notes: pairing session next steps",
      labels: ["SENT"],
      messages: [
        {
          from: ME_GMAIL,
          to: [tomas],
          age: 5 * DAY + 4 * HOUR,
          body: "Great session. Recap: status guard fix (you), regression test skeleton (me, tonight), PR review Thursday. The queue replay docs page is yours if you want it.",
        },
      ],
    },
    {
      subject: "Re: Guest post schedule for October",
      labels: ["SENT"],
      messages: [
        {
          from: ME_GMAIL,
          to: [sofia],
          age: 2 * DAY + 20 * HOUR,
          body: "The 8th works. I will have the draft to you by the 1st, and I am glad the build-log format landed — that one was fun to write.",
        },
      ],
    },
    {
      subject: "Re: Flight BA286 confirmation",
      labels: ["SENT"],
      messages: [
        {
          from: ME_GMAIL,
          to: [clara],
          age: 5 * HOUR,
          body: "Confirmed, thanks Clara! Please add the premium economy upgrade to BA286 — GBP 89 is fine. Receipt to the usual address please.",
        },
      ],
    },
    {
      subject: "Re: Payment confirmation — #VP-90412",
      labels: ["SENT"],
      messages: [
        {
          from: ME_GMAIL,
          to: [jonas],
          age: 4 * DAY + 18 * HOUR,
          body: "Received and reconciled against INV-2847 — all good. The recurring-invoice feature arrived at exactly the right time, incidentally.",
        },
      ],
    },
    {
      subject: "Re: Standup digest — week 38",
      labels: ["SENT"],
      messages: [
        {
          from: ME_GMAIL,
          to: [noah],
          age: 2 * HOUR,
          body: "Nice digest. One correction for the doc: the autosave fix shipped in tonight's build, not last week's. Flag stays on until Monday.",
        },
      ],
    },
    {
      subject: "Re: Build server migration window",
      labels: ["SENT"],
      messages: [
        {
          from: ME_GMAIL,
          to: [ingrid],
          age: 6 * DAY + 12 * HOUR,
          body: "Confirmed — our cron jobs touching stahl-nord will pause Friday 18:00 and resume after your go. Good luck Saturday!",
        },
      ],
    },
  ]
}

function gmailArchiveThreads(): SeedThreadSpec[] {
  const rafael = {
    name: "Rafael Duarte",
    email: "rafael.duarte@meridianlegal.pt",
  }
  const maya = {
    name: "Maya Lindholm",
    email: "maya.lindholm@northwind-analytics.com",
  }
  const amelia = { name: "Amelia Clarke", email: "amelia@papercrane.studio" }
  const ingrid = { name: "Ingrid Weiss", email: "ingrid.weiss@stahl-nord.de" }
  const sofia = { name: "Sofia Petrov", email: "sofia@lumen-press.co" }
  const priya = { name: "Priya Raghavan", email: "priya@fernwoodlabs.com" }
  const noah = { name: "Noah Kim", email: "noah.kim@pinecrest.dev" }
  const tomas = { name: "Tomás Herrera", email: "tomas@casacoding.com" }

  return [
    {
      subject: "2025 tax documents — final versions",
      labels: ["ARCHIVE"],
      messages: [
        {
          from: rafael,
          age: 21 * DAY,
          body: "Final versions of all 2025 tax documents are in the archive folder. Nothing outstanding on your side.",
        },
      ],
    },
    {
      subject: "Office move logistics — week 29",
      labels: ["ARCHIVE"],
      messages: [
        {
          from: maya,
          age: 24 * DAY,
          body: "Move plan for week 29: crates arrive Tuesday, network cutover Wednesday 07:00, first-aid station moves with the kitchen. Label everything twice.",
        },
      ],
    },
    {
      subject: "Re: Old portfolio site handover",
      labels: ["ARCHIVE"],
      messages: [
        {
          from: amelia,
          age: 28 * DAY,
          body: "Handover complete — DNS, hosting and the archive export are all in your name now. Goodbye, old friend.",
        },
      ],
    },
    {
      subject: "Server rack inventory — Q2 audit",
      labels: ["ARCHIVE"],
      messages: [
        {
          from: ingrid,
          age: 31 * DAY,
          body: "Q2 rack audit is done: 3 disks flagged for replacement, all spares accounted for, cable chaos in rack B documented with photos.",
        },
      ],
    },
    {
      subject: "Re: Conference CFP feedback",
      labels: ["ARCHIVE"],
      messages: [
        {
          from: sofia,
          age: 35 * DAY,
          body: "CFP feedback: reviewers liked the demo-first structure; the abstract needs one concrete number to anchor it. Resubmission window opens next month.",
        },
      ],
    },
    {
      subject: "Q1 retrospective notes",
      labels: ["ARCHIVE"],
      messages: [
        {
          from: priya,
          age: 38 * DAY,
          body: "Retrospective notes archived: three wins (sync engine, FTS index, test count), two systemic issues (review latency, flaky IMAP fixture), owners assigned.",
        },
      ],
    },
    {
      subject: "Library book recommendations",
      labels: ["ARCHIVE"],
      messages: [
        {
          from: noah,
          age: 42 * DAY,
          body: "As requested: 'Designing Data-Intensive Applications' (again), 'The Mythical Man-Month' (still true), and a surprise: 'The Art of Doing Science and Engineering'.",
        },
      ],
    },
    {
      subject: "Re: Legacy backup audit",
      labels: ["ARCHIVE"],
      messages: [
        {
          from: tomas,
          age: 45 * DAY,
          body: "Legacy backup audit closed: 2 of 14 legacy jobs still restore-verified, both migrated. The rest decommissioned with sign-off.",
        },
      ],
    },
  ]
}

function gmailTrashThreads(): SeedThreadSpec[] {
  const maya = {
    name: "Maya Lindholm",
    email: "maya.lindholm@northwind-analytics.com",
  }
  const devweekly = { name: "Dev Weekly", email: "digest@devweekly.dev" }
  const clara = { name: "Clara Nilsen", email: "clara@oslofjordtravel.no" }
  const github = { name: "GitHub", email: "notifications@github.com" }

  return [
    {
      subject: "Re: Draft — old pricing FAQ",
      labels: ["TRASH"],
      messages: [
        {
          from: maya,
          age: 6 * DAY + 12 * HOUR,
          body: "This FAQ draft predates the pricing change — superseded by the new one. Deleting to avoid confusion.",
        },
      ],
    },
    {
      subject: "Unsubscribe confirmation — Dev Weekly jobs digest",
      labels: ["TRASH"],
      messages: [
        {
          from: devweekly,
          age: 9 * DAY + 4 * HOUR,
          body: "You have been unsubscribed from the jobs digest. This is the last message you will receive on that topic.",
        },
      ],
    },
    {
      subject: "Re: Weekend cabin availability",
      labels: ["TRASH"],
      messages: [
        {
          from: clara,
          age: 14 * DAY,
          body: "The cabin is booked out that weekend after all — sorry! Want me to watch for October instead?",
        },
      ],
    },
    {
      subject: "[emailer] Stale PR #140 auto-close notice",
      labels: ["TRASH"],
      messages: [
        {
          from: github,
          age: 18 * DAY,
          body: "PR #140 has had no activity for 60 days and will be closed in 7 days. Comment to keep it open.",
        },
      ],
    },
  ]
}

function gmailSpamThreads(): SeedThreadSpec[] {
  return [
    {
      subject: "URGENT: Your account will be suspended",
      labels: ["SPAM"],
      messages: [
        {
          from: {
            name: "Security Team",
            email: "security-alert@account-verify.example",
          },
          age: 3 * DAY + 16 * HOUR,
          body: "Dear customer, we detected unusual activity. Verify your credentials within 24 hours at the link below or your mailbox will be permanently suspended.",
        },
      ],
    },
    {
      subject: "You have unclaimed funds waiting",
      labels: ["SPAM"],
      messages: [
        {
          from: {
            name: "Prizes Department",
            email: "claims@lottery-alert.example",
          },
          age: 8 * DAY + 2 * HOUR,
          body: "Congratulations! A transfer of 2,450,000.00 EUR has been earmarked in your name. Reply with your banking details to release the funds.",
        },
      ],
    },
  ]
}

function gmailDraftThreads(): SeedThreadSpec[] {
  const noah = { name: "Noah Kim", email: "noah.kim@pinecrest.dev" }
  const priya = { name: "Priya Raghavan", email: "priya@fernwoodlabs.com" }

  return [
    {
      subject: "Re: Reading group — chapter notes",
      labels: ["DRAFT"],
      messages: [
        {
          from: ME_GMAIL,
          to: [noah],
          age: 4 * HOUR,
          body: "Notes on chapter 7, written up properly this time: the isolation-level examples finally clicked when I mapped them onto our queue replay scenarios. Sending before Wednesday.",
        },
      ],
    },
    {
      subject: "Thoughts on the pricing experiment",
      labels: ["DRAFT"],
      messages: [
        {
          from: ME_GMAIL,
          to: [priya],
          age: 26 * HOUR,
          body: "Following the A/B results — I think the support-ticket increase is the real signal here. Draft of a simpler middle path below...",
        },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Fixture catalog — account 2 (imap/fastmail)
// ---------------------------------------------------------------------------

function imapInboxThreads(): SeedThreadSpec[] {
  const fastmail = { name: "Fastmail", email: "service@fastmail.com" }
  const marcus = { name: "Marcus Bell", email: "marcus@quartzmail.com" }
  const elin = { name: "Elin Sørensen", email: "elin@sorensen-foto.dk" }
  const oskar = { name: "Oskar Lindqvist", email: "oskar.l@nordiskdev.se" }
  const noah = { name: "Noah Kim", email: "noah.kim@pinecrest.dev" }
  const devweekly = { name: "Dev Weekly", email: "digest@devweekly.dev" }
  const tomas = { name: "Tomás Herrera", email: "tomas@casacoding.com" }

  return [
    {
      subject: "Security tip: enable app-specific passwords",
      folder: "INBOX",
      messages: [
        {
          from: fastmail,
          age: 5 * HOUR,
          unread: true,
          body: "Monthly security tip: app-specific passwords let each device connect without sharing your main password. Create one per app under Settings → Privacy & Security.",
        },
      ],
    },
    {
      subject: "Re: Side project — sync protocol",
      folder: "INBOX",
      messages: [
        {
          from: marcus,
          age: 9 * HOUR,
          unread: true,
          body: "Sketched the delta protocol we discussed: per-folder cursors, tombstones for expunges, modseq for flag-only changes. Sound familiar? Your emailer notes were the blueprint, honestly.",
        },
      ],
    },
    {
      subject: "Family reunion — photo sharing",
      folder: "INBOX",
      messages: [
        {
          from: elin,
          age: DAY + 3 * HOUR,
          unread: true,
          body: "Hej Amir! I collected the reunion photos — 214 of them. Best ten are attached; full album link follows once I have everyone's consent notes.",
        },
      ],
    },
    {
      subject: "Re: Freelance contract — NDA draft",
      folder: "INBOX",
      messages: [
        {
          from: oskar,
          age: DAY + 8 * HOUR,
          body: "NDA draft attached. Mutual, 3-year term, standard carve-outs. If the liability wording looks familiar it is because it borrows from your emailer agreement.",
        },
      ],
    },
    {
      subject: "Photo book proof ready for review",
      folder: "INBOX",
      messages: [
        {
          from: elin,
          age: 2 * DAY + 6 * HOUR,
          body: "The reunion photo book proof is ready — 48 pages, matte paper. Review by Friday and I send it to print.",
        },
      ],
    },
    {
      subject: "Scheduled maintenance — mail server M2",
      folder: "INBOX",
      messages: [
        {
          from: fastmail,
          age: 3 * DAY,
          body: "Mail server M2 will be updated Sunday 02:00-04:00 your local time. No action needed; brief IMAP disconnects possible during the window.",
        },
      ],
    },
    {
      subject: "Server maintenance completed",
      folder: "INBOX",
      messages: [
        {
          from: fastmail,
          age: 11 * HOUR,
          unread: true,
          body: "The scheduled maintenance on your mail server completed successfully 26 minutes ahead of schedule. All services are operating normally.",
        },
      ],
    },
    {
      subject: "Receipt: Fastmail standard plan renewal",
      folder: "INBOX",
      messages: [
        {
          from: fastmail,
          age: 10 * DAY + 2 * HOUR,
          body: "Your annual plan renewed today: USD 59.40 charged to the card ending 4417. Invoice PDF attached for your records.",
        },
      ],
    },
    {
      subject: "Re: Open source contribution guidelines",
      folder: "INBOX",
      messages: [
        {
          from: noah,
          age: 4 * DAY + 5 * HOUR,
          body: "Contribution guidelines draft is up. Main change from the old README section: require a regression test per bug fix, matching what you do in emailer.",
        },
      ],
    },
    {
      subject: "Nordic dev roundup — September",
      folder: "INBOX",
      messages: [
        {
          from: devweekly,
          age: 5 * DAY + 7 * HOUR,
          body: "This month in Nordic dev: Malmö meetup recordings, a Copenhagen systems-talk series, and Oslo's local-first gathering returns in October.",
        },
      ],
    },
    {
      subject: "Re: Coffee in Malmö?",
      folder: "INBOX",
      messages: [
        {
          from: tomas,
          age: 6 * DAY + 9 * HOUR,
          body: "In Malmö the 29th! The usual place at 10:00? I will bring printouts of the queue-replay diagrams you never opened.",
        },
      ],
    },
    {
      subject: "Domain renewal reminder — robinlabs.dev",
      folder: "INBOX",
      messages: [
        {
          from: fastmail,
          age: 8 * DAY,
          body: "robinlabs.dev renews on 12 October. Card ending 4417 will be charged USD 14.00. Manage auto-renewal in Settings → Domains.",
        },
      ],
    },
  ]
}

function imapOtherThreads(): SeedThreadSpec[] {
  const fastmail = { name: "Fastmail", email: "service@fastmail.com" }
  const marcus = { name: "Marcus Bell", email: "marcus@quartzmail.com" }
  const elin = { name: "Elin Sørensen", email: "elin@sorensen-foto.dk" }
  const oskar = { name: "Oskar Lindqvist", email: "oskar.l@nordiskdev.se" }
  const devweekly = { name: "Dev Weekly", email: "digest@devweekly.dev" }

  return [
    {
      subject: "Re: Side project — sync protocol",
      folder: "Sent Messages",
      messages: [
        {
          from: ME_IMAP,
          to: [marcus],
          age: 7 * HOUR,
          body: "Love it — that is almost exactly what the emailer engine does. One hard-won lesson: keep flag reconciliation separate from body sync, they fail in different ways.",
        },
      ],
    },
    {
      subject: "Re: Photo book proof ready for review",
      folder: "Sent Messages",
      messages: [
        {
          from: ME_IMAP,
          to: [elin],
          age: 2 * DAY + 2 * HOUR,
          body: "Proof looks wonderful — the matte paper was the right call. One caption on page 12 has the wrong year, everything else is perfect.",
        },
      ],
    },
    {
      subject: "Re: Freelance contract — NDA draft",
      folder: "Sent Messages",
      messages: [
        {
          from: ME_IMAP,
          to: [oskar],
          age: DAY + 4 * HOUR,
          body: "NDA looks clean. Two small marks in the margin, otherwise sign away. Flattered the liability wording made the round trip.",
        },
      ],
    },
    {
      subject: "Old hosting receipts 2024",
      folder: "Archive",
      messages: [
        {
          from: fastmail,
          age: 40 * DAY,
          body: "Your 2024 hosting receipts are collated in this thread for the accounting year. No action needed.",
        },
      ],
    },
    {
      subject: "Re: Old mailing list digest",
      folder: "Trash",
      messages: [
        {
          from: devweekly,
          age: 16 * DAY,
          body: "An edition of the systems list digest from March, kept only because a thread reference pointed here. Safe to delete.",
        },
      ],
    },
    {
      subject: "Extend your warranty — final notice",
      folder: "Spam",
      messages: [
        {
          from: {
            name: "Warranty Desk",
            email: "warranty@service-plan.example",
          },
          age: 4 * DAY + 2 * HOUR,
          body: "Your device warranty is expiring. Extend now at a special rate. This is the final notice we will send.",
        },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Local drafts (composer snapshots — the Drafts folder lists these)
// ---------------------------------------------------------------------------

async function seedLocalDrafts(executor: SqlExecutor): Promise<void> {
  const invoiceThreadHeader = "<mock-msg-1@mock.local>"

  await saveDraft(executor, {
    accountId: GMAIL_ACCOUNT_ID,
    draft: {
      to: [{ name: "Daniel Okafor", email: "d.okafor@brightlane.io" }],
      cc: [],
      bcc: [],
      subject: "Re: Invoice #2847 for March retainer",
      bodyHtml:
        "<p>Thanks Daniel — the payment went out this morning. Transfer reference VP-90412, and Jonas's confirmation should already be in your inbox.</p><p></p>",
      inReplyTo: invoiceThreadHeader,
      threadId: findThreadForInvoice(),
    },
  })
  await saveDraft(executor, {
    accountId: GMAIL_ACCOUNT_ID,
    draft: {
      to: [{ name: "Amelia Clarke", email: "amelia@papercrane.studio" }],
      cc: [],
      bcc: [],
      subject: "Illustration quote — go-ahead",
      bodyHtml:
        "<p>Amelia,</p><p>Go for the six spot illustrations at the quoted rate. One request: can the set share a color palette with the</p>",
    },
  })
  await saveDraft(executor, {
    accountId: GMAIL_ACCOUNT_ID,
    draft: {
      to: [{ name: "Sofia Petrov", email: "sofia@lumen-press.co" }],
      cc: [],
      bcc: [],
      subject: "Re: Guest post schedule for October",
      bodyHtml:
        "<p>The 22nd would actually be better than the 8th — I can tie the piece to the launch retrospective that week.</p>",
    },
  })
  await saveDraft(executor, {
    accountId: GMAIL_ACCOUNT_ID,
    draft: {
      to: [{ name: "Rafael Duarte", email: "rafael.duarte@meridianlegal.pt" }],
      cc: [],
      bcc: [],
      subject: "Data residency wording — section 4",
      bodyHtml:
        "<p>Rafael — proposed wording for section 4: message bodies and metadata rest exclusively in an application-managed SQLite database on the user's device; no provider-side storage, no third-party processing.</p>",
    },
  })
  await saveDraft(executor, {
    accountId: GMAIL_ACCOUNT_ID,
    draft: {
      to: [],
      cc: [],
      bcc: [],
      subject: "Reading list — Q4",
      bodyHtml:
        "<p>- Finish DDIA ch. 9<br>- Skim the CONDSTORE RFC again (7162)<br>- The Mythical Man-Month, 50th anniversary edition notes</p>",
    },
  })

  // saveDraft cannot know thread ids; patch the reply draft's thread link.
  const draftRows = await executor.select<{ id: string; subject: string }>(
    "SELECT id, subject FROM local_drafts WHERE account_id = $1",
    [GMAIL_ACCOUNT_ID]
  )
  const replyDraft = draftRows.find((row) =>
    row.subject.startsWith("Re: Invoice")
  )
  if (replyDraft !== undefined) {
    const threadRow = await executor.select<{ id: string }>(
      "SELECT id FROM threads WHERE subject LIKE 'Invoice #2847%' AND account_id = $1 LIMIT 1",
      [GMAIL_ACCOUNT_ID]
    )
    const thread = threadRow[0]
    if (thread !== undefined) {
      await executor.execute(
        "UPDATE local_drafts SET thread_id = $1, in_reply_to = $2 WHERE id = $3",
        [thread.id, invoiceThreadHeader, replyDraft.id]
      )
    }
  }
}

function findThreadForInvoice(): string | undefined {
  // Resolved after seeding inside seedLocalDrafts (needs a SELECT); the
  // initial value keeps the DraftInput shape honest.
  return undefined
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Seed the mock database. Assumes the schema is applied and the accounts
 * table is empty (plugin-sql.ts checks); runs inside one transaction.
 */
export async function seedIfEmpty(executor: SqlExecutor): Promise<void> {
  registerGmailLabelIds()
  await executor.execute("BEGIN")
  try {
    await seedAccounts(executor)
    await seedGmailLabels(executor)
    await seedImapFolderLabels(executor)
    await seedContacts(executor)

    for (const spec of gmailInboxThreads()) {
      await seedThread(executor, spec, GMAIL_ACCOUNT_ID)
    }
    for (const spec of gmailSentThreads()) {
      await seedThread(executor, spec, GMAIL_ACCOUNT_ID)
    }
    for (const spec of gmailArchiveThreads()) {
      await seedThread(executor, spec, GMAIL_ACCOUNT_ID)
    }
    for (const spec of gmailTrashThreads()) {
      await seedThread(executor, spec, GMAIL_ACCOUNT_ID)
    }
    for (const spec of gmailSpamThreads()) {
      await seedThread(executor, spec, GMAIL_ACCOUNT_ID)
    }
    for (const spec of gmailDraftThreads()) {
      await seedThread(executor, spec, GMAIL_ACCOUNT_ID)
    }
    for (const spec of imapInboxThreads()) {
      await seedThread(executor, spec, IMAP_ACCOUNT_ID)
    }
    for (const spec of imapOtherThreads()) {
      await seedThread(executor, spec, IMAP_ACCOUNT_ID)
    }

    await seedFolderSyncState(executor)
    await seedSettings(executor)
    await seedImageAllowlist(executor)
    await seedLocalDrafts(executor)
    await seedPendingOperation(executor)
    await executor.execute("COMMIT")
    logSeedSummary(executor)
  } catch (error) {
    await executor.execute("ROLLBACK").catch(() => {})
    throw error
  }
}

async function seedAccounts(executor: SqlExecutor): Promise<void> {
  // Real AES-GCM envelopes of mock values: the scheduler decrypts these
  // on every sync pass, and decryption of garbage would flip the account
  // to auth-error. Plaintext never touches the database.
  const gmailEnvelope = await encryptCredentials({
    refreshToken: "mock-gmail-refresh-token",
    accessToken: "mock-gmail-access-token",
    accessTokenExpiresAt: (NOW + 12 * HOUR) * 1000,
  })
  const imapEnvelope = await encryptCredentials({
    password: "mock-imap-app-password",
  })

  await executor.execute(
    `INSERT INTO accounts (
      id, type, email, display_name,
      imap_host, imap_port, imap_security,
      smtp_host, smtp_port, smtp_security,
      credentials_json, oauth_scope, oauth_client_id,
      gmail_history_id, labels_synced_at,
      status, last_sync_at, last_full_sync_at,
      is_active, is_pinned, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
    [
      GMAIL_ACCOUNT_ID,
      "gmail",
      ME_GMAIL.email,
      ME_GMAIL.name ?? null,
      null,
      null,
      null,
      null,
      null,
      null,
      gmailEnvelope,
      "https://mail.google.com/",
      "682100000000-mock.apps.googleusercontent.com",
      String(GMAIL_HISTORY_ID),
      NOW - 30 * 60,
      "active",
      NOW - 4 * 60,
      NOW - 26 * HOUR,
      1,
      1,
      NOW - 220 * DAY,
    ]
  )
  await executor.execute(
    `INSERT INTO accounts (
      id, type, email, display_name,
      imap_host, imap_port, imap_security,
      smtp_host, smtp_port, smtp_security,
      credentials_json, status, last_sync_at, last_full_sync_at,
      is_active, is_pinned, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      IMAP_ACCOUNT_ID,
      "imap",
      ME_IMAP.email,
      ME_IMAP.name ?? null,
      "imap.fastmail.com",
      993,
      "tls",
      "smtp.fastmail.com",
      465,
      "tls",
      imapEnvelope,
      "active",
      NOW - 2 * HOUR - 10 * 60,
      NOW - 26 * HOUR,
      1,
      0,
      NOW - 180 * DAY,
    ]
  )
}

async function seedGmailLabels(executor: SqlExecutor): Promise<void> {
  for (const label of GMAIL_SYSTEM_LABELS) {
    const input: LabelInput = {
      id: gmailSystemLabelId(label.specialUse ?? "inbox"),
      accountId: GMAIL_ACCOUNT_ID,
      name: label.id,
      gmailLabelId: label.id,
      specialUse: label.specialUse ?? undefined,
      type: "system",
    }
    await insertLabel(executor, input)
  }
  for (const label of GMAIL_USER_LABELS) {
    const input: LabelInput = {
      id: gmailUserLabelId(label.id),
      accountId: GMAIL_ACCOUNT_ID,
      name: label.id,
      gmailLabelId: label.id,
      color: label.color,
      type: "user",
    }
    await insertLabel(executor, input)
  }
}

async function seedImapFolderLabels(executor: SqlExecutor): Promise<void> {
  for (const folder of IMAP_FOLDERS) {
    const roleToSpecialUse: Record<string, SpecialUse> = {
      inbox: "inbox",
      sent: "sent",
      drafts: "drafts",
      junk: "spam",
      trash: "trash",
      archive: "archive",
      all: "all",
      flagged: "flagged",
    }
    const isSystem = folder.role !== "all" && folder.role !== "flagged"
    await insertLabel(executor, {
      id: imapFolderLabelId(folder),
      accountId: IMAP_ACCOUNT_ID,
      name: folder.path,
      imapFolderName: folder.path,
      specialUse: isSystem ? roleToSpecialUse[folder.role] : undefined,
      type: "system",
    })
  }
}

async function seedContacts(executor: SqlExecutor): Promise<void> {
  for (const person of PEOPLE) {
    await upsertContact(executor, GMAIL_ACCOUNT_ID, person)
    if (person.shared) {
      await upsertContact(executor, IMAP_ACCOUNT_ID, person)
    }
  }
  // Give the address book realistic ranking weights.
  for (const person of PEOPLE) {
    const lastAt = NOW - Math.floor(person.interactions * 3.7) * DAY
    await executor.execute(
      `UPDATE contacts SET interaction_count = $1, last_interaction_at = $2
       WHERE account_id = $3 AND email = $4`,
      [person.interactions, lastAt, GMAIL_ACCOUNT_ID, person.email]
    )
    if (person.shared) {
      await executor.execute(
        `UPDATE contacts SET interaction_count = $1, last_interaction_at = $2
         WHERE account_id = $3 AND email = $4`,
        [
          Math.max(1, Math.floor(person.interactions / 2)),
          lastAt + DAY,
          IMAP_ACCOUNT_ID,
          person.email,
        ]
      )
    }
  }
}

async function seedFolderSyncState(executor: SqlExecutor): Promise<void> {
  for (const folder of IMAP_FOLDERS) {
    await upsertFolderSyncState(executor, {
      accountId: IMAP_ACCOUNT_ID,
      folderName: folder.path,
      uidvalidity: folder.uidValidity,
      lastSeenUid: folder.lastSeenUid,
      highestModseq: folder.highestModseq,
      lastSyncAt: NOW - 2 * HOUR - 10 * 60,
    })
  }
}

async function seedSettings(executor: SqlExecutor): Promise<void> {
  await setSetting(executor, SETTINGS_KEYS.notificationsEnabled, true)
  await setSetting(executor, `signature:${GMAIL_ACCOUNT_ID}`, {
    html: "<p>Best,</p><p><b>Amir Robin</b> · RobinLabs<br>amir@robinlabs.dev</p>",
  })
  await setSetting(executor, `signature:${IMAP_ACCOUNT_ID}`, {
    html: "<p>Best,</p><p><b>Amir Robin</b><br>amir@fastmail.com</p>",
  })
}

async function seedImageAllowlist(executor: SqlExecutor): Promise<void> {
  await allowSender(executor, GMAIL_ACCOUNT_ID, "notifications@github.com")
  await allowSender(executor, GMAIL_ACCOUNT_ID, "digest@devweekly.dev")
}

async function seedPendingOperation(executor: SqlExecutor): Promise<void> {
  await enqueueOperation(executor, {
    accountId: IMAP_ACCOUNT_ID,
    kind: "mark_read",
    refs: [{ folder: "INBOX", uid: 12 }],
  })
}

/** One-line console summary of the seeded mailbox (folder counts). */
function logSeedSummary(executor: SqlExecutor): void {
  void (async () => {
    try {
      const rows = await executor.select<{ c: number; folder: string }>(
        `SELECT
          CASE
            WHEN t.is_trashed = 1 THEN 'trash'
            WHEN t.is_spam = 1 THEN 'spam'
            WHEN t.is_archived = 1 THEN 'archive'
            ELSE 'inbox'
          END AS folder,
          COUNT(*) AS c
        FROM threads t WHERE t.account_id = $1 GROUP BY folder`,
        [GMAIL_ACCOUNT_ID]
      )
      const counts = Object.fromEntries(rows.map((row) => [row.folder, row.c]))
      console.info(
        `[mock seed] gmail threads: ${JSON.stringify(counts)}; ` +
          `imap threads: ${(await executor.select<{ c: number }>("SELECT COUNT(*) AS c FROM threads WHERE account_id = $1", [IMAP_ACCOUNT_ID]))[0]?.c}`
      )
    } catch {
      // Summary logging is best-effort.
    }
  })()
}
