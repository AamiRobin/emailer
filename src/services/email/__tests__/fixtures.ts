import type { EmailAccount, EmailProvider } from "../types"
import { vi } from "vitest"

/** Fixture account rows matching the accounts-table columns. */
export function imapAccount(
  overrides: Partial<EmailAccount> = {}
): EmailAccount {
  return {
    id: "acc-1",
    type: "imap",
    email: "user@example.com",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecurity: "tls",
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    status: "active",
    isActive: true,
    isPinned: false,
    ...overrides,
  }
}

export const imapCredentials = { password: "secret" }

/** A no-op EmailProvider stub for registry tests. */
export function fakeProvider(accountId: string): EmailProvider {
  return {
    accountId,
    type: "gmail",
    listFolders: vi.fn(),
    deltaSync: vi.fn(),
    fetchMessages: vi.fn(),
    fetchFlags: vi.fn(),
    storeFlags: vi.fn(),
    markRead: vi.fn(),
    markStarred: vi.fn(),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    archive: vi.fn(),
    trash: vi.fn(),
    moveToFolder: vi.fn(),
    deleteForever: vi.fn(),
    appendMessage: vi.fn(),
    sendMessage: vi.fn(),
    testConnection: vi.fn(),
  }
}
