import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"
import type { MessageRow } from "@/services/db/messages"
import type { EmailAccount } from "@/services/email/types"

/**
 * Send again on the reading pane (batch C3): an expanded message whose
 * thread sits in the account's sent folder carries a "Send again" entry
 * beside View source; clicking it opens the composer prefilled as a NEW
 * message from the sent one. The heavy prefill semantics (verbatim
 * subject, fresh threading, attachment restore + notice) are covered by
 * services/composer/__tests__/send-again.test.ts — this suite covers the
 * affordance's visibility rule and the click wiring.
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

const executorHolder = vi.hoisted(() => ({
  current: null as SqlExecutor | null,
}))

vi.mock("@/services/db/executor", () => ({
  getExecutor: () => {
    const executor = executorHolder.current
    if (!executor) throw new Error("test executor not set")
    return executor
  },
  placeholders: (count: number, firstIndex = 1): string =>
    Array.from({ length: count }, (_, index) => `$${index + firstIndex}`).join(
      ", "
    ),
}))

import { createAccount, createMessage, createThread, uid } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { insertLabel } from "@/services/db/labels"
import { setThreadLabels } from "@/services/db/threads"
import { useComposerStore } from "@/stores/composer-store"
import { useUiStore } from "@/stores/ui-store"
import { MailDisplay } from "../mail-display"

let executor: TestExecutor
let accountId: string

const account: EmailAccount = {
  id: "",
  type: "gmail",
  email: "",
  status: "active",
  isActive: true,
  isPinned: false,
}

/** Seed one message in (or out of) the sent folder; returns the full row. */
async function seedMessage(inSent: boolean): Promise<MessageRow> {
  accountId = await createAccount(executor, "gmail")
  account.id = accountId
  account.email = `${accountId}@example.com`
  const sentLabelId = uid("label")
  await insertLabel(executor, {
    id: sentLabelId,
    accountId,
    name: "SENT",
    gmailLabelId: "SENT",
    specialUse: "sent",
    type: "system",
  })
  const threadId = await createThread(executor, accountId, {
    subject: "Quarterly report",
  })
  const messageId = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000,
    subject: "Quarterly report",
    fromName: "Me",
    fromAddress: account.email,
    to: [{ name: "Alice", email: "alice@example.com" }],
    isRead: true,
  })
  await executor.execute("UPDATE messages SET body_html = $1 WHERE id = $2", [
    "<p>Hi there</p>",
    messageId,
  ])
  if (inSent) {
    await setThreadLabels(executor, threadId, [sentLabelId])
  }
  const rows = await executor.select<MessageRow>(
    "SELECT * FROM messages WHERE id = $1",
    [messageId]
  )
  return rows[0] as MessageRow
}

function renderDisplay(message: MessageRow): void {
  render(
    <MailDisplay
      message={message}
      threadSubject={message.subject}
      imagesAllowed={false}
      onAllowSender={vi.fn()}
      initiallyUnread={false}
      expanded={true}
      onToggleExpanded={vi.fn()}
      account={account}
    />
  )
}

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
})

afterEach(async () => {
  cleanup()
  useComposerStore.getState().reset()
  useUiStore.setState({ composerOpen: false })
  await new Promise((resolve) => setTimeout(resolve, 0))
  executorHolder.current = null
  executor.close()
})

describe("Send again on the reading pane (batch C3)", () => {
  it("shows the action for a sent message and prefills a NEW draft on click", async () => {
    renderDisplay(await seedMessage(true))

    const button = await screen.findByTestId("send-again")
    expect(button.textContent).toContain("Send again")

    fireEvent.click(button)
    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(true)
    })
    const state = useComposerStore.getState()
    expect(state.mode).toEqual({ kind: "new" })
    expect(state.activeAccountId).toBe(accountId)
    expect(state.to).toEqual([{ name: "Alice", email: "alice@example.com" }])
    expect(state.subject).toBe("Quarterly report")
    expect(state.html).toBe("<p>Hi there</p>")
    expect(useUiStore.getState().composerOpen).toBe(true)
    expect(useComposerStore.getState().attachmentNotice).toBeNull()
  })

  it("hides the action for messages outside the sent folder", async () => {
    renderDisplay(await seedMessage(false))

    // Give the (negative) sent-folder lookup time to settle.
    await screen.findByTestId("view-source")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByTestId("send-again")).toBeNull()
    expect(useComposerStore.getState().open).toBe(false)
  })
})
