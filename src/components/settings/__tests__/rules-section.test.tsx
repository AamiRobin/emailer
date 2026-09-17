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
 * Rules settings section tests (task 11.3). Same executor-injection
 * pattern as the notifications-section suite: the executor module is
 * mocked to hand every consumer the shared seeded node:sqlite executor,
 * and the section runs against the real rules CRUD (no service mocks —
 * the add/toggle/reorder/delete assertions read back through the same
 * executor). The account store is seeded directly because the section
 * scopes itself to the ACTIVE account. The toast is mocked (sonner
 * renders nothing under jsdom).
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
import { createRule, listRules } from "@/services/rules"
import { useAccountStore } from "@/stores/account-store"
import { RulesSection } from "../rules-section"

let executor: TestExecutor
let accountId: string

function seedActiveAccount(): void {
  useAccountStore.setState({
    accounts: [
      {
        id: accountId,
        type: "gmail",
        email: `${accountId}@example.com`,
        displayName: null,
        status: "active",
        unreadCount: 0,
        lastSyncAt: null,
      },
    ],
    activeAccountId: accountId,
    loaded: true,
  })
}

/** Base UI Select ignores synthetic clicks that did not start with a
 * pointerdown on the item (drag-select guard), so send both. */
function chooseOption(option: HTMLElement): void {
  fireEvent.pointerDown(option)
  fireEvent.click(option)
}

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  accountId = await createAccount(executor, "gmail")
  seedActiveAccount()
})

afterEach(() => {
  cleanup()
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: true,
  })
  executorHolder.current = null
  executor.close()
  vi.clearAllMocks()
})

