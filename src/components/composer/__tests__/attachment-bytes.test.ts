import { describe, expect, it } from "vitest"

import {
  clearAttachmentBytes,
  deleteAttachmentBytes,
  getAttachmentBytes,
  setAttachmentBytes,
} from "../attachment-bytes"

/**
 * The session byte registry (task 8.5): id → Uint8Array, the non-serializable
 * half of the composer's attachment state. Contents are opaque here — the
 * payload builder is what turns them into base64 (see composer-store tests).
 */
describe("attachment-bytes registry", () => {
  it("stores, returns and overwrites bytes by id", () => {
    const first = new Uint8Array([1, 2, 3])
    setAttachmentBytes("a-1", first)
    expect(getAttachmentBytes("a-1")).toBe(first)

    const second = new Uint8Array([9])
    setAttachmentBytes("a-1", second)
    expect(getAttachmentBytes("a-1")).toBe(second)
  })

  it("returns undefined for unknown ids", () => {
    expect(getAttachmentBytes("missing")).toBeUndefined()
  })

  it("deleteAttachmentBytes drops one entry (no-op when absent)", () => {
    setAttachmentBytes("a-2", new Uint8Array([1]))
    deleteAttachmentBytes("a-2")
    expect(getAttachmentBytes("a-2")).toBeUndefined()
    expect(() => deleteAttachmentBytes("a-2")).not.toThrow()
  })

  it("clearAttachmentBytes drops every entry", () => {
    setAttachmentBytes("a-3", new Uint8Array([1]))
    setAttachmentBytes("a-4", new Uint8Array([2]))
    clearAttachmentBytes()
    expect(getAttachmentBytes("a-3")).toBeUndefined()
    expect(getAttachmentBytes("a-4")).toBeUndefined()
  })
})
