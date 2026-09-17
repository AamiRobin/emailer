import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { toast } from "sonner"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * ApplyRuleDialog (task 11.4): the "Apply now" confirmation gate as a
 * component. Runs the REAL service path — countMatchingThreads for the
 * dialog's count, applyRuleNow({ confirmed: true }) on confirm — against
 * a seeded node:sqlite database via the executor-injection mock; only
 * sonner is mocked (the result toast is asserted, not rendered).
 */

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

import {
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { recomputeThreadCaches, setThreadLabels } from "@/services/db/threads"
import { createRule, getRule, type RuleRow } from "@/services/rules/db"
import { ApplyRuleDialog } from "../apply-rule-dialog"

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  executorHolder.current = null
  executor.close()
})

/** A gmail account with two newsletter threads (rule matches) and one
 * personal thread (rule doesn't), all in the inbox. */
async function seedMailbox(): Promise<{
  accountId: string
  matched: string[]
  unmatched: string
}> {
  const accountId = await createAccount(executor, "gmail")
  const inboxId = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  const matched: string[] = []
  for (const [index, subject] of ["Digest one", "Digest two"].entries()) {
    const threadId = await createThread(executor, accountId, { subject })
    await setThreadLabels(executor, threadId, [inboxId])
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1000 + index,
      fromAddress: "news@x.com",
      subject,
      gmailMessageId: `gm-${index}`,
    })
    await recomputeThreadCaches(executor, threadId)
    matched.push(threadId)
  }
  const unmatched = await createThread(executor, accountId, {
    subject: "Personal",
  })
  await setThreadLabels(executor, unmatched, [inboxId])
  await createMessage(executor, {
    threadId: unmatched,
    accountId,
    date: 3000,
    fromAddress: "friend@x.com",
    subject: "Personal",
    gmailMessageId: "gm-9",
  })
  await recomputeThreadCaches(executor, unmatched)
  return { accountId, matched, unmatched }
}

async function seedRule(input: {
  accountId: string
  criteriaQuery: string
}): Promise<RuleRow> {
  const ruleId = await createRule(executor, {
    accountId: input.accountId,
    name: "File newsletters",
    criteriaQuery: input.criteriaQuery,
    actions: [{ type: "archive" }],
  })
  const rule = await getRule(executor, ruleId)
  if (!rule) throw new Error("rule row missing after insert")
  return rule
}

function openDialog(rule: RuleRow, onDone?: (result: unknown) => void) {
  render(<ApplyRuleDialog rule={rule} onDone={onDone} />)
  fireEvent.click(screen.getByTestId("apply-rule-button"))
}

function confirmButton(): HTMLButtonElement {
  return screen.getByTestId("apply-rule-confirm") as HTMLButtonElement
}

describe("ApplyRuleDialog", () => {
  it("shows the service's count and enables confirm only once counted", async () => {
    const { accountId } = await seedMailbox()
    const rule = await seedRule({ accountId, criteriaQuery: "from:news@x.com" })
    const onDone = vi.fn()

    render(<ApplyRuleDialog rule={rule} onDone={onDone} />)
    // Same-tick assertions: the count resolves on a later microtask, so
    // the dialog is guaranteed to still be in its counting state here —
    // the gate must not let a count-less confirm through.
    fireEvent.click(screen.getByTestId("apply-rule-button"))
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.getByText(/Counting matching threads/)).toBeTruthy()
    expect(confirmButton().disabled).toBe(true)
    expect(confirmButton().textContent).toBe("Apply")

    // Once the service's count lands it is shown, and confirm arms with
    // the count in its label.
    expect(await screen.findByText(/matches 2 threads/)).toBeTruthy()
    await waitFor(() => {
      expect(confirmButton().disabled).toBe(false)
    })
    expect(confirmButton().textContent).toContain("Apply to 2 threads")
    expect(onDone).not.toHaveBeenCalled()
  })

  it("confirm applies through the service, toasts the summary and calls onDone", async () => {
    const { accountId, matched, unmatched } = await seedMailbox()
    const rule = await seedRule({ accountId, criteriaQuery: "from:news@x.com" })
    const onDone = vi.fn()

    openDialog(rule, onDone)
    await waitFor(() => {
      expect(confirmButton().disabled).toBe(false)
    })
    fireEvent.click(confirmButton())

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith("Applied to 2 threads")
    })
    expect(onDone).toHaveBeenCalledWith({ matched: 2, applied: 2 })
    // The write went through the real service: exactly the matched
    // threads archived (the personal thread stays), exactly their ops queued.
    const archived = await executor.select<{ id: string; is_archived: number }>(
      "SELECT id, is_archived FROM threads"
    )
    expect(archived).toHaveLength(3)
    const archivedById = new Map(
      archived.map((row) => [row.id, row.is_archived])
    )
    for (const id of matched) {
      expect(archivedById.get(id)).toBe(1)
    }
    expect(archivedById.get(unmatched)).toBe(0)
    const ops = await executor.select<{ op_type: string }>(
      "SELECT op_type FROM pending_operations WHERE account_id = $1",
      [accountId]
    )
    expect(ops.map((op) => op.op_type)).toEqual(["archive", "archive"])
    // The dialog closes after a successful apply.
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })
  })

  it("cancel closes without applying anything", async () => {
    const { accountId } = await seedMailbox()
    const rule = await seedRule({ accountId, criteriaQuery: "from:news@x.com" })
    const onDone = vi.fn()

    openDialog(rule, onDone)
    await waitFor(() => {
      expect(confirmButton().disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })
    expect(onDone).not.toHaveBeenCalled()
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(
      await executor.select("SELECT id FROM threads WHERE is_archived = 1")
    ).toEqual([])
    expect(
      await executor.select(
        "SELECT op_type FROM pending_operations WHERE account_id = $1",
        [accountId]
      )
    ).toEqual([])
  })

  it("keeps confirm disabled when the rule matches nothing", async () => {
    const { accountId } = await seedMailbox()
    const rule = await seedRule({
      accountId,
      criteriaQuery: "from:ghost@nowhere.example",
    })
    const onDone = vi.fn()

    openDialog(rule, onDone)

    expect(await screen.findByText(/match any threads/)).toBeTruthy()
    expect(confirmButton().disabled).toBe(true)
    fireEvent.click(confirmButton())
    expect(onDone).not.toHaveBeenCalled()
    expect(toastMock.success).not.toHaveBeenCalled()
  })
})