describe("RulesSection", () => {
  it("shows the empty state when the active account has no rules", async () => {
    render(<RulesSection />)

    expect(await screen.findByText(/No rules yet/)).toBeTruthy()
    expect(screen.queryByTestId("settings-rule-row")).toBeNull()
  })

  it("shows the no-account state when no account is active", async () => {
    useAccountStore.setState({ accounts: [], activeAccountId: null })
    render(<RulesSection />)

    expect(await screen.findByText(/Add an account to manage/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Add Rule" })).toHaveProperty(
      "disabled",
      true
    )
  })

  it("lists the account's rules with criteria queries and action chips", async () => {
    await createRule(executor, {
      accountId,
      name: "Newsletters",
      criteriaQuery: "from:news@x.com",
      actions: [
        { type: "archive" },
        { type: "add_labels", labels: ["Newsletters"] },
      ],
    })
    await createRule(executor, {
      accountId,
      name: "Big attachments",
      criteriaQuery: "has:attachment subject:invoice",
      actions: [{ type: "move", folder: "Archive/2024" }],
    })
    await createRule(executor, {
      accountId,
      name: "Quiet stars",
      criteriaQuery: "label:receipts",
      actions: [{ type: "star" }, { type: "mark_read" }],
    })

    render(<RulesSection />)

    await screen.findByText("Newsletters")
    expect(screen.getByText("from:news@x.com")).toBeTruthy()
    expect(screen.getByText("has:attachment subject:invoice")).toBeTruthy()
    expect(screen.getByText("label:receipts")).toBeTruthy()
    // Human action chips per type.
    expect(screen.getByText("Archive")).toBeTruthy()
    expect(screen.getByText("Label: Newsletters")).toBeTruthy()
    expect(screen.getByText("Move: Archive/2024")).toBeTruthy()
    expect(screen.getByText("Star")).toBeTruthy()
    expect(screen.getByText("Mark read")).toBeTruthy()
    expect(screen.getAllByTestId("settings-rule-row")).toHaveLength(3)
    // Ordering controls disable at the edges.
    expect(
      screen.getByRole("button", { name: "Move Newsletters up" })
    ).toHaveProperty("disabled", true)
    expect(
      screen.getByRole("button", { name: "Move Quiet stars down" })
    ).toHaveProperty("disabled", true)
  })

  it("documents the criteria operators in the add dialog", async () => {
    render(<RulesSection />)

    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }))

    const dialog = await screen.findByRole("dialog")
    for (const operator of [
      "from:",
      "to:",
      "subject:",
      "label:",
      "has:attachment",
      "is:unread",
      "is:starred",
    ]) {
      expect(dialog.textContent).toContain(operator)
    }
  })

  it("adds a rule with the default archive action via the CRUD layer", async () => {
    render(<RulesSection />)

    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }))
    await screen.findByRole("dialog")

    // Invalid until name + criteria are filled.
    expect(screen.getByRole("button", { name: "Create Rule" })).toHaveProperty(
      "disabled",
      true
    )

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Newsletters" },
    })
    fireEvent.change(screen.getByLabelText("When a message matches"), {
      target: { value: "from:news@x.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create Rule" }))

    expect(await screen.findByTestId("settings-rule-row")).toBeTruthy()
    const rows = await listRules(executor, accountId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: "Newsletters",
      criteria_json: JSON.stringify({ query: "from:news@x.com" }),
      actions_json: JSON.stringify([{ type: "archive" }]),
      enabled: 1,
      position: 0,
    })
    expect(toastMock.success).toHaveBeenCalledTimes(1)
  })

  it("builds add_labels and move actions through the action builder", async () => {
    render(<RulesSection />)

    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }))
    await screen.findByRole("dialog")

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "File newsletters" },
    })
    fireEvent.change(screen.getByLabelText("When a message matches"), {
      target: { value: "from:news@x.com" },
    })
    // Action 1: the archive default becomes an add_labels action.
    fireEvent.click(screen.getByRole("combobox", { name: "Action 1 type" }))
    chooseOption(await screen.findByRole("option", { name: "Add labels" }))
    fireEvent.change(screen.getByLabelText("Action 1 labels"), {
      target: { value: "Newsletters, Receipts" },
    })
    // Action 2: a move action with a folder path.
    fireEvent.click(screen.getByRole("button", { name: "Add Action" }))
    fireEvent.click(screen.getByRole("combobox", { name: "Action 2 type" }))
    chooseOption(
      await screen.findByRole("option", { name: "Move to folder (imap)" })
    )
    fireEvent.change(screen.getByLabelText("Action 2 folder"), {
      target: { value: "Archive/2024" },
    })
    // Action 3: mark-as-spam takes no payload.
    fireEvent.click(screen.getByRole("button", { name: "Add Action" }))
    fireEvent.click(screen.getByRole("combobox", { name: "Action 3 type" }))
    chooseOption(await screen.findByRole("option", { name: "Mark as spam" }))
    fireEvent.click(screen.getByRole("button", { name: "Create Rule" }))

    await screen.findByText("Move: Archive/2024")
    const rows = await listRules(executor, accountId)
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.actions_json)).toEqual([
      { type: "add_labels", labels: ["Newsletters", "Receipts"] },
      { type: "move", folder: "Archive/2024" },
      { type: "mark_as_spam" },
    ])
    expect(screen.getByText("Label: Newsletters, Receipts")).toBeTruthy()
    expect(screen.getByText("Mark as spam")).toBeTruthy()
  })

  it("toggles enabled on the row and persists immediately", async () => {
    await createRule(executor, {
      accountId,
      name: "Quiet",
      criteriaQuery: "from:quiet@x.com",
      actions: [{ type: "archive" }],
      enabled: false,
    })

    render(<RulesSection />)
    fireEvent.click(await screen.findByRole("switch", { name: "Toggle Quiet" }))

    await waitFor(() => {
      return listRules(executor, accountId).then((rows) => {
        expect(rows[0]?.enabled).toBe(1)
      })
    })
  })

  it("reorders by swapping positions with the neighbor row", async () => {
    await createRule(executor, {
      accountId,
      name: "First",
      criteriaQuery: "from:first@x.com",
      actions: [{ type: "archive" }],
    })
    const secondId = await createRule(executor, {
      accountId,
      name: "Second",
      criteriaQuery: "from:second@x.com",
      actions: [{ type: "star" }],
    })

    render(<RulesSection />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Move Second up" })
    )

    // The list re-renders with Second above First…
    await waitFor(() => {
      const rows = screen.getAllByTestId("settings-rule-row")
      expect(rows[0]?.textContent).toContain("Second")
      expect(rows[1]?.textContent).toContain("First")
    })
    // …and the persisted order (what ingestion evaluates) matches.
    const rows = await listRules(executor, accountId)
    expect(rows.map((row) => row.id)).toEqual([secondId, rows[1]!.id])
    expect(rows[0]!.name).toBe("Second")
    expect(rows[1]!.name).toBe("First")
    expect(rows.map((row) => row.position)).toEqual([0, 1])
  })

  it("deletes a rule immediately and keeps the others", async () => {
    const doomed = await createRule(executor, {
      accountId,
      name: "Doomed",
      criteriaQuery: "from:doomed@x.com",
      actions: [{ type: "archive" }],
    })
    await createRule(executor, {
      accountId,
      name: "Keeper",
      criteriaQuery: "from:keeper@x.com",
      actions: [{ type: "star" }],
    })

    render(<RulesSection />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete Doomed" })
    )

    await waitFor(() => {
      expect(screen.queryByText("Doomed")).toBeNull()
    })
    expect(screen.getByText("Keeper")).toBeTruthy()
    const rows = await listRules(executor, accountId)
    expect(rows.map((row) => row.id)).not.toContain(doomed)
    expect(rows).toHaveLength(1)
  })

  it("edits a rule prefilled and saves the changes", async () => {
    await createRule(executor, {
      accountId,
      name: "Newsletters",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "add_labels", labels: ["Newsletters"] }],
    })

    render(<RulesSection />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit Newsletters" })
    )

    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain("Edit Rule")
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Newsletters")
    expect(screen.getByLabelText("When a message matches")).toHaveProperty(
      "value",
      "from:news@x.com"
    )
    expect(screen.getByLabelText("Action 1 labels")).toHaveProperty(
      "value",
      "Newsletters"
    )

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Newsletters v2" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    expect(await screen.findByText("Newsletters v2")).toBeTruthy()
    const rows = await listRules(executor, accountId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: "Newsletters v2", position: 0 })
    expect(JSON.parse(rows[0]!.actions_json)).toEqual([
      { type: "add_labels", labels: ["Newsletters"] },
    ])
  })

  it("mounts an apply-now trigger per row and opens the confirm dialog", async () => {
    // One stored newsletter thread so the dialog's count runs the REAL
    // service path (same executor-injection mock as the dialog's own
    // suite) and resolves to 1.
    const inboxId = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const threadId = await createThread(executor, accountId, {
      subject: "Digest",
    })
    await setThreadLabels(executor, threadId, [inboxId])
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1000,
      fromAddress: "news@x.com",
      subject: "Digest",
      gmailMessageId: "gm-1",
    })
    await recomputeThreadCaches(executor, threadId)
    await createRule(executor, {
      accountId,
      name: "Newsletters",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "archive" }],
    })
    await createRule(executor, {
      accountId,
      name: "Quiet stars",
      criteriaQuery: "label:receipts",
      actions: [{ type: "star" }],
    })

    render(<RulesSection />)
    await screen.findByText("Newsletters")

    // One "Apply now" trigger per rule row.
    const triggers = screen.getAllByTestId("apply-rule-button")
    expect(triggers).toHaveLength(2)

    // Clicking a row's trigger opens the count→confirm dialog; the confirm
    // button stays disabled until the service's count lands, then arms
    // with the count in its label.
    fireEvent.click(triggers[0]!)
    expect(await screen.findByRole("dialog")).toBeTruthy()
    expect(await screen.findByText(/This rule matches 1 thread/)).toBeTruthy()
    await waitFor(() => {
      expect(
        (screen.getByTestId("apply-rule-confirm") as HTMLButtonElement).disabled
      ).toBe(false)
    })
    expect(
      (screen.getByTestId("apply-rule-confirm") as HTMLButtonElement)
        .textContent
    ).toContain("Apply to 1 thread")
  })
})
