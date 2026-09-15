import { describe, expect, it } from "vitest"

import {
  CipherFormatError,
  base64ToBytes,
  decryptString,
  encryptString,
} from "../aes-gcm"

function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ])
}

/** Flip the first character of a base64 segment to a different one. */
function flipFirstChar(base64: string): string {
  const replacement = base64.startsWith("A") ? "B" : "A"
  return replacement + base64.slice(1)
}

describe("aes-gcm encryptString/decryptString", () => {
  it("round-trips unicode text", async () => {
    const key = await generateKey()
    const plaintext = "héllo wörld — 日本語テキスト 🔐 \n\ttoken=xyz"
    const decrypted = await decryptString(
      key,
      await encryptString(key, plaintext)
    )
    expect(decrypted).toBe(plaintext)
  })

  it("round-trips a large payload (~500 KB)", async () => {
    const key = await generateKey()
    const chunk =
      "The quick brown fox jumps over the lazy dog — 🦊 0123456789\n"
    const plaintext = chunk.repeat(8000) // ~570 KB
    const decrypted = await decryptString(
      key,
      await encryptString(key, plaintext)
    )
    expect(decrypted).toBe(plaintext)
  })

  it("round-trips an empty string", async () => {
    const key = await generateKey()
    const decrypted = await decryptString(key, await encryptString(key, ""))
    expect(decrypted).toBe("")
  })

  it("produces ciphertext that differs from the plaintext", async () => {
    const key = await generateKey()
    const plaintext = "sk-live-0123456789abcdef"
    const envelope = await encryptString(key, plaintext)
    expect(envelope).not.toContain(plaintext)
    expect(envelope).not.toBe(plaintext)
  })

  it("produces different ciphertext for the same plaintext (fresh IV)", async () => {
    const key = await generateKey()
    const first = await encryptString(key, "same-input")
    const second = await encryptString(key, "same-input")
    expect(first).not.toBe(second)
    // The IV segments differ; the version prefix does not.
    expect(first.split(".")[1]).not.toBe(second.split(".")[1])
  })

  it("uses the v1 envelope shape with a 12-byte IV", async () => {
    const key = await generateKey()
    const envelope = await encryptString(key, "format-check")
    const parts = envelope.split(".")
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe("v1")
    expect(parts[1]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(parts[2]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(base64ToBytes(parts[1])).toHaveLength(12)
  })

  it("rejects when a ciphertext byte is tampered with", async () => {
    const key = await generateKey()
    const envelope = await encryptString(key, "tamper-target")
    const parts = envelope.split(".")
    const tampered = [parts[0], parts[1], flipFirstChar(parts[2] ?? "")].join(
      "."
    )
    await expect(decryptString(key, tampered)).rejects.toThrow()
  })

  it("rejects when encrypted with a different key", async () => {
    const encryptKey = await generateKey()
    const wrongKey = await generateKey()
    const envelope = await encryptString(encryptKey, "secret")
    await expect(decryptString(wrongKey, envelope)).rejects.toThrow()
  })

  it("throws CipherFormatError for malformed envelopes", async () => {
    const key = await generateKey()
    await expect(decryptString(key, "not-an-envelope")).rejects.toThrow(
      CipherFormatError
    )
    await expect(decryptString(key, "v2.AAAA.AAAA")).rejects.toThrow(
      /unsupported envelope version/
    )
    await expect(
      decryptString(key, "v1.!!!not-base64!!!.AAAA")
    ).rejects.toThrow(/not base64/)
    await expect(decryptString(key, "v1.AAAA.AAAA")).rejects.toThrow(
      /iv must be 12 bytes/
    )
  })
})
