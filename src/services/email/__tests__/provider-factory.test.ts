import { afterEach, describe, expect, it, vi } from "vitest"

import { ProviderAuthError } from "../types"
import {
  getProvider,
  registerProvider,
  unregisterProvider,
} from "../provider-factory"
import { fakeProvider, imapAccount, imapCredentials } from "./fixtures"

afterEach(() => {
  unregisterProvider("gmail")
})

describe("provider factory", () => {
  it("returns an imap-typed provider for imap accounts", () => {
    const provider = getProvider(imapAccount(), imapCredentials)
    expect(provider.type).toBe("imap")
    expect(provider.accountId).toBe("acc-1")
  })

  it("throws a clear error for unregistered account types (gmail until 4.2)", () => {
    expect(() =>
      getProvider(imapAccount({ type: "gmail" }), imapCredentials)
    ).toThrowError(/No email provider registered for account type "gmail"/)
  })

  it("lists the registered types in the error message", () => {
    expect(() =>
      getProvider(imapAccount({ type: "gmail" }), imapCredentials)
    ).toThrowError(/imap/)
  })

  it("lets later tasks register types without editing the factory", () => {
    const gmail = fakeProvider("acc-gmail")
    registerProvider("gmail", () => gmail)
    expect(getProvider(imapAccount({ type: "gmail" }), imapCredentials)).toBe(
      gmail
    )
  })

  it("passes account and credentials through to the creator", () => {
    const creator = vi.fn(() => fakeProvider("x"))
    registerProvider("gmail", creator)
    const account = imapAccount({ type: "gmail", id: "acc-9" })
    getProvider(account, imapCredentials)
    expect(creator).toHaveBeenCalledWith(account, imapCredentials)
  })

  it("replaces an existing registration", () => {
    const first = fakeProvider("a")
    const second = fakeProvider("b")
    registerProvider("gmail", () => first)
    registerProvider("gmail", () => second)
    expect(getProvider(imapAccount({ type: "gmail" }), imapCredentials)).toBe(
      second
    )
  })
})

describe("ProviderAuthError contract", () => {
  it("is a typed Error the auth-error task can catch", () => {
    const error = new ProviderAuthError("acc-1", "imap", "denied")
    expect(error.name).toBe("ProviderAuthError")
    expect(error.accountId).toBe("acc-1")
    expect(error.accountType).toBe("imap")
    expect(error.message).toBe("denied")
    expect(error instanceof Error).toBe(true)
  })
})
