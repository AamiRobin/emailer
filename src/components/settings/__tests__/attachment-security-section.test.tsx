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
 * Attachment-security section tests (task 18.9): the global malware-
 * lookup toggle and API key round-trip through the real settings table
 * (node:sqlite via the mocked executor module — the same seam as the
 * settings-page suite).
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

import {
  getMalwareLookupApiKey,
  getMalwareLookupEnabled,
} from "@/services/settings/preferences"
import { setSetting } from "@/services/db/settings"
import { setDefaultKeyStore } from "@/services/crypto/key-management"
import { createInMemoryKeyStore } from "@/services/crypto/__tests__/in-memory-key-store"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { AttachmentSecuritySection } from "../attachment-security-section"

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
  // The API key now persists through the AES-GCM credentials envelope;
  // the in-memory key store keeps that path testable under jsdom.
  setDefaultKeyStore(createInMemoryKeyStore())
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  setDefaultKeyStore(null)
  executor.close()
})

function toggle(): HTMLElement {
  return screen.getByRole("switch", {
    name: "Check attachments with a malware lookup",
  })
}

function apiKeyInput(): HTMLInputElement {
  return screen.getByLabelText("VirusTotal API key") as HTMLInputElement
}

describe("AttachmentSecuritySection", () => {
  it("renders with the lookup off and an empty key by default", async () => {
    render(<AttachmentSecuritySection />)

    await waitFor(() =>
      expect(toggle().getAttribute("aria-checked")).toBe("false")
    )
    expect(apiKeyInput().value).toBe("")
    // The privacy note is part of the contract (hash-only, never contents).
    expect(
      screen.getByText(/only the file's sha-256 hash is ever sent/i)
    ).toBeTruthy()
  })

  it("reflects persisted state from earlier sessions", async () => {
    await setSetting(executor, "mail.malwareLookupEnabled", true)
    await setSetting(executor, "mail.malwareLookupApiKey", "stored-key")

    render(<AttachmentSecuritySection />)

    await waitFor(() =>
      expect(toggle().getAttribute("aria-checked")).toBe("true")
    )
    expect(apiKeyInput().value).toBe("stored-key")
  })

  it("persists a toggle flip immediately", async () => {
    render(<AttachmentSecuritySection />)
    await waitFor(() =>
      expect(toggle().getAttribute("aria-checked")).toBe("false")
    )

    fireEvent.click(toggle())

    await waitFor(async () => {
      expect(await getMalwareLookupEnabled(executor)).toBe(true)
    })
    expect(toggle().getAttribute("aria-checked")).toBe("true")
  })

  it("commits the trimmed API key on blur", async () => {
    render(<AttachmentSecuritySection />)
    await waitFor(() => expect(apiKeyInput().value).toBe(""))

    fireEvent.change(apiKeyInput(), {
      target: { value: "  dGVzdC1rZXk=  " },
    })
    fireEvent.blur(apiKeyInput())

    await waitFor(async () => {
      expect(await getMalwareLookupApiKey(executor)).toBe("dGVzdC1rZXk=")
    })
  })
})
