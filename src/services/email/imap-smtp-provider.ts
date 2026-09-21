import type {
  ConnectionTestResult,
  DeltaSyncResult,
  EmailAccount,
  EmailAddress,
  EmailFolder,
  EmailProvider,
  FetchMessagesResult,
  FetchQuery,
  MessageFlags,
  MessageRef,
  NormalizedAttachment,
  NormalizedMessage,
  ProviderCredentials,
  SendEmailInput,
} from "./types"
import { ProviderAuthError } from "./types"
import type { OutgoingEmail, ImapParams, SmtpParams } from "./invoke"
import {
  imapAppend,
  imapDeleteMessage,
  imapFetchFlags,
  imapFetchMessages,
  imapFetchSource,
  imapListFolders,
  imapMoveMessage,
  imapStoreFlags,
  imapTestConnection,
  smtpSendEmail,
  smtpSendRawEmail,
  smtpTestConnection,
} from "./invoke"
import { toEmailFolders } from "./folder-mapper"
import { buildMimeMessage, hasInlineImages } from "./mime-builder"

/**
 * EmailProvider implementation for IMAP/SMTP accounts (design D2/D4):
 * every operation is a stateless Rust command call — connect, work,
 * logout — so there is no session to keep alive. System folder roles are
 * resolved server-side (RFC 6154 + name fallback) and mapped to the label
 * model by folder-mapper.ts.
 */

/**
 * Conservative auth-failure matcher for Rust error strings. Matches only
 * clear credential rejections so network/timeout errors never mark an
 * account auth-error. Lower-cased substring match covers the Rust-wrapped
 * messages ("IMAP login failed for user …", "SMTP authentication failed
 * for user …") and raw server text ("[AUTHENTICATIONFAILED] Invalid
 * credentials").
 */
const AUTH_ERROR_PATTERNS = [
  "authentication",
  "auth failed",
  "login failed",
  "invalid credentials",
  "unauthorized",
]

export function isAuthErrorMessage(message: string): boolean {
  const lowered = message.toLowerCase()
  return AUTH_ERROR_PATTERNS.some((pattern) => lowered.includes(pattern))
}

