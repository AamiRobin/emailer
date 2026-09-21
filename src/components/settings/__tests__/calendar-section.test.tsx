import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import { CalendarSection } from "../calendar-section"
import { createInMemoryKeyStore } from "@/services/crypto/__tests__/in-memory-key-store"
import { setDefaultKeyStore } from "@/services/crypto/key-management"
import { addCalendarSource } from "@/services/calendar/sources"
import {
  connectCaldavSource,
  discoverCaldavCalendars,
  testCaldavConnection,
} from "@/services/calendar/caldav"
import {
  MicrosoftCalendarConnectCancelledError,
  MicrosoftCalendarConsentDeniedError,
  connectMicrosoftCalendar,
} from "@/services/calendar/connect-microsoft"
import { useAccountStore } from "@/stores/account-store"
import type { SqlExecutor } from "@/services/db/executor"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"

/**
 * Calendar settings-section tests (task 5.2; Outlook source flow added by
 * parity-round-2 task 3.6). The executor module is mocked to hand the
 * section a seeded node:sqlite executor (the REAL sources service runs
 * against it, so list/remove round-trip the real SQL); the CalDAV service
 * module is mocked at its boundary — the command wrappers and
 * connect/sync logic have their own suites — and the Microsoft calendar
 * connect is mocked at the flow boundary (its consent loop is covered by
 * connect-microsoft.test.ts). The Outlook block is only offered while a
 * Microsoft account exists in the account store (spec "No Microsoft
 * account").
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

vi.mock("@/services/calendar/caldav", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/calendar/caldav")
  >("@/services/calendar/caldav")
  return {
    ...actual,
    testCaldavConnection: vi.fn(),
    discoverCaldavCalendars: vi.fn(),
    connectCaldavSource: vi.fn(),
  }
})

vi.mock("@/services/calendar/connect-microsoft", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/calendar/connect-microsoft")
  >("@/services/calendar/connect-microsoft")
  return {
    ...actual,
    connectMicrosoftCalendar: vi.fn(),
  }
})

const testConnectionMock = vi.mocked(testCaldavConnection)
const discoverMock = vi.mocked(discoverCaldavCalendars)
const connectMock = vi.mocked(connectCaldavSource)
const connectMicrosoftMock = vi.mocked(connectMicrosoftCalendar)

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
  setDefaultKeyStore(createInMemoryKeyStore())
})

afterEach(() => {
  cleanup()
  setDefaultKeyStore(null)
  executorHolder.current = null
  executor.close()
  useAccountStore.setState({ accounts: [], activeAccountId: null, loaded: false })
  vi.clearAllMocks()
})

async function seedSource(
  name: string,
  provider: "google" | "caldav" | "microsoft"
) {
  await addCalendarSource(executor, {
    id: `src-${name}`,
    accountId: null,
    provider,
    name,
    configJson: "sealed-ciphertext",
  })
}

/** Put one Microsoft account (optionally others) into the account store —
 * the Outlook connect block gates on this. */
function setAccounts(
  accounts: {
    id: string
    type: "gmail" | "imap" | "microsoft"
    email: string
  }[]
) {
  useAccountStore.setState({
    accounts: accounts.map((account) => ({
      ...account,
      displayName: null,
      status: "active" as const,
      unreadCount: 0,
    })),
    activeAccountId: accounts[0]?.id ?? null,
    loaded: true,
  })
}

async function fillForm() {
  fireEvent.change(screen.getByLabelText("Server URL"), {
    target: { value: "https://dav.example.com/" },
  })
  fireEvent.change(screen.getByLabelText("Username"), {
    target: { value: "jane" },
  })
  fireEvent.change(screen.getByLabelText("App password"), {
    target: { value: "app-pass-1" },
  })
}

