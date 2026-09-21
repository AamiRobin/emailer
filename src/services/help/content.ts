/**
 * The bundled help-center catalog (task 2.9, design D14): static typed
 * text shipped with the app — no storage, no network fetch. The search
 * (src/services/help/search.ts) scores these cards locally; the help
 * center component (src/components/help/help-center.tsx) renders them
 * both inline (Settings → Help) and in the palette-opened dialog.
 *
 * Copy ground rules: every card names the surface the app actually has
 * (Settings → Desktop for tray/global-shortcut/mailto/autostart,
 * Settings → Encryption for PGP, …) and describes shipped behavior —
 * when a feature changes its settings home, this catalog changes with
 * it. Cards stay short: two or three friendly sentences per paragraph.
 */

/** Categories of the help center, in display (and catalog) order. */
export type HelpCategory =
  | "Getting started"
  | "Reading & organizing"
  | "Composing"
  | "AI assistance"
  | "Security & privacy"
  | "Desktop integration"

/** Fixed category order for grouping and for the empty-query grid. */
export const HELP_CATEGORIES: ReadonlyArray<HelpCategory> = [
  "Getting started",
  "Reading & organizing",
  "Composing",
  "AI assistance",
  "Security & privacy",
  "Desktop integration",
]

/** One help card: a titled article in a category with indexed keywords. */
export interface HelpCard {
  /** Stable, unique id (the test suite enforces uniqueness). */
  id: string
  category: HelpCategory
  title: string
  /** Short paragraphs rendered in reading order when the card expands. */
  body: string[]
  /** Extra search terms beyond what title/body naturally contain. */
  keywords: string[]
}

/**
 * The one keyboard-shortcuts card in the catalog. The help-center
 * component checks its expanded content against this id and renders the
 * LIVE binding table (defaults + persisted overrides, grouped by
 * SHORTCUT_GROUPS) instead of — never alongside — a copied list, so the
 * reference can never drift from src/constants/shortcuts.ts.
 */
export const SHORTCUTS_CARD_ID = "keyboard-shortcuts"

/**
 * The whole help center, ordered by category. 37 cards across the six
 * categories, grounded in the shipped feature set (see README.md and the
 * velo-parity-roadmap + parity-round-2 proposals).
 */
