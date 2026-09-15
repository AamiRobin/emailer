import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  appendSignature,
  COMPOSER_BLOCK_SEPARATOR,
  getSignature,
  setSignature,
  signatureSettingKey,
} from "../signatures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"

describe("signatures service", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  describe("getSignature / setSignature", () => {
    it("round-trips signature html per account", async () => {
      expect(await getSignature(executor, "acc-1")).toBe("")
      await setSignature(executor, "acc-1", "<p>Best, Alice</p>")
      await setSignature(executor, "acc-2", "<p>Bob</p>")
      expect(await getSignature(executor, "acc-1")).toBe("<p>Best, Alice</p>")
      expect(await getSignature(executor, "acc-2")).toBe("<p>Bob</p>")
    })

    it("overwrites the previous signature", async () => {
      await setSignature(executor, "acc-1", "<p>v1</p>")
      await setSignature(executor, "acc-1", "<p>v2</p>")
      expect(await getSignature(executor, "acc-1")).toBe("<p>v2</p>")
    })

    it("stores under the signature:<accountId> settings key", async () => {
      await setSignature(executor, "acc-1", "<p>Hi</p>")
      const rows = await executor.select<{ key: string; value: string }>(
        "SELECT key, value FROM settings WHERE key = $1",
        [signatureSettingKey("acc-1")]
      )
      expect(rows[0]?.key).toBe("signature:acc-1")
      expect(JSON.parse(rows[0]?.value ?? "{}")).toEqual({ html: "<p>Hi</p>" })
    })

    it("returns empty string for a corrupt stored payload", async () => {
      await setSignature(executor, "acc-1", "<p>Hi</p>")
      await executor.execute("UPDATE settings SET value = $1 WHERE key = $2", [
        "not json",
        signatureSettingKey("acc-1"),
      ])
      expect(await getSignature(executor, "acc-1")).toBe("")
    })
  })

  describe("appendSignature", () => {
    it("returns the body unchanged for an empty signature", () => {
      expect(appendSignature("<p>Body</p>", "")).toBe("<p>Body</p>")
      expect(appendSignature("<p>Body</p>", "   ")).toBe("<p>Body</p>")
    })

    it("appends below the body of a fresh message", () => {
      expect(appendSignature("<p>Body</p>", "<p>Sig</p>")).toBe(
        `<p>Body</p>${COMPOSER_BLOCK_SEPARATOR}<div class="emailer-signature"><p>Sig</p></div>`
      )
    })

    it("returns just the signature block for an empty body", () => {
      expect(appendSignature("", "<p>Sig</p>")).toBe(
        '<div class="emailer-signature"><p>Sig</p></div>'
      )
    })

    it("places the signature between body and an existing quote", () => {
      const body = `<p>Body</p>${COMPOSER_BLOCK_SEPARATOR}<blockquote><p>Quote</p></blockquote>`
      const withSignature = appendSignature(body, "<p>Sig</p>")
      expect(withSignature).toBe(
        `<p>Body</p>${COMPOSER_BLOCK_SEPARATOR}<div class="emailer-signature"><p>Sig</p></div><blockquote><p>Quote</p></blockquote>`
      )
      const quoteIndex = withSignature.indexOf("<blockquote")
      const signatureIndex = withSignature.indexOf("emailer-signature")
      expect(signatureIndex).toBeGreaterThan(0)
      expect(signatureIndex).toBeLessThan(quoteIndex)
    })

    it("does not double the separator when the body ends with one", () => {
      const body = `<p>Body</p>${COMPOSER_BLOCK_SEPARATOR}`
      expect(appendSignature(body, "<p>Sig</p>")).toBe(
        `<p>Body</p>${COMPOSER_BLOCK_SEPARATOR}<div class="emailer-signature"><p>Sig</p></div>`
      )
    })

    it("detects uppercase blockquote tags for quote placement", () => {
      const body = "<p>Body</p><BLOCKQUOTE><p>Quote</p></BLOCKQUOTE>"
      const withSignature = appendSignature(body, "<p>Sig</p>")
      expect(withSignature.indexOf("emailer-signature")).toBeLessThan(
        withSignature.toLowerCase().indexOf("<blockquote")
      )
    })
  })
})
