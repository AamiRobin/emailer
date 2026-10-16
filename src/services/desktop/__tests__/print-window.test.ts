import { describe, expect, it } from "vitest"

import { uid } from "@/services/db/__tests__/fixtures"
import {
  PRINT_POPOUT_LABEL_PREFIX,
  printWindowContext,
  printWindowLabel,
} from "@/services/desktop/print-window"

/**
 * Print window label round-trip (parity-round-3 tasks 4.1–4.2): the
 * label IS the route, and ids travel HEX-ENCODED — Gmail row ids embed
 * base64url Gmail ids whose alphabet includes `_`, which both the `_`
 * scope separator and sanitizeLabelPart's fold would corrupt (a truncated
 * thread id parses, then prints "Nothing to print"). Hex keeps the
 * payload separator-free; malformed or foreign labels parse to null so a
 * mistyped window can never print the wrong thing.
 */
describe("print window label round-trip", () => {
  it("thread scope round-trips", () => {
    const threadId = uid("thread")
    const label = printWindowLabel(threadId, { kind: "thread" })
    expect(label.startsWith(PRINT_POPOUT_LABEL_PREFIX)).toBe(true)
    expect(printWindowContext(label)).toEqual({
      threadId,
      scope: { kind: "thread" },
    })
  })

  it("message scope round-trips", () => {
    const threadId = "0b1e2f3a-11bb-4cc2-9dd3-004455aa6b7c"
    const messageId = "f0e1d2c3-44aa-4bb5-8cc6-991122334455"
    const label = printWindowLabel(threadId, {
      kind: "message",
      messageId,
    })
    expect(printWindowContext(label)).toEqual({
      threadId,
      scope: { kind: "message", messageId },
    })
  })

  it("hex-encodes ids so separator underscores inside real Gmail ids survive", () => {
    // A Gmail-shaped row id whose gmailThreadId carries base64url `_` —
    // the lossy pre-hex scheme truncated at the first `_`.
    const threadId = "gt-0b1e2f3a-11bb-4cc2-9dd3-004455aa6b7c-AaB_CcD"
    const messageId = "mock-msg_with_underscores"
    const label = printWindowLabel(threadId, {
      kind: "message",
      messageId,
    })
    // Payload is hex: only [0-9a-f] plus exactly one `_` separator.
    expect(label).toMatch(/^popout-print-m-[0-9a-f]+_[0-9a-f]+$/)
    expect(printWindowContext(label)).toEqual({
      threadId,
      scope: { kind: "message", messageId },
    })
  })

  it("thread scope survives separator underscores too", () => {
    const threadId = "gt-uuid_solo_ABC_xyz"
    const label = printWindowLabel(threadId, { kind: "thread" })
    expect(printWindowContext(label)).toEqual({
      threadId,
      scope: { kind: "thread" },
    })
  })

  it("round-trips non-uuid ids with spaces and unicode", () => {
    const threadId = "thread odd.id/with:unsafe"
    const label = printWindowLabel(threadId, {
      kind: "message",
      messageId: "msg/unsafe:id ✓",
    })
    expect(printWindowContext(label)).toEqual({
      threadId,
      scope: { kind: "message", messageId: "msg/unsafe:id ✓" },
    })
  })

  it("non-print and malformed labels parse to null", () => {
    expect(printWindowContext("main")).toBeNull()
    expect(printWindowContext("popout-some-thread")).toBeNull()
    expect(printWindowContext(`${PRINT_POPOUT_LABEL_PREFIX}x-weird`)).toBeNull()
    // Message scope with no separator, or nothing after it.
    expect(
      printWindowContext(`${PRINT_POPOUT_LABEL_PREFIX}m-threadonly`)
    ).toBeNull()
    expect(
      printWindowContext(`${PRINT_POPOUT_LABEL_PREFIX}m-thread_`)
    ).toBeNull()
    // Non-hex payloads (the old plain-id labels) must NOT parse — a stale
    // window from a previous app version can't print the wrong thread.
    expect(
      printWindowContext(`${PRINT_POPOUT_LABEL_PREFIX}m-thread_msg-id`)
    ).toBeNull()
    expect(printWindowContext(`${PRINT_POPOUT_LABEL_PREFIX}t-plain-thread`))
      .toBeNull()
  })
})