export const HELP_CARDS: ReadonlyArray<HelpCard> = [
  // ---------------------------------------------------------------------
  // Getting started
  // ---------------------------------------------------------------------
  {
    id: "connect-account",
    category: "Getting started",
    title: "Connect an email account",
    body: [
      "Open Settings → Accounts and choose Add Account. Emailer detects server settings automatically for Gmail, Outlook, Yahoo, iCloud, Fastmail, GMX, Zoho and AOL — for anything else, just point it at your IMAP and SMTP hosts.",
      "Gmail connects through Google's OAuth sign-in (with your own free API client, so nothing is shared with third parties); IMAP accounts only need your address and password. Add as many accounts as you like and switch between them from the sidebar.",
    ],
    keywords: [
      "account",
      "accounts",
      "gmail",
      "imap",
      "smtp",
      "add",
      "connect",
      "setup",
      "oauth",
      "provider",
      "outlook",
      "microsoft",
      "365",
      "graph",
      "fastmail",
      "yahoo",
      "icloud",
    ],
  },
  {
    id: "microsoft-365",
    category: "Getting started",
    title: "Add a Microsoft 365 account",
    body: [
      "Add Account → Microsoft 365 / Outlook.com connects work, school and personal Microsoft accounts (Outlook, Hotmail, Live) through Microsoft's modern sign-in. Just like Gmail, it uses your own free app registration: create one in Microsoft Entra's app-registration portal, add http://localhost:17248 as the redirect URI, and paste the client ID into Emailer.",
      "Work or school accounts may need an administrator's approval the first time; if your organization requires it, your IT administrator can grant consent once and everyone is set. Outlook calendars connect as their own source, through a second sign-in that asks for the calendar scope only — mail and calendar permissions stay separate.",
    ],
    keywords: [
      "microsoft",
      "office",
      "365",
      "outlook.com",
      "hotmail",
      "live",
      "graph",
      "entra",
      "work",
      "school",
      "admin",
      "consent",
      "approval",
      "registration",
      "client id",
      "redirect",
      "azure",
    ],
  },
  {
    id: "local-first",
    category: "Getting started",
    title: "Where your mail lives",
    body: [
      "Emailer is local-first: messages, contacts and settings live in a database on this machine, and credentials are sealed with your operating system's keychain. There are no Emailer servers holding a copy.",
      "Reading, full-text search and drafting all work offline; syncing resumes by itself whenever you're back online.",
    ],
    keywords: [
      "local",
      "privacy",
      "offline",
      "storage",
      "database",
      "sqlite",
      "keychain",
      "credentials",
      "security",
      "data",
      "sync",
    ],
  },
  {
    id: "carddav-contacts",
    category: "Getting started",
    title: "Sync contacts over CardDAV",
    body: [
      "Settings → Address book connects a CardDAV server — Nextcloud, Radicale, your provider's own — so its contacts appear, and autocomplete, right alongside your local ones. Point Emailer at the server URL and your username, give it an app password, then pick which of the server's address books to sync. The password is sealed on this device and never leaves it.",
      "Connecting pulls the book down straight away; Sync now refreshes it on demand. If the server refuses changes, the book is marked read-only, and cards Emailer couldn't translate are skipped and reported rather than silently dropped.",
    ],
    keywords: [
      "carddav",
      "contacts",
      "address book",
      "addressbook",
      "sync",
      "nextcloud",
      "radicale",
      "vcard",
      "autocomplete",
      "app password",
      "read-only",
      "people",
    ],
  },
  {
    id: "find-around",
    category: "Getting started",
    title: "Find your way around",
    body: [
      "The sidebar holds your accounts, folders, labels and saved views; the center pane lists threads; the reading pane shows the conversation. You can park the reading pane on the right, below the list, or hide it entirely under Settings → Reading.",
      "Press Cmd/Ctrl+K for the command palette: one place to compose, jump to any folder or label, switch accounts and open settings without touching the mouse.",
    ],
    keywords: [
      "navigate",
      "sidebar",
      "layout",
      "panes",
      "palette",
      "command",
      "interface",
      "tour",
      "overview",
      "reading pane",
    ],
  },
  {
    id: "profiles-colors",
    category: "Getting started",
    title: "Profiles and account colors",
    body: [
      "Under Settings → Accounts → Profiles you can group accounts into named profiles, each with its own color — “Work”, “Personal”, whatever fits. Assign or unassign accounts at any time; deleting a profile never touches the accounts themselves, they simply fall back to their own colors.",
      "Profile colors show up as a small colored bar at the start of each thread in cross-account lists, so you can tell at a glance who a thread belongs to. Not a fan? Settings → Appearance has a Profile color markers toggle, and single-account views are never affected either way.",
    ],
    keywords: [
      "profiles",
      "profile",
      "colors",
      "color",
      "markers",
      "groups",
      "grouping",
      "accounts",
      "work",
      "personal",
      "bar",
      "identity",
    ],
  },
  {
    id: SHORTCUTS_CARD_ID,
    category: "Getting started",
    title: "Keyboard shortcuts",
    body: [
      "Emailer is keyboard-first. Press ? anytime for the quick overlay, browse the full table below, or open Settings → Shortcuts — where every mail binding can be changed to suit you.",
      "The table always shows your current bindings, including any overrides you saved. Triage highlights: e archives, s stars, m toggles read, and b snoozes.",
    ],
    keywords: [
      "keyboard",
      "shortcuts",
      "keys",
      "hotkeys",
      "bindings",
      "rebind",
      "overrides",
      "reference",
      "help",
    ],
  },
  {
    id: "appearance",
    category: "Getting started",
    title: "Make Emailer yours",
    body: [
      "Under Settings → Appearance you can switch between light and dark themes, pick an accent color, choose a density preset and scale the font size — everything applies instantly.",
      "Cross-account lists can also lead each thread row with a small color bar in the account's profile or account color; the Profile color markers toggle turns that on or off.",
      "The reading pane position lives under Settings → Reading, so you can shape the window around how you read.",
    ],
    keywords: [
      "theme",
      "themes",
      "dark",
      "light",
      "appearance",
      "accent",
      "color",
      "colors",
      "density",
      "font",
      "size",
      "customize",
      "markers",
      "profile",
    ],
  },
  {
    id: "search-operators",
    category: "Getting started",
    title: "Search like a pro",
    body: [
      "The search field speaks operators: from:, to:, label:, is:starred, is:unread, has:attachment, larger:5m, before:2026-01-01 — and negations like -from:newsletter@ or -has:attachment.",
      "Save a query as a saved search in the sidebar, or pin it as a split tab above the inbox. Splits understand rolling date tokens such as after:__TODAY-7D__, so the tab keeps itself current.",
      "Search forgives accents, too: looking up “be don dep” still finds Bé Dọn Dẹp, because diacritics are folded away on both sides of the match. And when a plain-words query matches nothing, Emailer retries it in relaxed mode — threads matching any single term — and marks the list with a Relaxed search badge; queries with operators are always taken literally.",
    ],
    keywords: [
      "search",
      "operators",
      "query",
      "filter",
      "from",
      "to",
      "label",
      "starred",
      "unread",
      "attachment",
      "saved search",
      "split",
      "date",
      "accents",
      "accent",
      "diacritics",
      "relaxed",
      "fallback",
    ],
  },

  // ---------------------------------------------------------------------
  // Reading & organizing
  // ---------------------------------------------------------------------
  {
    id: "unified-inbox",
    category: "Reading & organizing",
    title: "One inbox, every account",
    body: [
      "The unified inbox combines all your active accounts into a single list; every row carries a small color dot showing which account it came from. Enter it from the sidebar, or keep accounts separate and hop between them with the account picker.",
      "Split tabs — thread lists defined by a search query — and the snoozed list sit alongside as tabs above the thread list.",
    ],
    keywords: [
      "unified",
      "inbox",
      "accounts",
      "combine",
      "merge",
      "split",
      "tabs",
      "multiple",
    ],
  },
  {
    id: "priority-inbox",
    category: "Reading & organizing",
    title: "Priority inbox",
    body: [
      "Priority inbox surfaces the threads from people you actually read and reply to. The classification runs entirely on this machine and sharpens as you use the app.",
      "Find it in the sidebar, right next to the unified inbox — your regular folder views are never touched.",
    ],
    keywords: [
      "priority",
      "important",
      "inbox",
      "vip",
      "focus",
      "classification",
      "sender",
    ],
  },
  {
    id: "snooze",
    category: "Reading & organizing",
    title: "Snooze a thread",
    body: [
      "Snoozing hides a thread from the inbox until it matters — tomorrow morning, next week, or any custom date and time you pick. When it returns, it re-enters at the top of the inbox as if it had just arrived.",
      "Press b on a selected thread or use the ⋯ menu. Snoozed threads stay visible in the sidebar's Snoozed section, where you can always unsnooze one early.",
    ],
    keywords: [
      "snooze",
      "snoozing",
      "later",
      "remind",
      "reminders",
      "defer",
      "tomorrow",
      "hide",
      "unsnooze",
      "shortcut",
    ],
  },
  {
    id: "labels-stars",
    category: "Reading & organizing",
    title: "Labels, folders and stars",
    body: [
      "Gmail accounts use labels and IMAP accounts use folders — both appear in the sidebar and can be nested with / for sub-levels. Drag threads onto a label, or file them from the ⋯ menu. Stars work everywhere as a quick personal flag.",
      "Everything stays in sync with your provider, so a label you apply here is the same one Gmail or your mail server shows.",
    ],
    keywords: [
      "labels",
      "folders",
      "star",
      "starred",
      "organize",
      "drag",
      "drop",
      "tag",
      "nested",
      "hierarchy",
    ],
  },
  {
    id: "nudges-todos",
    category: "Reading & organizing",
    title: "Never drop a thread: nudges and Todos",
    body: [
      "Nudges resurface threads that are still waiting for a reply from you, and follow-up reminders resurface threads where nobody answered what you sent. Both collect in the sidebar, so unanswered mail can't quietly sink.",
      "The Todos list works like a reading queue: add any thread from the reading pane's toolbar, then reorder or check items off as you deal with them.",
    ],
    keywords: [
      "nudge",
      "nudges",
      "follow-up",
      "reminder",
      "reply",
      "tracking",
      "awaiting",
      "todo",
      "todos",
      "unanswered",
      "queue",
    ],
  },
  {
    id: "rules",
    category: "Reading & organizing",
    title: "Automate with rules",
    body: [
      "Rules run locally on every sync: matching messages get labeled, archived, moved or marked automatically. Build them under Settings → Rules, or straight from a message with Create filter.",
      "In a hurry? Describe a rule… takes a plain-language sentence — “archive anything from the newsletter” — and builds the rule for you to preview and confirm. Rules only act on incoming mail, nothing is rewritten on the server behind your back, and you can edit or delete a rule whenever you like.",
    ],
    keywords: [
      "rules",
      "automation",
      "filter",
      "filters",
      "auto",
      "label",
      "archive",
      "move",
      "incoming",
      "create filter",
      "natural language",
      "describe",
      "plain",
    ],
  },
  {
    id: "noise",
    category: "Reading & organizing",
    title: "Keep the noise out",
    body: [
      "Blocked senders (Settings → Blocked senders) skip the inbox entirely. Auto-archive files matching threads away the moment they arrive. Delivery schedules hold newsletters or mailing lists until a window you pick — “Saturdays 8 AM” — so they land when you actually have time to read.",
      "IMAP accounts can also switch on the local junk filter under Settings → Junk filter. It learns from your own spam judgments, never deletes anything automatically, and Gmail accounts skip it since Google already filters there.",
    ],
    keywords: [
      "junk",
      "spam",
      "blocked",
      "sender",
      "senders",
      "auto-archive",
      "archive",
      "newsletter",
      "hold",
      "delivery",
      "schedule",
      "mute",
      "noise",
    ],
  },
  {
    id: "print",
    category: "Reading & organizing",
    title: "Print a message",
    body: [
      "With a thread open, press Cmd/Ctrl+P (or pick Print from the ⋯ menu) for a clean, print-ready layout — headers, bodies and the attachment list, without any app chrome. Your system print dialog can save a PDF just as easily as it prints paper.",
    ],
    keywords: [
      "print",
      "printing",
      "pdf",
      "paper",
      "hardcopy",
      "export",
      "shortcut",
    ],
  },

  // ---------------------------------------------------------------------
  // Reading & organizing — inside a message
  // ---------------------------------------------------------------------
  {
    id: "find-in-message",
    category: "Reading & organizing",
    title: "Find inside a message",
    body: [
      "Press Cmd/Ctrl+F with a thread open and a small find bar floats over the reading pane. As you type it shows where you are — “1 of 3” — and Enter (or the arrow buttons) jumps to the next match, Shift+Enter back to the previous one.",
      "Matches inside collapsed messages are counted, not disturbed: the bar notes “2 in collapsed messages” instead of uncollapsing anything behind your back. Esc closes the bar and clears the highlights.",
    ],
    keywords: [
      "find",
      "finding",
      "find in message",
      "search in message",
      "within",
      "highlight",
      "highlights",
      "matches",
      "match",
      "ctrl+f",
      "next",
      "previous",
      "bar",
    ],
  },
  {
    id: "message-source",
    category: "Reading & organizing",
    title: "View a message's source",
    body: [
      "The View source button in a message's header opens the raw RFC 822 source — every transport header plus the original body, exactly as it arrived. Handy for diagnosing delivery problems, phishing attempts and stubborn formatting.",
      "Source renders read-only in the same sandboxed frame as regular mail: nothing executes, nothing loads remotely, and Copy puts the exact bytes on your clipboard for a bug report.",
    ],
    keywords: [
      "source",
      "raw",
      "rfc 822",
      "headers",
      "view source",
      "diagnostics",
      "debug",
      "phishing",
      "copy",
      "original",
    ],
  },
  {
    id: "reading-preferences",
    category: "Reading & organizing",
    title: "Tune how reading feels",
    body: [
      "Settings → Reading gathers the reading preferences: where the reading pane sits (right, bottom or hidden), whether new mail shows a system notification, and Mark as read on open — on by default, so a message is marked the moment you open it.",
      "Prefer to triage by keyboard and decide read states yourself? Switch Mark as read on open off and nothing changes a message's state until you say so — the manual mark read/unread controls and any rules keep working as usual.",
    ],
    keywords: [
      "reading",
      "mark as read",
      "mark read",
      "read on open",
      "unread",
      "open",
      "pane position",
      "preferences",
      "automatically",
      "triage",
    ],
  },

  // ---------------------------------------------------------------------
  // Composing
  // ---------------------------------------------------------------------
  {
    id: "compose",
    category: "Composing",
    title: "Write a message",
    body: [
      "Press c, use the sidebar's Compose button, or pick it from the command palette. The editor is rich text with attachments, and each account can carry its own signature.",
      "Second-guessing a send? The undo-send banner holds the message for a few seconds before it leaves — and Send later schedules it for exactly the moment you want it to arrive.",
    ],
    keywords: [
      "compose",
      "writing",
      "new",
      "email",
      "message",
      "draft",
      "send",
      "attachments",
      "signature",
      "undo",
      "schedule",
      "later",
      "rich text",
    ],
  },
  {
    id: "snippets",
    category: "Composing",
    title: "Snippets and templates",
    body: [
      "Snippets are reusable text blocks — the intro you retype every morning, your support footer, a carefully worded decline. Manage them under Settings → Snippets and drop them into any message while you write.",
    ],
    keywords: [
      "snippet",
      "snippets",
      "template",
      "templates",
      "canned",
      "boilerplate",
      "insert",
      "reusable",
      "text",
    ],
  },
  {
    id: "drafts-offline",
    category: "Composing",
    title: "Drafts and offline sending",
    body: [
      "Drafts save locally as you type, so a dropped connection never costs you a paragraph. Mail you send while offline waits in a local queue and goes out on its own as soon as you're connected again.",
    ],
    keywords: [
      "draft",
      "drafts",
      "offline",
      "queue",
      "outbox",
      "send",
      "sync",
      "connection",
      "save",
    ],
  },

  // ---------------------------------------------------------------------
  // AI assistance
  // ---------------------------------------------------------------------
  {
    id: "ai-assistance",
    category: "AI assistance",
    title: "AI assistance on your terms",
    body: [
      "Settings → AI turns on optional AI help over your mail, powered by a provider you configure — Anthropic, OpenAI, Gemini, a custom endpoint, or a fully local Ollama whose requests never leave this machine. Every surface (summaries, smart replies, compose transforms, Ask My Inbox, task extraction, …) can be switched on or off individually, and mail never depends on AI.",
      "Each surface runs on a tier — Instant, Cheap or Intelligent — and you choose the model id behind each tier, so quick jobs use the fast model while the hard ones get the strong one. An output-language setting steers everything generative; leave it unset and replies follow the language of the input.",
      "The Usage block counts requests and tokens per surface so nothing is a surprise. Totals are recorded only on this machine, approximate values are labeled as such, and a clear action resets the counter whenever you like.",
    ],
    keywords: [
      "ai",
      "llm",
      "provider",
      "ollama",
      "anthropic",
      "openai",
      "gemini",
      "tiers",
      "tier",
      "instant",
      "cheap",
      "intelligent",
      "model",
      "usage",
      "tokens",
      "language",
      "output language",
      "summaries",
      "summarize",
      "ask my inbox",
    ],
  },
  {
    id: "ai-quick-replies-and-rules",
    category: "AI assistance",
    title: "Quick replies and described rules",
    body: [
      "With a thread open, Emailer can suggest up to three quick replies — small chips that open the composer with a prefilled, fully editable draft. Nothing ever sends by itself: you review, edit, and press Send exactly as with any other message.",
      "Rules learn plain language too. Describe a rule… in Settings → Rules takes a sentence like “archive anything from the newsletter” and turns it into a rule you preview in the normal editor before confirming. Only your description and the rule vocabulary travel to the provider — never any mailbox content — and a description that doesn't map to a rule is reported, with nothing written.",
    ],
    keywords: [
      "quick replies",
      "quick reply",
      "suggestions",
      "chips",
      "replies",
      "smart replies",
      "describe",
      "describe a rule",
      "natural language",
      "plain language",
      "nl rules",
      "automation",
      "privacy",
    ],
  },

  // ---------------------------------------------------------------------
  // Security & privacy
  // ---------------------------------------------------------------------
  {
    id: "pgp",
    category: "Security & privacy",
    title: "Encrypt with PGP",
    body: [
      "Settings → Encryption turns on per-account OpenPGP. Generate a key pair or import existing ones, then encrypt and sign outgoing mail straight from the composer — encrypted mail you receive is decrypted right in the reader.",
      "Passphrases are kept in your operating system's keychain and private keys never leave this machine.",
    ],
    keywords: [
      "pgp",
      "encryption",
      "openpgp",
      "encrypt",
      "decrypt",
      "sign",
      "keys",
      "gpg",
      "security",
      "privacy",
      "passphrase",
    ],
  },
  {
    id: "attachment-security",
    category: "Security & privacy",
    title: "Attachment safety check",
    body: [
      "Optionally, Emailer checks an attachment's hash with a malware-lookup service (VirusTotal) the first time you open it and warns before anything suspicious runs. Only the file's SHA-256 hash is sent — never the attachment itself.",
      "Turn the check on and add your API key under Settings → Attachment security.",
    ],
    keywords: [
      "attachment",
      "attachments",
      "virus",
      "malware",
      "virustotal",
      "scan",
      "hash",
      "security",
      "safety",
      "download",
      "sha-256",
    ],
  },
  {
    id: "remote-images",
    category: "Security & privacy",
    title: "Remote images and tracking pixels",
    body: [
      "Email renders in a sandboxed frame with remote images blocked by default, so tracking pixels stay silent. Load them once with Show images, or allowlist a sender you trust and their images will load from then on.",
    ],
    keywords: [
      "images",
      "remote",
      "tracking",
      "pixel",
      "privacy",
      "allowlist",
      "sender",
      "sandbox",
      "content",
    ],
  },
  {
    id: "data-portability",
    category: "Security & privacy",
    title: "Take your mail with you",
    body: [
      "Settings → Import & export reads standard .eml and .mbox files into your accounts, and writes your mail back out in the same plain, open formats that any other client can read. Your data is never locked in.",
      "It doubles as a backup path: a periodic export is a complete, portable copy of your mail.",
    ],
    keywords: [
      "import",
      "export",
      "backup",
      "eml",
      "mbox",
      "migrate",
      "migration",
      "portability",
      "formats",
      "transfer",
    ],
  },
  {
    id: "storage-reset",
    category: "Security & privacy",
    title: "Storage and starting over",
    body: [
      "Settings → Storage shows what Emailer keeps on this device — mail bodies, attachments, the AI cache, calendar and task data, databases and indexes — with a total and a Refresh button. When a few files couldn't be measured, the sizes say so instead of pretending to be exact.",
      "Delete all local data wipes everything Emailer keeps here and restarts the app as if freshly installed. It's a two-step confirmation that names exactly what is removed, and your mail servers are never touched: every message stays on the server and syncs back down once you add your accounts again.",
    ],
    keywords: [
      "storage",
      "usage",
      "disk",
      "space",
      "size",
      "breakdown",
      "reset",
      "wipe",
      "delete",
      "delete all",
      "start over",
      "fresh",
      "clean",
      "reinstall",
      "factory",
    ],
  },
  {
    id: "updates",
    category: "Security & privacy",
    title: "Staying up to date",
    body: [
      "Emailer checks signed update manifests and lets you know when a new release is ready. Pick the Stable channel for tagged releases or Beta for early builds under Settings → Updates.",
    ],
    keywords: [
      "update",
      "updates",
      "upgrade",
      "beta",
      "stable",
      "release",
      "channel",
      "version",
      "download",
    ],
  },

  // ---------------------------------------------------------------------
  // Desktop integration
  // ---------------------------------------------------------------------
  {
    id: "tray",
    category: "Desktop integration",
    title: "The system tray",
    body: [
      "On close, Emailer can quit outright or hide to the tray and keep working — syncing, notifying, ready to pop back up from the tray icon. Choose the behavior under Settings → Desktop; platforms without a tray simply don't show the option.",
    ],
    keywords: [
      "tray",
      "minimize",
      "close",
      "hide",
      "background",
      "quit",
      "system",
      "icon",
    ],
  },
  {
    id: "global-shortcut",
    category: "Desktop integration",
    title: "Compose from anywhere",
    body: [
      "Register a global compose shortcut under Settings → Desktop, and Emailer surfaces with a fresh composer no matter what app you're in — handy for firing off a message in the middle of something else.",
      "The shortcut is registered with your operating system, so it works even when Emailer is closed or tucked in the tray.",
    ],
    keywords: [
      "global",
      "shortcut",
      "hotkey",
      "compose",
      "anywhere",
      "quick",
      "capture",
      "register",
    ],
  },
  {
    id: "mailto",
    category: "Desktop integration",
    title: "Make Emailer your default mail app",
    body: [
      "Flip on the default-mail-client toggle under Settings → Desktop, and mailto: links in your browser and other apps open a new Emailer draft instead.",
      "Unsetting restores whichever app handled links before — the previous handler is remembered, so nothing is trapped.",
    ],
    keywords: [
      "mailto",
      "default",
      "client",
      "links",
      "browser",
      "handler",
      "protocol",
      "register",
    ],
  },
  {
    id: "autostart",
    category: "Desktop integration",
    title: "Start Emailer at login",
    body: [
      "Launch at login (Settings → Desktop) starts Emailer when you sign in, hidden in the tray when tray support is on — so mail is already synced and notifications are already flowing by the time you look.",
    ],
    keywords: [
      "autostart",
      "launch",
      "login",
      "startup",
      "boot",
      "sign-in",
      "tray",
      "hidden",
    ],
  },
  {
    id: "popout",
    category: "Desktop integration",
    title: "Pop a thread out",
    body: [
      "Open any thread in its own window from the thread list or the reading pane. A popped-out thread is a full citizen — read, reply, archive — and every change lands back in the main window immediately.",
      "Closing a popped-out window with an unsent draft asks before discarding, so nothing is lost by accident.",
    ],
    keywords: [
      "popout",
      "pop",
      "out",
      "window",
      "windows",
      "separate",
      "multiwindow",
      "detach",
    ],
  },
  {
    id: "notifications",
    category: "Desktop integration",
    title: "New-mail notifications",
    body: [
      "Desktop notifications announce new mail as it arrives, with the details under Settings → Notifications. Keep Emailer in the tray and you'll hear about mail even while the window is closed.",
      "Sounds live there too: a new-mail chime (on by default) plays only when a notification actually shows, so senders your notification rules silence stay silent. A sent-message chime (off by default) confirms each send — a message that is merely queued offline stays quiet.",
    ],
    keywords: [
      "notification",
      "notifications",
      "notify",
      "alert",
      "alerts",
      "badge",
      "desktop",
      "new mail",
      "sound",
      "sounds",
      "chime",
      "chimes",
      "audio",
    ],
  },
]
