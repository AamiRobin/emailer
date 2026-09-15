import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import type { ReactElement } from "react"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Settings page tests (tasks 11.1–11.3). Same executor-injection pattern
 * as the mail-shell suites: the executor module is mocked to hand every
 * consumer a seeded node:sqlite executor. The account dialogs are stubbed
 * (their behavior has its own suites in components/accounts/__tests__) —
 * the accounts section only needs to open the right one. next-themes is
 * represented by a useTheme stub (theme mode via setTheme spy); the real
 * settings table, the accent module and the ui-store run for real.
 */

const executorHolder = vi.hoisted(() => ({
  current: null as SqlExecutor | null,
}))

const themeHolder = vi.hoisted(() => ({
  theme: "system",
  setTheme: vi.fn(),
}))

const notifierHolder = vi.hoisted(() => ({
  setNotificationsEnabled: vi.fn(async () => {}),
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

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({
    theme: themeHolder.theme,
    setTheme: themeHolder.setTheme,
  }),
}))

vi.mock("@/services/notifications/new-mail-notifier", () => ({
  setNotificationsEnabled: notifierHolder.setNotificationsEnabled,
}))

vi.mock("@/components/accounts/add-account-dialog", () => ({
  AddAccountDialog: (props: { open: boolean }): ReactElement | null =>
    props.open ? <div data-testid="add-account-dialog" /> : null,
}))

vi.mock("@/components/accounts/remove-account-dialog", () => ({
  RemoveAccountDialog: (props: {
    account: { email: string } | null
    open: boolean
  }): ReactElement | null =>
    props.open && props.account ? (
      <div data-testid="remove-account-dialog">
        remove:{props.account.email}
      </div>
    ) : null,
}))

vi.mock("@/components/accounts/reauth-dialog", () => ({
  ReauthDialog: (props: {
    account: { email: string } | null
    open: boolean
  }): ReactElement | null =>
    props.open && props.account ? (
      <div data-testid="reauth-dialog">reauth:{props.account.email}</div>
    ) : null,
}))

import {
  getAccentPreference,
  getDensity,
  getFontScale,
  getReadingPanePreference,
  getThemeModePreference,
} from "@/services/settings/preferences"
import { setSetting } from "@/services/db/settings"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import type { AccountInfo } from "@/stores/account-store"
import { useAccountStore } from "@/stores/account-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { SettingsPage } from "../settings-page"

function resetDocument(): void {
  document.documentElement.removeAttribute("data-accent")
  document.documentElement.style.removeProperty("--density")
  document.documentElement.style.removeProperty("--font-scale")
}

let executor: TestExecutor

function resetStores(): void {
  localStorage.clear()
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
    previousView: DEFAULT_VIEW,
  })
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: true,
  })
}

function seedAccount(account: Partial<AccountInfo> & { id: string }): void {
  const accounts = useAccountStore.getState().accounts
  useAccountStore.setState({
    accounts: [
      ...accounts,
      {
        type: "gmail",
        email: `${account.id}@example.com`,
        displayName: null,
        status: "active",
        unreadCount: 0,
        lastSyncAt: null,
        ...account,
      },
    ],
  })
}

function openSelect(name: string): void {
  fireEvent.click(screen.getByRole("combobox", { name }))
}

/** Base UI Select ignores synthetic clicks that did not start with a
 * pointerdown on the item (drag-select guard), so send both. */
function chooseOption(option: HTMLElement): void {
  fireEvent.pointerDown(option)
  fireEvent.click(option)
}

beforeAll(() => {
  // jsdom lacks ResizeObserver (base-ui ScrollArea observes size) and
  // Element.getAnimations (base-ui ScrollAreaViewport checks running
  // animations) — stub both.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver ??=
    ResizeObserverStub as unknown as typeof ResizeObserver
  const elementProto = Element.prototype as unknown as {
    getAnimations?: () => unknown[]
  }
  elementProto.getAnimations ??= () => []
})

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
  themeHolder.theme = "system"
  themeHolder.setTheme.mockClear()
  notifierHolder.setNotificationsEnabled.mockClear()
  resetDocument()
  resetStores()
})