/** Convert any thrown value into a ProviderAuthError when it matches. */
function mapProviderError(accountId: string, error: unknown): unknown {
  if (error instanceof ProviderAuthError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (isAuthErrorMessage(message)) {
    return new ProviderAuthError(accountId, "imap", message)
  }
  return error
}

/** "1,5,9" — deduped, insertion order. */
function uidSetFromUids(uids: number[]): string {
  return [...new Set(uids)].join(",")
}

/** Standard base64 → bytes (the imap_fetch_source wire payload). */
function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** Group message refs by folder for per-folder UID operations. */
function groupRefsByFolder(refs: MessageRef[]): Map<string, number[]> {
  const grouped = new Map<string, number[]>()
  for (const ref of refs) {
    const uids = grouped.get(ref.folder)
    if (uids) {
      uids.push(ref.uid)
    } else {
      grouped.set(ref.folder, [ref.uid])
    }
  }
  return grouped
}

function normalizeAddress(address: {
  name?: string | null
  email?: string | null
}): EmailAddress {
  return {
    name: address.name ?? undefined,
    email: address.email ?? undefined,
  }
}

/** ImapMessage → NormalizedMessage (Rust Option nulls → undefined). */
export function toNormalizedMessage(
  message: {
    uid: number
    flags: string[]
    messageId?: string | null
    inReplyTo?: string | null
    references?: string | null
    listUnsubscribe?: string | null
    listUnsubscribePost?: string | null
    authResults?: string | null
    subject?: string | null
    from: { name?: string | null; email?: string | null }[]
    to: { name?: string | null; email?: string | null }[]
    cc: { name?: string | null; email?: string | null }[]
    bcc: { name?: string | null; email?: string | null }[]
    date: number
    textBody?: string | null
    htmlBody?: string | null
    size: number
    attachments: {
      partId: string
      filename: string
      mimeType: string
      size: number
      contentId?: string | null
      isInline: boolean
    }[]
  },
  folder: string
): NormalizedMessage {
  const attachments: NormalizedAttachment[] = message.attachments.map(
    (attachment) => ({
      partId: attachment.partId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      contentId: attachment.contentId ?? undefined,
      isInline: attachment.isInline,
    })
  )
  return {
    uid: message.uid,
    flags: message.flags,
    messageId: message.messageId ?? undefined,
    inReplyTo: message.inReplyTo ?? undefined,
    references: message.references ?? undefined,
    // Task 18.3 (D13): the Rust ImapMessage carries the list-unsubscribe
    // header pair verbatim; buildStoredHeaders (imap-sync) persists it.
    listUnsubscribe: message.listUnsubscribe ?? undefined,
    listUnsubscribePost: message.listUnsubscribePost ?? undefined,
    // Task 2.1 (D10): the Rust ImapMessage carries the compact
    // Authentication-Results verdicts already consolidated Rust-side;
    // upsertMessageByProviderId persists the auth_results column.
    authResults: message.authResults ?? undefined,
    subject: message.subject ?? undefined,
    from: message.from.map(normalizeAddress),
    to: message.to.map(normalizeAddress),
    cc: message.cc.map(normalizeAddress),
    bcc: message.bcc.map(normalizeAddress),
    date: message.date,
    textBody: message.textBody ?? undefined,
    htmlBody: message.htmlBody ?? undefined,
    size: message.size,
    attachments,
    folder,
  }
}

function toOutgoingEmail(input: SendEmailInput): OutgoingEmail {
  // Task 16.2, design D10: the alias (when set) rides as the From HEADER
  // — the Rust side builds the lettre message from this exact identity —
  // while `from` (the account identity) is sent as `envelopeFrom` by
  // sendMessage so MAIL FROM stays the authenticated account.
  const headerFrom = input.fromAlias ?? input.from
  return {
    from: { name: headerFrom.name ?? null, email: headerFrom.email },
    to: input.to.map((address) => ({
      name: address.name ?? null,
      email: address.email ?? "",
    })),
    cc: (input.cc ?? []).map((address) => ({
      name: address.name ?? null,
      email: address.email ?? "",
    })),
    bcc: (input.bcc ?? []).map((address) => ({
      name: address.name ?? null,
      email: address.email ?? "",
    })),
    subject: input.subject,
    htmlBody: input.htmlBody ?? null,
    textBody: input.textBody ?? null,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? null,
    messageId: input.messageId ?? null,
    // Task 8.5: attachments ride the wire base64-encoded; the Rust side
    // decodes them and builds the multipart/mixed wrapper. Omitted when
    // absent/empty so the existing wire shape is unchanged.
    ...(input.attachments?.length
      ? {
          attachments: input.attachments.map((attachment) => ({
            filename: attachment.filename,
            mimeType: attachment.mimeType ?? null,
            contentBase64: attachment.contentBase64,
          })),
        }
      : {}),
  }
}

/**
 * The raw send's RCPT TO list: every To/Cc/Bcc address, trimmed (mirrors
 * collect_recipients Rust-side, which likewise does not dedup).
 */
function envelopeRecipients(input: SendEmailInput): string[] {
  return [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]
    .map((address) => (address.email ?? "").trim())
    .filter((email) => email !== "")
}

/**
 * Build the provider for one IMAP account. `credentials` arrive already
 * decrypted (the encryption service is task 5.1 — a plain password object
 * for now). Connection params are fixed at creation; recreate the
 * provider after a password change.
 */
export function createImapSmtpProvider(
  account: EmailAccount,
  credentials: ProviderCredentials
): EmailProvider {
  if (!account.imapHost || !account.imapPort) {
    throw new Error(
      `Account ${account.id} (${account.email}) has no IMAP host/port configured`
    )
  }

  const imapParams: ImapParams = {
    host: account.imapHost,
    port: account.imapPort,
    security: account.imapSecurity ?? "tls",
    username: account.email,
    password: credentials.password,
    acceptInvalidCerts: credentials.acceptInvalidCerts ?? false,
  }

  const smtpParams: SmtpParams | null = account.smtpHost
    ? {
        host: account.smtpHost,
        port: account.smtpPort ?? 587,
        security: account.smtpSecurity ?? "tls",
        username: account.email,
        password: credentials.password,
        acceptInvalidCerts: credentials.acceptInvalidCerts ?? false,
      }
    : null

  function requireSmtpParams(): SmtpParams {
    if (!smtpParams) {
      throw new Error(
        `Account ${account.id} (${account.email}) has no SMTP host configured`
      )
    }
    return smtpParams
  }

  /** Wrap a command call so credential failures surface typed. */
  async function call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      throw mapProviderError(account.id, error)
    }
  }

  async function listFolders(): Promise<EmailFolder[]> {
    const folders = await call(() => imapListFolders(imapParams))
    // Containers (\NoSelect) are filtered inside the mapper; flagged/all
    // roles are kept and mapped to Starred/All-Mail (D14).
    return toEmailFolders(folders)
  }

  /** Resolve a role's folder path from the live folder list. */
  async function findFolderByRole(
    specialUse: "archive" | "trash"
  ): Promise<EmailFolder> {
    const folders = await listFolders()
    const match = folders.find(
      (folder) => folder.specialUse === specialUse && folder.type === "system"
    )
    if (!match) {
      throw new Error(
        `Account ${account.id}: server exposes no "${specialUse}" folder`
      )
    }
    return match
  }

  /** Run a folder-scoped UID op once per source folder. */
  async function forEachFolderGroup(
    refs: MessageRef[],
    run: (folder: string, uidSet: string) => Promise<void>
  ): Promise<void> {
    for (const [folder, uids] of groupRefsByFolder(refs)) {
      const uidSet = uidSetFromUids(uids)
      if (uidSet) await run(folder, uidSet)
    }
  }

  return {
    accountId: account.id,
    type: "imap",

    listFolders,

    // Task 4.3 (UIDVALIDITY + last-UID per folder) fills this in; keeping
    // the method present now fixes the seam for sync consumers.
    async deltaSync(): Promise<DeltaSyncResult> {
      throw new Error(
        "deltaSync is not implemented for IMAP accounts yet (task 4.3)"
      )
    },

    async fetchMessages(
      folder: string,
      query: FetchQuery
    ): Promise<FetchMessagesResult> {
      if (query.uidSet === undefined && query.last === undefined) {
        throw new Error("fetchMessages requires uidSet or last")
      }
      const result = await call(() =>
        imapFetchMessages(imapParams, folder, query.uidSet ?? "", query.last)
      )
      return {
        messages: result.messages.map((message) =>
          toNormalizedMessage(message, folder)
        ),
        folderStatus: result.folderStatus,
      }
    },

    async fetchFlags(
      folder: string,
      query: FetchQuery
    ): Promise<MessageFlags[]> {
      if (query.uidSet === undefined && query.last === undefined) {
        throw new Error("fetchFlags requires uidSet or last")
      }
      const flags = await call(() =>
        imapFetchFlags(imapParams, folder, query.uidSet ?? "", query.last)
      )
      return flags
    },

    async storeFlags(
      folder: string,
      uidSet: string,
      flags: string[],
      add: boolean
    ): Promise<void> {
      await call(() => imapStoreFlags(imapParams, folder, uidSet, flags, add))
    },

    async markRead(refs: MessageRef[], read: boolean): Promise<void> {
      await forEachFolderGroup(refs, (folder, uidSet) =>
        call(() => imapStoreFlags(imapParams, folder, uidSet, ["\\Seen"], read))
      )
    },

    async markStarred(refs: MessageRef[], starred: boolean): Promise<void> {
      await forEachFolderGroup(refs, (folder, uidSet) =>
        call(() =>
          imapStoreFlags(imapParams, folder, uidSet, ["\\Flagged"], starred)
        )
      )
    },

    // IMAP has no server-side labels; organization treats folders as the
    // label space (moveToFolder). Gmail implements these for real in 4.2.
    async addLabels(): Promise<void> {},

    async removeLabels(): Promise<void> {},

    async archive(refs: MessageRef[]): Promise<void> {
      const destination = await findFolderByRole("archive")
      await forEachFolderGroup(refs, async (folder, uidSet) => {
        if (folder === destination.path) return
        await call(() =>
          imapMoveMessage(imapParams, folder, uidSet, destination.path)
        )
      })
    },

    async trash(refs: MessageRef[]): Promise<void> {
      const destination = await findFolderByRole("trash")
      await forEachFolderGroup(refs, async (folder, uidSet) => {
        if (folder === destination.path) return
        await call(() =>
          imapMoveMessage(imapParams, folder, uidSet, destination.path)
        )
      })
    },

    async moveToFolder(
      refs: MessageRef[],
      destinationFolder: string
    ): Promise<void> {
      await forEachFolderGroup(refs, async (folder, uidSet) => {
        if (folder === destinationFolder) return
        await call(() =>
          imapMoveMessage(imapParams, folder, uidSet, destinationFolder)
        )
      })
    },

    async deleteForever(refs: MessageRef[]): Promise<void> {
      await forEachFolderGroup(refs, (folder, uidSet) =>
        call(() => imapDeleteMessage(imapParams, folder, uidSet))
      )
    },

    /**
     * Raw source (task 1.2, design D6): the imap_fetch_source command's
     * BODY.PEEK[] full-message fetch (no \Seen side effect), base64 over
     * the bridge, decoded here. One connection per call, nothing cached.
     */
    async getMessageSource(ref: MessageRef): Promise<string> {
      const base64 = await call(() =>
        imapFetchSource(imapParams, ref.folder, ref.uid)
      )
      return new TextDecoder().decode(base64ToBytes(base64))
    },

    async sendMessage(input: SendEmailInput) {
      // Task 18.5 (design D11): a PGP send arrives FULLY BUILT (the
      // signed/encrypted PGP/MIME was frozen into the queued input at
      // enqueue time — the passphrase exists only there) and is
      // transmitted verbatim through the raw command; letting Rust build
      // the MIME from the structured fields would unwrap the protection.
      // The fields stay for bookkeeping only. The envelope mirrors the
      // alias send below (D10): MAIL FROM is the authenticated account
      // address and RCPT TO the structured recipients the send flow
      // validated — never parsed back out of the raw headers.
      if (input.pgpMime) {
        // Hoisted: the property narrowing does not survive into the
        // call() closure below.
        const pgpMime = input.pgpMime
        await call(() =>
          smtpSendRawEmail(
            requireSmtpParams(),
            pgpMime,
            envelopeRecipients(input),
            input.from.email
          )
        )
        return { messageId: input.messageId ?? "" }
      }
      // Inline body images (batch C2): they ride multipart/related, which
      // the Rust MIME builder does not emit — build the complete message
      // TS-side (the same builder Gmail/Graph use, with the data: srcs
      // extracted into Content-ID'd parts) and transmit verbatim through
      // the raw command. The envelope is identical to the structured path
      // below (D10: the alias rides in the header, never the MAIL FROM).
      if (hasInlineImages(input.htmlBody)) {
        const raw = buildMimeMessage(input).mime
        await call(() =>
          smtpSendRawEmail(
            requireSmtpParams(),
            raw,
            envelopeRecipients(input),
            input.from.email
          )
        )
        return { messageId: input.messageId ?? "" }
      }
      // D10 (task 16.2): with an alias, the MIME From header carries the
      // alias (toOutgoingEmail above) while MAIL FROM is pinned to the
      // authenticated account address — the Rust command then transmits
      // via the raw-envelope path instead of deriving the envelope from
      // the (aliased) From header.
      const envelopeFrom = input.fromAlias ? input.from.email : undefined
      const result = await call(() =>
        smtpSendEmail(requireSmtpParams(), toOutgoingEmail(input), envelopeFrom)
      )
      return { messageId: result.messageId }
    },

    async appendMessage(folder: string, raw: Uint8Array, flags?: string[]) {
      await call(() => imapAppend(imapParams, folder, Array.from(raw), flags))
    },

    async testConnection(): Promise<ConnectionTestResult> {
      try {
        const imapResult = await imapTestConnection(imapParams)
        if (smtpParams) {
          const smtpResult = await smtpTestConnection(smtpParams)
          if (!smtpResult.authenticated) {
            return {
              success: false,
              message: `IMAP OK (${imapResult.folderCount} folders), but SMTP did not authenticate`,
            }
          }
        }
        return {
          success: true,
          message: `Connected to ${imapResult.host}:${imapResult.port} (${imapResult.folderCount} folders)`,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message,
          authError: isAuthErrorMessage(message),
        }
      }
    },
  }
}
