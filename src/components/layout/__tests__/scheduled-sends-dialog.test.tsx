import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { toast } from "sonner"

import {
  createAccount,
  createGmailLabel,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  createScheduledSend,
  listScheduledSends,
  type ScheduledSendRow,
} from "@/services/db/scheduled-sends"
import { buildMimeMessage } from "@/services/email/mime-builder"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { setFolderCountsStoreExecutor } from "@/stores/folder-counts-store"
import { setThreadListStoreExecutor } from "@/stores/thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { useComposerStore } from "@/stores/composer-store"
import { setSidebarDataExecutor } from "../use-sidebar-data"
import { formatSnoozedUntil } from "../use-snoozed-threads"
import {
  setScheduledSendsExecutor,
  notifyScheduledSendsChanged,
} from "../use-scheduled-sends"
import { ScheduledSendsSection } from "../scheduled-sends-dialog"
import { Sidebar } from "../sidebar"

/**
 * The Scheduled sidebar section + dialog (tasks 10.1/10.3). The section
 * runs its real queries against a seeded node:sqlite database via the
 * executor override hooks; the row actions drive the REAL cancel/edit
 * flows (use-scheduled-sends), whose notify is what reloads the dialog —
 * the exact interplay production uses.
 */

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

const toastMock = vi.mocked(toast)

let executor: TestExecutor
let accountId: string

function resetStores(): void {
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
  })
}

beforeEach(async () => {
  resetStores()
  executor = createTestExecutor()
  setScheduledSendsExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
  setThreadListStoreExecutor(executor)
  setSidebarDataExecutor(executor)
  accountId = await createAccount(executor)
  await createGmailLabel(executor, accountId, "INBOX", "INBOX", "inbox")
  useAccountStore.setState({
    accounts: [
      {
        id: accountId,
        type: "gmail",
        email: `me@example.com`,
        displayName: null,
        status: "active",
        unreadCount: 0,
      },
    ],
    activeAccountId: accountId,
    loaded: true,
  })
})

afterEach(async () => {
  cleanup()
  setScheduledSendsExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  setThreadListStoreExecutor(null)
  setSidebarDataExecutor(null)
  useComposerStore.getState().reset()
  executor.close()
  resetStores()
  vi.clearAllMocks()
})

/** Seed one scheduled send built through the real MIME builder — the
 * shape the schedule flow writes (task 10.1). */
async function seedScheduledSend(overrides?: {
  subject?: string
  dueAt?: number
}): Promise<ScheduledSendRow> {
  const dueAt = overrides?.dueAt ?? Math.floor(Date.now() / 1000) + 86_400
  const built = buildMimeMessage({
    from: { email: "me@example.com" },
    to: [{ name: "Ada Lovelace", email: "ada@example.com" }],
    subject: overrides?.subject ?? "Quarterly report",
    htmlBody: "<p>Scheduled body</p>",
    messageId: "<scheduled@example.com>",
  })
  const id = await createScheduledSend(executor, {
    accountId,
    mimePayload: built.mime,
    recipients: [{ name: "Ada Lovelace", email: "ada@example.com" }],
    subject: overrides?.subject ?? "Quarterly report",
    dueAt,
  })
  const rows = await listScheduledSends(executor)
  const row = rows.find((candidate) => candidate.id === id)
  if (!row) throw new Error("seeded row missing")
  return row
}

/** Seed terminal history rows directly (what 10.2's due pass writes). */
async function seedHistory(): Promise<void> {
  await executor.execute(
    `INSERT INTO scheduled_sends (id, account_id, mime_payload, recipients_json, subject, due_at, status, sent_at)
     VALUES ('sent-row', $1, 'm', '[{"email":"a@x.com"}]', 'Sent earlier', 1800000000, 'sent', 1800000060)`,
    [accountId]
  )
  await executor.execute(
    `INSERT INTO scheduled_sends (id, account_id, mime_payload, recipients_json, subject, due_at, status, last_error)
     VALUES ('failed-row', $1, 'm', '[{"email":"b@x.com"}]', 'Failed send', 1800000010, 'failed', 'SMTP refused')`,
    [accountId]
  )
}