afterEach(() => {
  cleanup()
  resetDocument()
  resetStores()
  executorHolder.current = null
  executor.close()
})

describe("settings page navigation", () => {
  it("renders the four sections in the nav and switches between them", () => {
    render(<SettingsPage />)

    const nav = screen.getByRole("navigation", {
      name: "Settings sections",
    })
    for (const label of ["Accounts", "Appearance", "Reading", "Shortcuts"]) {
      expect(nav.textContent).toContain(label)
    }

    // Accounts is the landing section; the others appear on click.
    expect(screen.getByRole("heading", { name: "Accounts" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Appearance" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }))
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Accounts" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Reading" }))
    expect(screen.getByRole("heading", { name: "Reading" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Shortcuts" }))
    expect(screen.getByRole("heading", { name: "Shortcuts" })).toBeTruthy()
  })

  it("the back control restores the mailbox view from previousView", () => {
    const starred = { kind: "folder", folder: { kind: "starred" } } as const
    useUiStore.setState({ view: { kind: "settings" }, previousView: starred })

    render(<SettingsPage />)
    fireEvent.click(screen.getByRole("button", { name: "Back to mailbox" }))

    expect(useUiStore.getState().view).toEqual(starred)
  })
})

describe("accounts section", () => {
  it("lists accounts with type, status and unread, and opens the shared dialogs", () => {
    seedAccount({
      id: "acc-1",
      email: "one@example.com",
      type: "gmail",
      unreadCount: 3,
    })
    seedAccount({
      id: "acc-2",
      email: "two@example.com",
      type: "imap",
      status: "auth-error",
    })

    render(<SettingsPage />)

    expect(screen.getByText("one@example.com")).toBeTruthy()
    expect(screen.getByText("two@example.com")).toBeTruthy()
    expect(screen.getByText("Gmail")).toBeTruthy()
    expect(screen.getByText("IMAP")).toBeTruthy()
    expect(screen.getByText("Sign-in error")).toBeTruthy()
    expect(screen.getByText("3 unread")).toBeTruthy()

    // Re-authenticate is offered only for the auth-error account.
    const reauthButtons = screen.getAllByRole("button", {
      name: "Re-authenticate",
    })
    expect(reauthButtons).toHaveLength(1)
    fireEvent.click(reauthButtons[0] as HTMLElement)
    expect(screen.getByTestId("reauth-dialog").textContent).toBe(
      "reauth:two@example.com"
    )

    // Every account row has Remove; opening it targets that account.
    const removeButtons = screen.getAllByRole("button", { name: "Remove" })
    expect(removeButtons).toHaveLength(2)
    fireEvent.click(removeButtons[1] as HTMLElement)
    expect(screen.getByTestId("remove-account-dialog").textContent).toBe(
      "remove:two@example.com"
    )

    // Add Account opens the shared chooser.
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }))
    expect(screen.getByTestId("add-account-dialog")).toBeTruthy()
  })

  it("shows the empty state when no accounts exist", () => {
    render(<SettingsPage />)
    expect(screen.getByText(/No accounts yet/)).toBeTruthy()
  })
})

describe("appearance section", () => {
  function openAppearance(): void {
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }))
  }

  it("switching the accent applies data-accent and mirrors to the settings table", async () => {
    render(<SettingsPage />)
    openAppearance()

    fireEvent.click(screen.getByRole("button", { name: "Accent: Blue" }))

    expect(document.documentElement.getAttribute("data-accent")).toBe("blue")
    expect(
      screen
        .getByRole("button", { name: "Accent: Blue" })
        .getAttribute("aria-pressed")
    ).toBe("true")
    await waitFor(async () => {
      expect(await getAccentPreference(executor)).toBe("blue")
    })
  })

  it("density presets apply the --density token and persist", async () => {
    render(<SettingsPage />)
    openAppearance()

    fireEvent.click(screen.getByRole("button", { name: "Compact" }))

    // The token applies after the persistence write settles.
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--density")).toBe(
        "0.85"
      )
    })
    expect(
      screen
        .getByRole("button", { name: "Compact" })
        .getAttribute("aria-pressed")
    ).toBe("true")
    expect(await getDensity(executor)).toBe("compact")
  })

  it("theme mode goes through next-themes setTheme and mirrors to the table", async () => {
    render(<SettingsPage />)
    openAppearance()

    openSelect("Theme mode")
    chooseOption(await screen.findByRole("option", { name: "Dark" }))

    expect(themeHolder.setTheme).toHaveBeenCalledWith("dark")
    await waitFor(async () => {
      expect(await getThemeModePreference(executor)).toBe("dark")
    })
  })

  it("font scale applies the --font-scale token and persists", async () => {
    render(<SettingsPage />)
    openAppearance()

    openSelect("Font size")
    chooseOption(await screen.findByRole("option", { name: "125%" }))

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue("--font-scale")
      ).toBe("1.25")
    })
    expect(await getFontScale(executor)).toBe(1.25)
  })
})

