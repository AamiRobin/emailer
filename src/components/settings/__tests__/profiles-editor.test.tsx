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
 * Profiles editor tests (parity-round-2 task 4.4, accounts spec "Account
 * profiles and colors"). Same executor-injection pattern as the settings
 * suites: the executor module is mocked to hand every consumer the shared
 * seeded node:sqlite executor, and the editor runs against the real
 * profiles CRUD — create/assign/override/delete assertions read back
 * through the same executor, and the account store's effectiveColor
 * (the marker seam) is checked to follow the edits.
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

import { accountHue } from "@/components/email/account-hue"
import {
  assignAccountToProfile,
  createProfile,
  setAccountColorOverride,
} from "@/services/db/account-profiles"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { ProfilesEditor } from "../profiles-editor"

let executor: TestExecutor
let idSequence = 0

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
  setAccountStoreExecutor(executor)
  idSequence = 0
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    effectiveColors: {},
    loaded: false,
  })
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  setAccountStoreExecutor(null)
  executor.close()
})

async function seedAccount(email: string): Promise<string> {
  idSequence += 1
  const id = `acc-${idSequence}`
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [id, "gmail", email]
  )
  return id
}

/** Seed accounts, then load the store (accounts + effective colors). */
async function seedAccountsAndInitStore(
  emails: string[]
): Promise<string[]> {
  const ids: string[] = []
  for (const email of emails) ids.push(await seedAccount(email))
  await useAccountStore.getState().init()
  return ids
}

async function profileRow(name: string): Promise<{
  id: string
  name: string
  color: string
}> {
  const rows = await executor.select<{
    id: string
    name: string
    color: string
  }>("SELECT id, name, color FROM account_profiles WHERE name = $1", [name])
  return rows[0]
}