describe("CalendarSection", () => {
  it("renders the connect form and the connected sources with a provider badge", async () => {
    await seedSource("Fastmail", "caldav")
    await seedSource("me@gmail.com", "google")
    render(<CalendarSection />)

    expect(await screen.findByText("Fastmail")).toBeTruthy()
    expect(screen.queryByText("No calendar sources connected yet.")).toBeNull()
    expect(screen.getByText("CalDAV")).toBeTruthy()
    expect(screen.getByText("me@gmail.com")).toBeTruthy()
    expect(screen.getByText("Google")).toBeTruthy()

    expect(screen.getByLabelText("Server URL")).toBeTruthy()
    expect(screen.getByLabelText("Username")).toBeTruthy()
    expect(screen.getByLabelText("App password")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Test connection" })
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Discover calendars" })
    ).toBeTruthy()
  })

  it("shows the specific failure when the connection test fails", async () => {
    render(<CalendarSection />)
    await fillForm()

    testConnectionMock.mockRejectedValueOnce(
      new (await import("@/services/calendar/caldav")).CaldavProviderError(
        "status",
        "the server rejected the username or app password (HTTP 401)",
        401
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }))

    await waitFor(() => {
      expect(
        screen.getByText(
          "the server rejected the username or app password (HTTP 401)"
        )
      ).toBeTruthy()
    })
    // ...and a success replaces it.
    testConnectionMock.mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }))
    await waitFor(() => {
      expect(screen.getByText("Connection test succeeded.")).toBeTruthy()
    })
  })

  it("renders discovered calendars as show/hide checkboxes and connects with the selection", async () => {
    render(<CalendarSection />)
    await fillForm()

    discoverMock.mockResolvedValueOnce([
      { href: "https://dav.example.com/home/", displayName: "Home" },
      { href: "https://dav.example.com/work/", displayName: "Work" },
    ])
    fireEvent.click(screen.getByRole("button", { name: "Discover calendars" }))

    // Both calendars render as show/hide checkboxes, all pre-selected.
    // (Base UI renders role=checkbox spans — aria-checked, not .checked.)
    const home = await screen.findByRole("checkbox", { name: "Home" })
    const work = screen.getByRole("checkbox", { name: "Work" })
    expect(home.getAttribute("aria-checked")).toBe("true")
    expect(work.getAttribute("aria-checked")).toBe("true")

    // Hide "Work", then connect: only the kept calendar is persisted.
    fireEvent.click(work)
    expect(work.getAttribute("aria-checked")).toBe("false")

    connectMock.mockImplementationOnce(
      async (inputExecutor, input) => {
        await addCalendarSource(inputExecutor, {
          id: "src-new",
          accountId: null,
          provider: "caldav",
          name: input.username,
          configJson: "sealed",
        })
        expect(input.calendars.map((calendar) => calendar.href)).toEqual([
          "https://dav.example.com/home/",
        ])
        return {
          id: "src-new",
          accountId: null,
          provider: "caldav",
          name: input.username,
          configJson: "sealed",
          syncState: {},
          createdAt: 0,
        }
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    // The new source appears in the refreshed list; the form resets.
    await waitFor(() => {
      expect(screen.getByText("jane")).toBeTruthy()
    })
    expect(screen.queryByRole("checkbox", { name: "Home" })).toBeNull()
  })

  it("requires a selection before connecting", async () => {
    render(<CalendarSection />)
    await fillForm()
    discoverMock.mockResolvedValueOnce([
      { href: "https://dav.example.com/home/", displayName: "Home" },
    ])
    fireEvent.click(screen.getByRole("button", { name: "Discover calendars" }))
    const home = await screen.findByRole("checkbox", { name: "Home" })
    fireEvent.click(home) // deselect the only calendar

    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(
      await screen.findByText("Select at least one calendar to show.")
    ).toBeTruthy()
    expect(connectMock).not.toHaveBeenCalled()
  })

  it("removes a source through the real service (events cascade)", async () => {
    await seedSource("Fastmail", "caldav")
    render(<CalendarSection />)
    expect(await screen.findByText("Fastmail")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Remove Fastmail" }))
    await waitFor(() => {
      expect(
        screen.getByText("No calendar sources connected yet.")
      ).toBeTruthy()
    })
    const rows = await executor.select<{ id: string }>(
      "SELECT id FROM calendar_sources"
    )
    expect(rows).toHaveLength(0)
  })
})

describe("CalendarSection — Microsoft Graph source flow (task 3.6)", () => {
  it("hides the Outlook connect block entirely when no Microsoft account exists", async () => {
    setAccounts([
      { id: "acc-g", type: "gmail", email: "me@gmail.com" },
      { id: "acc-i", type: "imap", email: "me@fastmail.com" },
    ])
    render(<CalendarSection />)

    // The source LIST still renders (existing sources unaffected), but the
    // Graph source type is not offered (spec "No Microsoft account").
    expect(await screen.findByText("Connect a CalDAV server")).toBeTruthy()
    expect(screen.queryByText("Connect an Outlook calendar")).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Add Outlook calendar" })
    ).toBeNull()
    expect(connectMicrosoftMock).not.toHaveBeenCalled()
  })

  it("renders a microsoft source with the Outlook badge in the source list", async () => {
    setAccounts([
      { id: "acc-ms", type: "microsoft", email: "me@outlook.com" },
    ])
    await seedSource("me@outlook.com", "microsoft")
    render(<CalendarSection />)

    expect(await screen.findByText("me@outlook.com")).toBeTruthy()
    expect(screen.getByText("Outlook")).toBeTruthy()
    expect(screen.getByText("Not synced yet")).toBeTruthy()
  })

  it("connects through the calendar-scope flow and refreshes the source list", async () => {
    setAccounts([
      { id: "acc-ms", type: "microsoft", email: "me@outlook.com" },
    ])
    connectMicrosoftMock.mockImplementationOnce(async (input) => {
      expect(input.accountId).toBe("acc-ms")
      // accountId null: the store-only account has no accounts row in this
      // executor (the FK would reject), and the assertion above already
      // pins what the flow received.
      await addCalendarSource(executor, {
        id: "src-outlook",
        accountId: null,
        provider: "microsoft",
        name: "me@outlook.com",
        configJson: "sealed",
      })
      return {
        sourceId: "src-outlook",
        accountId: input.accountId,
        calendars: [],
      }
    })
    render(<CalendarSection />)

    // The block (with its why-a-second-consent help text) is offered.
    expect(
      await screen.findByRole("button", { name: "Add Outlook calendar" })
    ).toBeTruthy()
    expect(
      screen.getByText(/refresh tokens are bound to the permissions/i)
    ).toBeTruthy()

    fireEvent.click(
      screen.getByRole("button", { name: "Add Outlook calendar" })
    )

    // The new source appears in the refreshed list with its badge.
    await waitFor(() => {
      expect(
        vi.mocked(connectMicrosoftCalendar).mock.calls.length
      ).toBeGreaterThan(0)
    })
    await waitFor(() => {
      expect(screen.getAllByText("me@outlook.com").length).toBeGreaterThan(0)
    })
    expect(screen.getByText("Outlook")).toBeTruthy()
    // The flow completed quietly: no error banner, button back to idle.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Add Outlook calendar" })
      ).toBeTruthy()
    })
    expect(screen.queryByRole("alert")).toBeNull()
    const rows = await executor.select<{ provider: string }>(
      "SELECT provider FROM calendar_sources"
    )
    expect(rows).toEqual([{ provider: "microsoft" }])
  })

  it("surfaces a consent denial with its specific message", async () => {
    setAccounts([
      { id: "acc-ms", type: "microsoft", email: "me@outlook.com" },
    ])
    connectMicrosoftMock.mockRejectedValueOnce(
      new MicrosoftCalendarConsentDeniedError(
        "Microsoft reported “access_denied”: Consent was denied",
        { microsoftError: "access_denied" }
      )
    )
    render(<CalendarSection />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Add Outlook calendar" })
    )

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("access_denied")
    // Nothing was persisted.
    const rows = await executor.select<{ id: string }>(
      "SELECT id FROM calendar_sources"
    )
    expect(rows).toEqual([])
  })

  it("treats a cancelled consent as a quiet no-op", async () => {
    setAccounts([
      { id: "acc-ms", type: "microsoft", email: "me@outlook.com" },
    ])
    connectMicrosoftMock.mockRejectedValueOnce(
      new MicrosoftCalendarConnectCancelledError()
    )
    render(<CalendarSection />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Add Outlook calendar" })
    )

    // The button returns to idle and NO error banner ever appears.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Add Outlook calendar" })
      ).toBeTruthy()
    })
    expect(screen.queryByRole("alert")).toBeNull()
    expect(connectMicrosoftMock).toHaveBeenCalledTimes(1)
  })
})
