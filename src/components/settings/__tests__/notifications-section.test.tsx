import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Notifications settings section tests (task 8.2). Same executor-injection
 * pattern as the snippets-section suite: the executor module is mocked to
 * hand every consumer the shared seeded node:sqlite executor, and the
 * section runs against the real notification-rules CRUD (no service mocks
 * — the add/remove assertions read back through the same executor). The
 * account store is seeded directly (settings-page suite pattern) because
 * the section scopes itself to the ACTIVE account.
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

import { createAccount } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  addNotificationRule,
  listNotificationRules,
} from "@/services/db/notification-rules"
import {
  getNewMailSoundEnabled,
  getSentSoundEnabled,
  setNewMailSoundPreference,
} from "@/services/settings/preferences"
import { useAccountStore } from "@/stores/account-store"
import { NotificationsSection } from "../notifications-section"

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
})

describe("NotificationsSection", () => {
  it("shows the empty state when the active account has no rules", async () => {
    render(<NotificationsSection />)

    expect(await screen.findByText(/No rules yet/)).toBeTruthy()
    expect(screen.queryByTestId("settings-notification-rule-row")).toBeNull()
  })

  it("shows the no-account state when no account is active", async () => {
    useAccountStore.setState({ accounts: [], activeAccountId: null })
    render(<NotificationsSection />)

    expect(await screen.findByText(/Add an account to manage/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Add Rule" })).toHaveProperty(
      "disabled",
      true
    )
  })

  it("lists the active account's rules with type and action", async () => {
    await addNotificationRule(executor, {
      accountId,
      matchType: "sender",
      matchValue: "newsletter@x.com",
      action: "never",
    })
    await addNotificationRule(executor, {
      accountId,
      matchType: "label",
      matchValue: "Receipts",
      action: "always",
    })

    render(<NotificationsSection />)

    await screen.findByText("newsletter@x.com")
    expect(screen.getByText("Receipts")).toBeTruthy()
    expect(screen.getByText("Always notify")).toBeTruthy()
    expect(screen.getAllByText("Never notify")).toHaveLength(1)
    expect(
      screen.getAllByTestId("settings-notification-rule-row")
    ).toHaveLength(2)
  })

  it("adds a rule through the dialog and writes it via the CRUD layer", async () => {
    render(<NotificationsSection />)

    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }))

    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain("Add Notification Rule")
    // Defaults: match by sender, never notify — just type the value.
    fireEvent.change(screen.getByLabelText("Sender address"), {
      target: { value: "news@x.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }))

    expect(await screen.findByText("news@x.com")).toBeTruthy()
    const rows = await listNotificationRules(executor, accountId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      match_type: "sender",
      match_value: "news@x.com",
      action: "never",
    })
  })

  it("switches the dialog to a label rule with always-notify", async () => {
    render(<NotificationsSection />)

    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }))
    await screen.findByRole("dialog")

    fireEvent.click(screen.getByRole("combobox", { name: "Match by" }))
    chooseOption(await screen.findByRole("option", { name: "Label" }))
    fireEvent.change(screen.getByLabelText("Label name"), {
      target: { value: "Receipts" },
    })
    fireEvent.click(screen.getByRole("combobox", { name: "Then" }))
    chooseOption(await screen.findByRole("option", { name: "Always notify" }))
    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }))

    expect(await screen.findByText("Receipts")).toBeTruthy()
    const rows = await listNotificationRules(executor, accountId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      match_type: "label",
      match_value: "Receipts",
      action: "always",
    })
  })

  it("deletes a rule immediately and keeps the others", async () => {
    const doomed = await addNotificationRule(executor, {
      accountId,
      matchType: "sender",
      matchValue: "doomed@x.com",
      action: "never",
    })
    await addNotificationRule(executor, {
      accountId,
      matchType: "sender",
      matchValue: "keeper@x.com",
      action: "never",
    })

    render(<NotificationsSection />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete doomed@x.com" })
    )

    await waitFor(() => {
      expect(screen.queryByText("doomed@x.com")).toBeNull()
    })
    expect(screen.getByText("keeper@x.com")).toBeTruthy()
    const rows = await listNotificationRules(executor, accountId)
    expect(rows.map((row) => row.id)).not.toContain(doomed)
    expect(rows).toHaveLength(1)
  })
})

describe("NotificationsSection sound toggles (task 1.5)", () => {
  it("shows the defaults (new-mail on, sent off) and persists flips", async () => {
    render(<NotificationsSection />)

    const newMail = await screen.findByRole("switch", {
      name: "New-mail sound",
    })
    const sent = screen.getByRole("switch", { name: "Sent-message sound" })
    await waitFor(() => {
      expect(newMail.getAttribute("aria-checked")).toBe("true")
    })
    expect(sent.getAttribute("aria-checked")).toBe("false")

    fireEvent.click(newMail)
    await waitFor(() => {
      expect(newMail.getAttribute("aria-checked")).toBe("false")
    })
    expect(await getNewMailSoundEnabled(executor)).toBe(false)

    fireEvent.click(sent)
    await waitFor(() => {
      expect(sent.getAttribute("aria-checked")).toBe("true")
    })
    expect(await getSentSoundEnabled(executor)).toBe(true)
  })

  it("reflects persisted rows on mount", async () => {
    await setNewMailSoundPreference(executor, false)

    render(<NotificationsSection />)

    const newMail = await screen.findByRole("switch", {
      name: "New-mail sound",
    })
    await waitFor(() => {
      expect(newMail.getAttribute("aria-checked")).toBe("false")
    })
  })
})