describe("ProfilesEditor", () => {
  it("shows the empty state when no profiles exist", async () => {
    await seedAccountsAndInitStore(["one@example.com"])
    render(<ProfilesEditor />)

    expect(await screen.findByText(/No profiles yet/)).toBeTruthy()
    expect(screen.queryByTestId("settings-profile-row")).toBeNull()
  })

  it("creates a profile with a chosen color and assigns an account", async () => {
    const [accountA] = await seedAccountsAndInitStore([
      "alpha@example.com",
      "beta@example.com",
    ])
    render(<ProfilesEditor />)

    fireEvent.click(await screen.findByTestId("add-profile-button"))
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Work" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Profile color: Purple" }))
    fireEvent.click(
      screen.getByRole("checkbox", { name: "alpha@example.com" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Create Profile" }))

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull()
    )
    // The row landed with the chosen color and member list.
    const row = await screen.findByTestId("settings-profile-row")
    expect(row.getAttribute("data-profile-name")).toBe("Work")
    expect(screen.getByText("Work")).toBeTruthy()
    expect(screen.getByText("alpha@example.com")).toBeTruthy()
    // …the DB holds the assignment…
    const stored = await executor.select<{
      profile_id: string | null
      color_override: string | null
    }>("SELECT profile_id, color_override FROM accounts WHERE id = $1", [
      accountA,
    ])
    const work = await profileRow("Work")
    expect(work.color).toBe("#8b5cf6")
    expect(stored[0]).toEqual({ profile_id: work.id, color_override: null })
    // …and the unassigned sibling is untouched.
    const accounts = await executor.select<{ profile_id: string | null }>(
      "SELECT profile_id FROM accounts ORDER BY id ASC"
    )
    expect(accounts).toHaveLength(2)
    expect(accounts.filter((entry) => entry.profile_id !== null)).toHaveLength(
      1
    )
    // The marker seam (effectiveColor) followed the edit.
    expect(useAccountStore.getState().effectiveColor(accountA)).toBe("#8b5cf6")
  })

  it("renames and re-colors an existing profile", async () => {
    const [accountA] = await seedAccountsAndInitStore(["alpha@example.com"])
    const work = await createProfile(executor, {
      name: "Work",
      color: "#8b5cf6",
    })
    await assignAccountToProfile(executor, accountA, work.id)
    await useAccountStore.getState().refreshProfileColors()

    render(<ProfilesEditor />)
    fireEvent.click(await screen.findByRole("button", { name: "Edit Work" }))
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Day job" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Profile color: Green" }))
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull()
    )
    const stored = await executor.select<{ name: string; color: string }>(
      "SELECT name, color FROM account_profiles WHERE id = $1",
      [work.id]
    )
    expect(stored[0]).toEqual({ name: "Day job", color: "#22c55e" })
    expect(useAccountStore.getState().effectiveColor(accountA)).toBe(
      "#22c55e"
    )
  })

  it("sets a per-account marker override while editing", async () => {
    const [accountA] = await seedAccountsAndInitStore(["alpha@example.com"])
    const work = await createProfile(executor, {
      name: "Work",
      color: "#8b5cf6",
    })
    await assignAccountToProfile(executor, accountA, work.id)
    await useAccountStore.getState().refreshProfileColors()

    render(<ProfilesEditor />)
    fireEvent.click(await screen.findByRole("button", { name: "Edit Work" }))
    // The member account exposes its marker palette: inherit (profile
    // color) is pressed by default…
    expect(
      screen
        .getByRole("button", {
          name: "alpha@example.com marker: profile color",
        })
        .getAttribute("aria-pressed")
    ).toBe("true")
    // …pick orange as the override.
    fireEvent.click(
      screen.getByRole("button", { name: "alpha@example.com marker: Orange" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull()
    )
    const stored = await executor.select<{
      profile_id: string | null
      color_override: string | null
    }>("SELECT profile_id, color_override FROM accounts WHERE id = $1", [
      accountA,
    ])
    expect(stored[0]).toEqual({ profile_id: work.id, color_override: "#f97316" })
    // Override wins in the effective-color chain.
    expect(useAccountStore.getState().effectiveColor(accountA)).toBe(
      "#f97316"
    )
  })

  it("unassigns an account on save", async () => {
    const [accountA] = await seedAccountsAndInitStore(["alpha@example.com"])
    const work = await createProfile(executor, {
      name: "Work",
      color: "#8b5cf6",
    })
    await assignAccountToProfile(executor, accountA, work.id)
    await useAccountStore.getState().refreshProfileColors()

    render(<ProfilesEditor />)
    fireEvent.click(await screen.findByRole("button", { name: "Edit Work" }))
    const checkbox = screen.getByRole("checkbox", {
      name: "alpha@example.com",
    })
    expect(checkbox.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }))

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull()
    )
    const stored = await executor.select<{ profile_id: string | null }>(
      "SELECT profile_id FROM accounts WHERE id = $1",
      [accountA]
    )
    expect(stored[0]?.profile_id).toBeNull()
    // Back to the generated hue.
    expect(useAccountStore.getState().effectiveColor(accountA)).toBe(
      `hsl(${accountHue(accountA)} 55% 50%)`
    )
    expect(screen.getByText("No accounts")).toBeTruthy()
  })

  it("deleting a profile keeps its accounts working with their colors", async () => {
    const [accountA, accountB] = await seedAccountsAndInitStore([
      "alpha@example.com",
      "beta@example.com",
    ])
    const work = await createProfile(executor, {
      name: "Work",
      color: "#8b5cf6",
    })
    await assignAccountToProfile(executor, accountA, work.id)
    await assignAccountToProfile(executor, accountB, work.id)
    // The override is the account's individual color — survives deletion.
    await setAccountColorOverride(executor, accountA, "#f97316")
    await useAccountStore.getState().refreshProfileColors()

    render(<ProfilesEditor />)
    fireEvent.click(await screen.findByRole("button", { name: "Delete Work" }))
    // The destructive confirm names the profile and the keep-accounts
    // semantics before running.
    fireEvent.click(await screen.findByRole("button", { name: "Delete profile" }))

    await waitFor(() =>
      expect(screen.queryByTestId("settings-profile-row")).toBeNull()
    )
    expect(screen.getByText(/No profiles yet/)).toBeTruthy()

    // Both accounts survive, references cleared…
    const accounts = await executor.select<{
      id: string
      profile_id: string | null
    }>("SELECT id, profile_id FROM accounts ORDER BY id ASC")
    expect(accounts).toEqual([
      { id: accountA, profile_id: null },
      { id: accountB, profile_id: null },
    ])
    // …the profile row is gone…
    expect(await profileRow("Work")).toBeUndefined()
    // …and the effective colors fell back: the individual override for A,
    // the generated hue for B — the spec's delete-keeps-accounts scenario.
    expect(useAccountStore.getState().effectiveColor(accountA)).toBe(
      "#f97316"
    )
    expect(useAccountStore.getState().effectiveColor(accountB)).toBe(
      `hsl(${accountHue(accountB)} 55% 50%)`
    )
    // The store still lists both accounts (they keep working).
    expect(useAccountStore.getState().accounts).toHaveLength(2)
  })
})
