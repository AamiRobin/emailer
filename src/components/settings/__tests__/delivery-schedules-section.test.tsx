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
 * Delivery-schedules settings section tests (task 12.2). Same
 * executor-injection pattern as the rules-section suite: the executor
 * module is mocked to hand every consumer the shared seeded node:sqlite
 * executor, and the section runs against the REAL delivery-schedules CRUD
 * (no service mocks — the add/edit/reorder/delete assertions read back
 * through the same executor). The account store is seeded directly because
 * the section scopes itself to the ACTIVE account. The toast is mocked
 * (sonner renders nothing under jsdom).
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

import { createAccount } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  createDeliverySchedule,
  listDeliverySchedules,
} from "@/services/settings/delivery-schedules"
import { useAccountStore } from "@/stores/account-store"
import { DeliverySchedulesSection } from "../delivery-schedules-section"

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

async function seedSchedule(
  input: Parameters<typeof createDeliverySchedule>[2]
): Promise<string> {
  const schedule = await createDeliverySchedule(executor, accountId, input)
  return schedule.id
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

describe("DeliverySchedulesSection", () => {
  it("shows the empty state when the active account has no schedules", async () => {
    render(<DeliverySchedulesSection />)

    expect(await screen.findByText(/No schedules yet/)).toBeTruthy()
    expect(screen.queryByTestId("settings-delivery-schedule-row")).toBeNull()
  })

  it("shows the no-account state when no account is active", async () => {
    useAccountStore.setState({ accounts: [], activeAccountId: null })
    render(<DeliverySchedulesSection />)

    expect(await screen.findByText(/Add an account to manage/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Add Schedule" })).toHaveProperty(
      "disabled",
      true
    )
  })

  it("lists rows with match and window chips, deriving labels for unnamed schedules", async () => {
    await seedSchedule({
      name: "Newsletters",
      match: { kind: "label", value: "Newsletters" },
      window: { kind: "weekly", dayOfWeek: 6, hour: 8, minute: 0 },
    })
    await seedSchedule({
      name: "Morning brief",
      match: { kind: "sender", value: "brief@x.com" },
      window: { kind: "weekly", dayOfWeek: 0, hour: 9, minute: 30 },
    })
    await seedSchedule({
      match: { kind: "sender", value: "digest@x.com" },
      // Unnamed → the derived title; noon/AM-12 special case plus padding.
      window: { kind: "weekly", dayOfWeek: 4, hour: 0, minute: 0 },
    })
    await seedSchedule({
      match: { kind: "label", value: "Receipts" },
      window: { kind: "weekly", dayOfWeek: 3, hour: 15, minute: 5 },
    })

    render(<DeliverySchedulesSection />)

    await screen.findByText("Newsletters")
    expect(screen.getByText("Morning brief")).toBeTruthy()
    // Unnamed schedules derive their title from the weekly window; the
    // string appears twice on those rows (title + window chip).
    expect(screen.getAllByText("Thursdays 12:00 AM")).toHaveLength(2)
    expect(screen.getAllByText("Wednesdays 3:05 PM")).toHaveLength(2)
    // Match chips per kind, human window chips per row.
    expect(screen.getByText("Label: Newsletters")).toBeTruthy()
    expect(screen.getByText("Sender: brief@x.com")).toBeTruthy()
    expect(screen.getByText("Sender: digest@x.com")).toBeTruthy()
    expect(screen.getByText("Label: Receipts")).toBeTruthy()
    expect(screen.getByText("Saturdays 8:00 AM")).toBeTruthy()
    expect(screen.getByText("Sundays 9:30 AM")).toBeTruthy()
    expect(
      screen.getAllByTestId("settings-delivery-schedule-row")
    ).toHaveLength(4)
    // Ordering controls disable at the edges.
    expect(
      screen.getByRole("button", { name: "Move Newsletters up" })
    ).toHaveProperty("disabled", true)
    expect(
      screen.getByRole("button", { name: "Move Wednesdays 3:05 PM down" })
    ).toHaveProperty("disabled", true)
  })

  it("adds a schedule through the weekly window picker and persists the payload", async () => {
    render(<DeliverySchedulesSection />)

    fireEvent.click(screen.getByRole("button", { name: "Add Schedule" }))
    await screen.findByRole("dialog")

    // Invalid until the match value is filled (the window has defaults).
    expect(
      screen.getByRole("button", { name: "Create Schedule" })
    ).toHaveProperty("disabled", true)

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Weekend digests" },
    })
    fireEvent.click(screen.getByRole("combobox", { name: "Match by" }))
    chooseOption(await screen.findByRole("option", { name: "Label" }))
    fireEvent.change(screen.getByLabelText("Label name"), {
      target: { value: "Newsletters" },
    })
    fireEvent.click(screen.getByRole("combobox", { name: "Delivery day" }))
    chooseOption(await screen.findByRole("option", { name: "Saturday" }))
    fireEvent.change(screen.getByLabelText("Delivery time"), {
      target: { value: "08:00" },
    })
    // A cleared time disables save (the window would be incomplete)…
    fireEvent.change(screen.getByLabelText("Delivery time"), {
      target: { value: "" },
    })
    expect(
      screen.getByRole("button", { name: "Create Schedule" })
    ).toHaveProperty("disabled", true)
    // …then the real value arms it.
    fireEvent.change(screen.getByLabelText("Delivery time"), {
      target: { value: "08:00" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create Schedule" }))

    expect(
      await screen.findByTestId("settings-delivery-schedule-row")
    ).toBeTruthy()
    const schedules = await listDeliverySchedules(executor, accountId)
    expect(schedules).toHaveLength(1)
    expect(schedules[0]).toMatchObject({
      name: "Weekend digests",
      match: { kind: "label", value: "Newsletters" },
      window: { kind: "weekly", dayOfWeek: 6, hour: 8, minute: 0 },
      position: 0,
    })
    expect(toastMock.success).toHaveBeenCalledTimes(1)
  })

  it("edits prefilled, including the day and time, and saves the changes", async () => {
    await seedSchedule({
      name: "Newsletters",
      match: { kind: "label", value: "Newsletters" },
      window: { kind: "weekly", dayOfWeek: 6, hour: 8, minute: 0 },
    })

    render(<DeliverySchedulesSection />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit Newsletters" })
    )

    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain("Edit Delivery Schedule")
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Newsletters")
    expect(screen.getByLabelText("Label name")).toHaveProperty(
      "value",
      "Newsletters"
    )
    // The closed SelectValue resolves labels through the `items` map, so
    // the prefills render as the human-readable option labels.
    expect(
      screen.getByRole("combobox", { name: "Match by" }).textContent
    ).toContain("Label")
    expect(
      screen.getByRole("combobox", { name: "Delivery day" }).textContent
    ).toContain("Saturday")
    expect(screen.getByLabelText("Delivery time")).toHaveProperty(
      "value",
      "08:00"
    )

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Newsletters v2" },
    })
    fireEvent.click(screen.getByRole("combobox", { name: "Delivery day" }))
    chooseOption(await screen.findByRole("option", { name: "Monday" }))
    fireEvent.change(screen.getByLabelText("Delivery time"), {
      target: { value: "09:30" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    expect(await screen.findByText("Newsletters v2")).toBeTruthy()
    const schedules = await listDeliverySchedules(executor, accountId)
    expect(schedules).toHaveLength(1)
    expect(schedules[0]).toMatchObject({
      name: "Newsletters v2",
      match: { kind: "label", value: "Newsletters" },
      window: { kind: "weekly", dayOfWeek: 1, hour: 9, minute: 30 },
      position: 0,
    })
  })

  it("reorders by swapping with the neighbor row and persists the order", async () => {
    await seedSchedule({
      name: "First",
      match: { kind: "sender", value: "first@x.com" },
      window: { kind: "weekly", dayOfWeek: 6, hour: 8, minute: 0 },
    })
    const secondId = await seedSchedule({
      name: "Second",
      match: { kind: "sender", value: "second@x.com" },
      window: { kind: "weekly", dayOfWeek: 0, hour: 9, minute: 30 },
    })

    render(<DeliverySchedulesSection />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Move Second up" })
    )

    // The list re-renders with Second above First…
    await waitFor(() => {
      const rows = screen.getAllByTestId("settings-delivery-schedule-row")
      expect(rows[0]?.textContent).toContain("Second")
      expect(rows[1]?.textContent).toContain("First")
    })
    // …and the persisted order (the hold evaluation order) matches, with
    // positions re-densified by the service.
    const schedules = await listDeliverySchedules(executor, accountId)
    expect(schedules.map((schedule) => schedule.name)).toEqual([
      "Second",
      "First",
    ])
    expect(schedules.map((schedule) => schedule.id)).toEqual([
      secondId,
      schedules[1]!.id,
    ])
    expect(schedules.map((schedule) => schedule.position)).toEqual([0, 1])
  })

  it("deletes a schedule immediately and keeps the others", async () => {
    await seedSchedule({
      name: "Doomed",
      match: { kind: "sender", value: "doomed@x.com" },
      window: { kind: "weekly", dayOfWeek: 6, hour: 8, minute: 0 },
    })
    await seedSchedule({
      name: "Keeper",
      match: { kind: "sender", value: "keeper@x.com" },
      window: { kind: "weekly", dayOfWeek: 0, hour: 9, minute: 30 },
    })

    render(<DeliverySchedulesSection />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete Doomed" })
    )

    await waitFor(() => {
      expect(screen.queryByText("Doomed")).toBeNull()
    })
    expect(screen.getByText("Keeper")).toBeTruthy()
    const schedules = await listDeliverySchedules(executor, accountId)
    expect(schedules.map((schedule) => schedule.name)).toEqual(["Keeper"])
  })
})
