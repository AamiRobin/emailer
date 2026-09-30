import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

/**
 * Translate control tests (add-ai-surfaces task 5.1, ai-assistance spec
 * "Per-message translation"). The gate seams (isAiConfigured /
 * isSurfaceEnabled) and the translation service are mocked at their
 * module seams — the assertions target the frozen UI flow (gated
 * rendering, the toggle, the inline provider-error path and the
 * mid-session hide); the service-side cache and the untrusted-text
 * fencing are the service's own concern (covered in
 * services/ai/__tests__). The executor module is mocked to hand back a
 * seeded node:sqlite executor (same seam as the sibling suites), so
 * getExecutor() resolves and the seeded MessageRow is a real row.
 */

const translateMessageMock = vi.hoisted(() => vi.fn())
const isAiConfiguredMock = vi.hoisted(() => vi.fn())
const isSurfaceEnabledMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/ai/translation", () => ({
  translateMessage: translateMessageMock,
}))

// Spread the real settings module (client.ts re-exports read from it);
// only the two gate reads are overridden per test.
vi.mock("@/services/ai/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/ai/settings")>()),
  isAiConfigured: isAiConfiguredMock,
  isSurfaceEnabled: isSurfaceEnabledMock,
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

// The REAL error classes (shared identity with the component's
// instanceof checks) — client.ts is import-safe in jsdom.
import { AiProviderError, AiUnavailableError } from "@/services/ai/client"
import { createMessage, createThread } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import type { MessageRow } from "@/services/db/messages"
import { TranslateControl } from "../translate-control"

let executor: TestExecutor
let message: MessageRow

/** Seed one account/thread/message and return the full row. */
async function seedMessage(bodyText: string): Promise<MessageRow> {
  const accountId = "acc-1"
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [accountId, "gmail", "me@example.com"]
  )
  const threadId = await createThread(executor, accountId, {
    subject: "Kickoff",
  })
  const messageId = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000,
    fromName: "Grace Hopper",
    fromAddress: "grace@example.com",
    bodyText,
    isRead: true,
  })
  const rows = await executor.select<MessageRow>(
    "SELECT * FROM messages WHERE id = $1",
    [messageId]
  )
  if (!rows[0]) throw new Error("seeded message row missing")
  return rows[0]
}

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  isAiConfiguredMock.mockReset().mockResolvedValue(true)
  isSurfaceEnabledMock.mockReset().mockResolvedValue(true)
  translateMessageMock.mockReset()
  message = await seedMessage("Can we move the review to Thursday?")
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  executor.close()
})

function renderControl(props: { disabled?: boolean } = {}) {
  return render(<TranslateControl message={message} {...props} />)
}

describe("TranslateControl gating", () => {
  it("renders nothing when AI is not configured", async () => {
    isAiConfiguredMock.mockResolvedValue(false)
    const { container } = renderControl()

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="message-translate"]')).toBeNull()
    })
    expect(translateMessageMock).not.toHaveBeenCalled()
  })

  it("renders nothing when the translation surface is disabled", async () => {
    isSurfaceEnabledMock.mockResolvedValue(false)
    const { container } = renderControl()

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="message-translate"]')).toBeNull()
    })
    expect(translateMessageMock).not.toHaveBeenCalled()
  })

  it("stays hidden when the gate read itself fails (fail toward hidden)", async () => {
    isAiConfiguredMock.mockRejectedValue(new Error("no db"))
    const { container } = renderControl()

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="message-translate"]')).toBeNull()
    })
  })
})

describe("TranslateControl translation flow", () => {
  it("shows the button when configured, translates on click and renders the panel", async () => {
    translateMessageMock.mockResolvedValue({
      translation: "Pouvoir-nous déplacer la revue à jeudi ?",
      language: "French",
    })
    renderControl()

    const button = await screen.findByTestId("message-translate")
    // The gate check alone never calls the service.
    expect(translateMessageMock).not.toHaveBeenCalled()

    fireEvent.click(button)
    const panel = await screen.findByTestId("message-translation-panel")
    expect(panel.textContent).toContain(
      "Pouvoir-nous déplacer la revue à jeudi ?"
    )
    expect(panel.textContent).toContain("Translated to French")
    expect(translateMessageMock).toHaveBeenCalledWith(executor, message)
    // The toggle reads as expanded while the panel is open.
    expect(button.getAttribute("aria-expanded")).toBe("true")
  })

  it("goes back through the service on the second invocation (its cache serves the repeat)", async () => {
    translateMessageMock.mockResolvedValue({
      translation: "Können wir den Review auf Donnerstag verschieben?",
      language: "German",
    })
    renderControl()

    fireEvent.click(await screen.findByTestId("message-translate"))
    expect(await screen.findByTestId("message-translation-panel")).toBeTruthy()

    // First toggle closes the panel without a call…
    fireEvent.click(screen.getByTestId("message-translate"))
    expect(screen.queryByTestId("message-translation-panel")).toBeNull()
    expect(translateMessageMock).toHaveBeenCalledTimes(1)

    // …and the next invocation calls the service AGAIN — the unchanged
    // repeat would be served from the service-side ai_cache (no provider
    // call); the UI just calls through and shows the result.
    fireEvent.click(screen.getByTestId("message-translate"))
    expect(await screen.findByTestId("message-translation-panel")).toBeTruthy()
    expect(translateMessageMock).toHaveBeenCalledTimes(2)
    expect(translateMessageMock).toHaveBeenLastCalledWith(executor, message)
  })

  it("disables the button via the disabled prop like the thread chrome", async () => {
    renderControl({ disabled: true })

    const button = await screen.findByTestId("message-translate")
    expect(button.hasAttribute("disabled")).toBe(true)
    fireEvent.click(button)
    expect(translateMessageMock).not.toHaveBeenCalled()
  })
})

describe("TranslateControl failure handling", () => {
  it("renders a provider error inline with Retry and no panel; retry recovers", async () => {
    translateMessageMock
      .mockRejectedValueOnce(
        new AiProviderError("network", "the provider could not be reached")
      )
      .mockResolvedValueOnce({ translation: "Translated text.", language: null })
    renderControl()

    fireEvent.click(await screen.findByTestId("message-translate"))
    const error = await screen.findByTestId("message-translate-error")
    expect(error.textContent).toContain("the provider could not be reached")
    expect(screen.queryByTestId("message-translation-panel")).toBeNull()

    // Retry re-runs the same call and shows the panel (no language label
    // when none is configured).
    fireEvent.click(screen.getByTestId("message-translate-retry"))
    const panel = await screen.findByTestId("message-translation-panel")
    expect(panel.textContent).toContain("Translated text.")
    expect(panel.textContent).not.toContain("Translated to")
    expect(translateMessageMock).toHaveBeenCalledTimes(2)
  })

  it("hides itself entirely on a mid-session AiUnavailableError", async () => {
    translateMessageMock.mockRejectedValue(
      new AiUnavailableError("surface-disabled")
    )
    renderControl()

    fireEvent.click(await screen.findByTestId("message-translate"))
    await vi.waitFor(() => {
      expect(screen.queryByTestId("message-translate")).toBeNull()
    })
    expect(screen.queryByTestId("message-translate-error")).toBeNull()
    expect(screen.queryByTestId("message-translation-panel")).toBeNull()
  })
})