describe("Scheduled sidebar section + dialog (tasks 10.1/10.3)", () => {
  it("renders the entry always (discoverable) and shows a pending-count badge", async () => {
    render(<ScheduledSendsSection />)
    // The entry exists before any scheduled send does.
    expect(await screen.findByTestId("scheduled-section")).not.toBeNull()
    expect(screen.queryByTestId("scheduled-count")).toBeNull()

    await seedScheduledSend()
    // The schedule flow notifies after its write — the badge reloads.
    notifyScheduledSendsChanged()
    expect((await screen.findByTestId("scheduled-count")).textContent).toBe("1")
  })

  it("lists pending sends with recipient summary, subject and due time", async () => {
    const row = await seedScheduledSend()
    render(<ScheduledSendsSection />)
    fireEvent.click(screen.getByText("Scheduled"))

    const dialog = await screen.findByTestId("scheduled-sends-dialog")
    const rows = within(dialog).getAllByTestId("scheduled-send-row")
    expect(rows).toHaveLength(1)
    expect(within(rows[0]!).getByText("Quarterly report")).not.toBeNull()
    expect(
      within(rows[0]!).getByText("Ada Lovelace <ada@example.com>")
    ).not.toBeNull()
    expect(
      within(rows[0]!).getByText(`Will send ${formatSnoozedUntil(row.due_at)}`)
    ).not.toBeNull()
  })

  it("shows the due copy for a past-due send: the runner fires it within a minute", async () => {
    await seedScheduledSend({
      dueAt: Math.floor(Date.now() / 1000) - 60,
      subject: "Overdue",
    })
    render(<ScheduledSendsSection />)
    fireEvent.click(screen.getByText("Scheduled"))

    const dialog = await screen.findByTestId("scheduled-sends-dialog")
    expect(
      within(dialog).getByText("Due — sends within a minute")
    ).not.toBeNull()
  })

  it("renders a claimed ('sending') row as queued — visible and cancellable", async () => {
    const row = await seedScheduledSend({ subject: "Claimed send" })
    // The due pass claimed the row (status 'sending') while its op sat
    // queued — offline hold or retry backoff. It must stay in the pending
    // view, rendered distinctly, until the queue resolves it.
    await executor.execute(
      "UPDATE scheduled_sends SET status = 'sending' WHERE id = $1",
      [row.id]
    )
    notifyScheduledSendsChanged()
    render(<ScheduledSendsSection />)
    fireEvent.click(screen.getByText("Scheduled"))

    const dialog = await screen.findByTestId("scheduled-sends-dialog")
    // No pending 'scheduled' rows — the claimed one renders in its own
    // queued group with the honest copy.
    expect(within(dialog).queryByTestId("scheduled-send-row")).toBeNull()
    const queued = within(dialog).getByTestId("scheduled-send-queued-row")
    expect(within(queued).getByText("Claimed send")).not.toBeNull()
    expect(
      within(queued).getByText("Queued — will send when online")
    ).not.toBeNull()
    // Cancellable (the queue's pre-transmit re-check drops the send) but
    // not editable (its payload is already claimed for transmission).
    expect(
      within(queued).getByRole("button", {
        name: "Cancel scheduled send Claimed send",
      })
    ).not.toBeNull()
    expect(
      within(queued).queryByRole("button", {
        name: "Edit scheduled send Claimed send",
      })
    ).toBeNull()
    // The sidebar badge still counts it.
    expect((await screen.findByTestId("scheduled-count")).textContent).toBe("1")
  })

  it("cancel hides the row and marks it cancelled (kept for audit)", async () => {
    await seedScheduledSend()
    render(<ScheduledSendsSection />)
    fireEvent.click(screen.getByText("Scheduled"))
    const dialog = await screen.findByTestId("scheduled-sends-dialog")

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Cancel scheduled send Quarterly report",
      })
    )

    await waitFor(() => {
      expect(screen.queryByTestId("scheduled-send-row")).toBeNull()
    })
    expect(await listScheduledSends(executor)).toHaveLength(0)
    const status = await executor.select<{ status: string }>(
      "SELECT status FROM scheduled_sends"
    )
    expect(status[0]!.status).toBe("cancelled")
    expect(toastMock.success).toHaveBeenCalledWith("Scheduled send cancelled")
  })

  it("edit restores the composer content and cancels the schedule", async () => {
    await seedScheduledSend({ subject: "Editable" })
    render(<ScheduledSendsSection />)
    fireEvent.click(screen.getByText("Scheduled"))
    const dialog = await screen.findByTestId("scheduled-sends-dialog")

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Edit scheduled send Editable",
      })
    )

    // The dialog closes and the composer store holds the stored content.
    await waitFor(() => {
      expect(screen.queryByTestId("scheduled-sends-dialog")).toBeNull()
    })
    const composer = useComposerStore.getState()
    expect(composer.open).toBe(true)
    expect(composer.activeAccountId).toBe(accountId)
    expect(composer.to).toEqual([
      { name: "Ada Lovelace", email: "ada@example.com" },
    ])
    expect(composer.subject).toBe("Editable")
    expect(composer.html).toBe("<p>Scheduled body</p>")
    // The schedule stands cancelled until re-sent.
    expect(await listScheduledSends(executor)).toHaveLength(0)
  })

  it("shows sent/failed history muted, without edit/cancel buttons", async () => {
    await seedHistory()
    render(<ScheduledSendsSection />)
    fireEvent.click(screen.getByText("Scheduled"))

    const dialog = await screen.findByTestId("scheduled-sends-dialog")
    const history = within(dialog).getAllByTestId("scheduled-send-history-row")
    expect(history).toHaveLength(2)
    expect(within(dialog).getByText("Sent earlier")).not.toBeNull()
    expect(within(dialog).getAllByText("Sent")).not.toBeNull()
    expect(within(dialog).getByText("Failed — SMTP refused")).not.toBeNull()
    // History rows offer no edit/cancel.
    expect(
      within(dialog).queryByRole("button", {
        name: "Cancel scheduled send Failed send",
      })
    ).toBeNull()
  })

  it("renders the entry inside the sidebar", async () => {
    render(
      <TooltipProvider delay={0}>
        <Sidebar isCollapsed={false} />
      </TooltipProvider>
    )
    expect(await screen.findByTestId("scheduled-section")).not.toBeNull()
  })
})
