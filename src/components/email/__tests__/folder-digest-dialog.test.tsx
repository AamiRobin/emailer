import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

/**
 * Folder-digest dialog tests (task 7.1, ai-assistance spec "Folder unread
 * digest"). The digest service is mocked at its module seam (the
 * assertions target the frozen UI contract — the briefing renders as
 * bullets plus the Overview line with the coverage meta, the loading
 * state shows while the build is in flight, a null result renders the
 * empty state, provider errors render inline with a Retry that re-calls
 * the service, and an AiUnavailableError closes the dialog and renders
 * nothing, the hide contract). The dialog's behavior against the REAL
 * service (cache, scope boundary) is covered by the service's own suite;
 * the thread-list tests cover the affordance's gates.
 */

const buildFolderDigestMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/ai/folder-digest", () => ({
  buildFolderDigest: buildFolderDigestMock,
}))

const executorHolder = vi.hoisted(() => ({
  current: null as unknown,
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

import { AiProviderError, AiUnavailableError } from "@/services/ai/client"
import { FolderDigestDialog } from "../folder-digest-dialog"
import type { DigestScope } from "@/services/ai/folder-digest"

const SCOPE: DigestScope = {
  kind: "accountFolder",
  accountId: "acc-1",
  folder: { kind: "specialUse", specialUse: "inbox" },
}

/** The digest shape the service's prompt pins: bullets + Overview. */
const DIGEST = [
  "- Contract renewal — legal needs the signed copy by Friday.",
  "- Standup notes — two action items assigned to you.",
  "Overview: Two threads need your attention today.",
].join("\n")

function digestResult(overrides: {
  digest?: string
  threadCount?: number
  omittedCount?: number
}) {
  return {
    digest: overrides.digest ?? DIGEST,
    threadCount: overrides.threadCount ?? 2,
    omittedCount: overrides.omittedCount ?? 0,
  }
}

function renderDialog(props: {
  scope?: DigestScope
  onOpenChange?: (open: boolean) => void
} = {}) {
  return render(
    <FolderDigestDialog
      scope={props.scope ?? SCOPE}
      onOpenChange={props.onOpenChange ?? vi.fn()}
    />
  )
}

beforeEach(() => {
  executorHolder.current = { marker: "test-executor" }
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  vi.clearAllMocks()
})

describe("FolderDigestDialog briefing", () => {
  it("renders the digest as bullets plus the Overview line and the coverage meta", async () => {
    buildFolderDigestMock.mockResolvedValue(digestResult({}))
    renderDialog()

    expect(await screen.findByTestId("folder-digest-dialog")).toBeTruthy()
    const body = screen.getByTestId("folder-digest-body")
    // The two bullet lines render as list items, in order…
    const bullets = Array.from(body.querySelectorAll("li")).map(
      (item) => item.textContent
    )
    expect(bullets).toEqual([
      "Contract renewal — legal needs the signed copy by Friday.",
      "Standup notes — two action items assigned to you.",
    ])
    // …and the Overview line renders as plain text.
    expect(body.textContent).toContain(
      "Overview: Two threads need your attention today."
    )
    expect(screen.getByTestId("folder-digest-meta").textContent).toBe(
      "2 unread threads covered"
    )
    // The service ran with the executor and the scope it was handed.
    expect(buildFolderDigestMock).toHaveBeenCalledWith(
      executorHolder.current,
      { scope: SCOPE }
    )
  })

  it("appends the omitted tail to the meta line when the scope overflowed the cap", async () => {
    buildFolderDigestMock.mockResolvedValue(
      digestResult({ threadCount: 25, omittedCount: 7 })
    )
    renderDialog()

    expect(await screen.findByTestId("folder-digest-dialog")).toBeTruthy()
    expect(screen.getByTestId("folder-digest-meta").textContent).toBe(
      "25 unread threads covered, and 7 more not covered"
    )
  })

  it("singularizes the meta line for a single covered thread", async () => {
    buildFolderDigestMock.mockResolvedValue(
      digestResult({ threadCount: 1, omittedCount: 0 })
    )
    renderDialog()

    expect(await screen.findByTestId("folder-digest-dialog")).toBeTruthy()
    expect(screen.getByTestId("folder-digest-meta").textContent).toBe(
      "1 unread thread covered"
    )
  })

  it("shows the loading state while the digest build is in flight", async () => {
    buildFolderDigestMock.mockReturnValue(new Promise(() => {}))
    renderDialog()

    expect(screen.getByTestId("folder-digest-busy").textContent).toBe(
      "Catching you up…"
    )
    expect(screen.queryByTestId("folder-digest-body")).toBeNull()
  })
})

describe("FolderDigestDialog failure and empty paths", () => {
  it("renders provider errors inline and Retry re-calls the service", async () => {
    buildFolderDigestMock.mockRejectedValueOnce(
      new AiProviderError("network", "provider unreachable")
    )
    renderDialog()

    expect(await screen.findByTestId("folder-digest-error")).toBeTruthy()
    expect(screen.getByTestId("folder-digest-error").textContent).toContain(
      "provider unreachable"
    )

    buildFolderDigestMock.mockResolvedValueOnce(digestResult({}))
    fireEvent.click(screen.getByTestId("folder-digest-retry"))

    expect(await screen.findByTestId("folder-digest-body")).toBeTruthy()
    expect(buildFolderDigestMock).toHaveBeenCalledTimes(2)
  })

  it("closes and renders nothing on AiUnavailableError (the hide contract)", async () => {
    const onOpenChange = vi.fn()
    buildFolderDigestMock.mockRejectedValue(
      new AiUnavailableError("not-configured")
    )
    const { container } = renderDialog({ onOpenChange })

    // The affordance hides itself when the gate is closed, so an
    // unavailable throw means fail-toward-off: the parent is told to
    // close and the dialog renders nothing in the meantime.
    await vi.waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    expect(
      container.querySelector('[data-testid="folder-digest-dialog"]')
    ).toBeNull()
  })

  it("shows the empty state when the service short-circuits to null", async () => {
    // Zero unread raced (threads read elsewhere since the affordance's
    // rows loaded): the dialog answers "No unread threads." instead of
    // closing silently under the cursor.
    buildFolderDigestMock.mockResolvedValue(null)
    renderDialog()

    expect(await screen.findByTestId("folder-digest-empty")).toBeTruthy()
    expect(screen.getByTestId("folder-digest-empty").textContent).toBe(
      "No unread threads."
    )
    expect(screen.queryByTestId("folder-digest-body")).toBeNull()
  })
})
