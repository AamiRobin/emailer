import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { encryptString } from "../aes-gcm"
import {
  CredentialDecryptError,
  decryptCredentials,
  encryptCredentials,
} from "../credentials"
import { getOrCreateEncryptionKey, setDefaultKeyStore } from "../key-management"
import { createInMemoryKeyStore } from "./in-memory-key-store"

interface GmailTokens {
  accessToken: string
  refreshToken: string
  scope: string
}

describe("credentials service", () => {
  let store = createInMemoryKeyStore()

  beforeEach(() => {
    store = createInMemoryKeyStore()
    setDefaultKeyStore(store)
  })

  afterEach(() => {
    setDefaultKeyStore(null)
  })

  it("round-trips credentials through the envelope", async () => {
    const tokens: GmailTokens = {
      accessToken: "ya29.a0AfB_byEXAMPLE",
      refreshToken: "1//0gHökFLI 🔐-refreshtoken",
      scope: "https://mail.google.com/ read only",
    }
    const envelope = await encryptCredentials(tokens)
    const decrypted = await decryptCredentials<GmailTokens>(envelope)
    expect(decrypted).toEqual(tokens)
  })

  it("never exposes plaintext in the envelope", async () => {
    const envelope = await encryptCredentials({ password: "s3cret-pa55word" })
    expect(envelope).not.toContain("s3cret-pa55word")
    expect(envelope).not.toContain("password")
    expect(envelope.startsWith("v1.")).toBe(true)
  })

  it("returns null for null, empty, or blank envelopes", async () => {
    expect(await decryptCredentials(null)).toBeNull()
    expect(await decryptCredentials("")).toBeNull()
    expect(await decryptCredentials("   ")).toBeNull()
  })

  it("throws CredentialDecryptError for a corrupt envelope", async () => {
    const failure = await decryptCredentials("not-an-envelope").catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(CredentialDecryptError)
    expect((failure as Error).name).toBe("CredentialDecryptError")
    expect((failure as Error).cause).toBeDefined()
  })

  it("throws CredentialDecryptError when a ciphertext byte is tampered with", async () => {
    const envelope = await encryptCredentials({ password: "x" })
    const parts = envelope.split(".")
    const tampered = [
      parts[0],
      parts[1],
      (parts[2] ?? "").startsWith("A")
        ? "B" + (parts[2] ?? "").slice(1)
        : "A" + (parts[2] ?? "").slice(1),
    ].join(".")
    await expect(decryptCredentials(tampered)).rejects.toThrow(
      CredentialDecryptError
    )
  })

  it("throws CredentialDecryptError when the key has changed", async () => {
    const envelope = await encryptCredentials({ password: "x" })

    // Simulate a lost/rotated key file: point the service at a store whose
    // key was generated independently.
    const otherStore = createInMemoryKeyStore()
    await getOrCreateEncryptionKey(otherStore)
    setDefaultKeyStore(otherStore)

    await expect(decryptCredentials(envelope)).rejects.toThrow(
      CredentialDecryptError
    )
  })

  it("throws CredentialDecryptError for an envelope that is not JSON", async () => {
    const key = await getOrCreateEncryptionKey(store)
    const envelope = await encryptString(key, "definitely not json")
    await expect(decryptCredentials(envelope)).rejects.toThrow(
      CredentialDecryptError
    )
  })

  it("does not leak envelope content in error messages", async () => {
    const envelope = await encryptCredentials({ password: "supersecret" })
    const failure = await decryptCredentials("v9." + envelope.slice(3)).catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(CredentialDecryptError)
    expect((failure as Error).message).not.toContain("supersecret")
  })
})