describe("reading section", () => {
  function openReading(): void {
    fireEvent.click(screen.getByRole("button", { name: "Reading" }))
  }

  it("changing the pane position updates the ui-store and persists", async () => {
    render(<SettingsPage />)
    openReading()

    openSelect("Reading pane")
    chooseOption(await screen.findByRole("option", { name: "Bottom" }))

    // The store update lands after the settings-table write settles.
    await waitFor(() => {
      expect(useUiStore.getState().readingPane).toBe("bottom")
    })
    expect(await getReadingPanePreference(executor)).toBe("bottom")
  })

  it("the notifications switch flips through the notifier (live + persist)", async () => {
    // Start from the persisted OFF state: the section must reflect the DB.
    await setSetting(executor, "notifications.enabled", false)

    render(<SettingsPage />)
    openReading()

    // The initial value loads asynchronously from the settings table.
    const toggle = await screen.findByRole("switch", {
      name: "New-mail notifications",
    })
    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "New-mail notifications" })
          .getAttribute("aria-checked")
      ).toBe("false")
    })

    fireEvent.click(toggle)

    expect(notifierHolder.setNotificationsEnabled).toHaveBeenCalledWith(true)
    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "New-mail notifications" })
          .getAttribute("aria-checked")
      ).toBe("true")
    })
  })
})

describe("shortcuts section", () => {
  function openShortcuts(): void {
    fireEvent.click(screen.getByRole("button", { name: "Shortcuts" }))
  }

  it("shows every binding grouped when the filter is empty", () => {
    render(<SettingsPage />)
    openShortcuts()

    // All five groups from the fixed table render.
    for (const group of [
      "shortcuts-group-navigation",
      "shortcuts-group-actions",
      "shortcuts-group-compose",
      "shortcuts-group-search",
      "shortcuts-group-general",
    ]) {
      expect(screen.getByTestId(group)).toBeTruthy()
    }
    expect(screen.getByTestId("shortcut-next-thread")).toBeTruthy()
    expect(screen.getByTestId("shortcut-toggle-star")).toBeTruthy()
  })

  it("filters case-insensitively by description and keys", () => {
    render(<SettingsPage />)
    openShortcuts()

    const filter = screen.getByRole("textbox", { name: "Filter shortcuts" })
    fireEvent.change(filter, { target: { value: "STAR" } })
    expect(screen.getByTestId("shortcut-toggle-star")).toBeTruthy()
    expect(screen.queryByTestId("shortcut-next-thread")).toBeNull()

    // Keys match too ("Shift+R" → the refresh binding).
    fireEvent.change(filter, { target: { value: "shift+r" } })
    expect(screen.getByTestId("shortcut-refresh")).toBeTruthy()
    expect(screen.queryByTestId("shortcut-toggle-star")).toBeNull()
  })

  it("shows an empty state when nothing matches", () => {
    render(<SettingsPage />)
    openShortcuts()

    const filter = screen.getByRole("textbox", { name: "Filter shortcuts" })
    fireEvent.change(filter, { target: { value: "no such binding" } })

    expect(screen.getByText("No matching shortcuts")).toBeTruthy()
    expect(screen.queryByTestId("shortcuts-group-navigation")).toBeNull()
  })
})
