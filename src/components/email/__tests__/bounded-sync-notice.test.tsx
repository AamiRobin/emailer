import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { setThreadListStoreExecutor } from "@/stores/thread-list-store"
import {
  isBoundedNoticeDismissed,
  markBoundedFirstSync,
} from "@/services/sync/history-window"
import { BoundedSyncNotice } from "../bounded-sync-notice"

/**
 * The bounded-first-sync indicator (parity-round-3 task 3.4, mail-sync
 * spec "Bounded first sync"): shown at the top of a single-account
 * mailbox only while that account HAS a window, its driver recorded the
 * bounded first sync, and the user has not dismissed it; dismissal
 * persists per account.
 */

describe("BoundedSyncNotice", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    setThreadListStoreExecutor(executor)
    accountId = "acc-bounded"
    await executor.execute(
      "INSERT INTO accounts (id, type, email, status, history_window) VALUES ($1, $2, $3, $4, $5)",
      [accountId, "gmail", "bounded@example.com", "active", "3m"]
    )
  })

  afterEach(() => {
    cleanup()
    setThreadListStoreExecutor(null)
    executor.close()
  })

  it("stays hidden until the account's driver recorded a bounded first sync", async () => {
    const { container } = render(<BoundedSyncNotice accountId={accountId} />)
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="bounded-sync-notice"]')
      ).toBeNull()
    )
  })

  it("shows the skipped-older-mail line for a completed bounded first sync", async () => {
    await markBoundedFirstSync(executor, accountId)

    render(<BoundedSyncNotice accountId={accountId} />)

    const notice = await screen.findByTestId("bounded-sync-notice")
    expect(notice.textContent).toContain("Last 3 months")
    expect(notice.textContent).toContain("older mail is still on the server")
  })

  it("dismissal persists per account and the notice stays gone on re-render", async () => {
    await markBoundedFirstSync(executor, accountId)
    const other = "acc-bounded-2"
    await executor.execute(
      "INSERT INTO accounts (id, type, email, status, history_window) VALUES ($1, $2, $3, $4, $5)",
      [other, "imap", "other@example.com", "active", "1y"]
    )
    await markBoundedFirstSync(executor, other)

    const { unmount } = render(<BoundedSyncNotice accountId={accountId} />)
    fireEvent.click(await screen.findByTestId("bounded-sync-notice-dismiss"))
    expect(await isBoundedNoticeDismissed(executor, accountId)).toBe(true)
    unmount()

    // This account's dismissal survived the remount...
    render(<BoundedSyncNotice accountId={accountId} />)
    await waitFor(() =>
      expect(screen.queryByTestId("bounded-sync-notice")).toBeNull()
    )
    // ...and the other account's notice is unaffected (per-account flags).
    render(<BoundedSyncNotice accountId={other} />)
    expect(await screen.findByTestId("bounded-sync-notice")).not.toBeNull()
  })

  it("renders nothing for cross-account scopes (accountId null)", () => {
    const { container } = render(<BoundedSyncNotice accountId={null} />)
    expect(
      container.querySelector('[data-testid="bounded-sync-notice"]')
    ).toBeNull()
  })
})
