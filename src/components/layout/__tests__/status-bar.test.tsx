import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { StatusBar } from "@/components/layout/status-bar"
import {
  initAccountStore,
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"

/**
 * The status bar runs the real stores against the node:sqlite test
 * executor; only the shell-mount wiring is skipped (the component is
 * rendered standalone).
 */

let executor: TestExecutor

async function seedActiveAccount(): Promise<string> {
  await executor.execute(
    `INSERT INTO accounts (id, type, email, display_name, status, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ["acc-1", "gmail", "amelia@example.com", null, "active", 1]
  )
  return "acc-1"
}

describe("status bar", () => {
  afterEach(() => {
    cleanup()
    useAccountStore.setState({
      accounts: [],
      activeAccountId: null,
      loaded: false,
    })
  })

  it("shows the sync indicator and the app version with an account", async () => {
    executor = createTestExecutor()
    setAccountStoreExecutor(executor)
    await seedActiveAccount()
    await initAccountStore()

    render(<StatusBar />)

    expect(screen.getByTestId("status-bar")).not.toBeNull()
    // The sync text renders for the active account (idle, never synced).
    expect(screen.getByText("Not synced yet")).not.toBeNull()
    // Version comes from the build-time __APP_VERSION__ define
    // (src-tauri/tauri.conf.json); assert the v-prefixed semver shape —
    // with an optional prerelease suffix on beta-channel versions
    // (v0.1.0-beta.1).
    expect(screen.getByText(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)).not.toBeNull()
  })

  it("hides the sync indicator without an active account", async () => {
    executor = createTestExecutor()
    setAccountStoreExecutor(executor)
    await initAccountStore()

    render(<StatusBar />)

    expect(screen.getByTestId("status-bar")).not.toBeNull()
    expect(screen.queryByText("Not synced yet")).toBeNull()
  })
})
