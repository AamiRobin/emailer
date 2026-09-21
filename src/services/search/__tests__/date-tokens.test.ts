import { describe, expect, it } from "vitest"

import { resolveDateTokens } from "../date-tokens"
import { parseSearchQuery } from "../parser"

/** Fixed local clock: 2026-09-18 15:42 local time (task 3.8 tests pin the
 * clock so the expected `yyyy-MM-dd` strings are exact regardless of the
 * machine's timezone or the moment the suite runs). */
const NOW = new Date(2026, 8, 18, 15, 42, 0)

describe("resolveDateTokens", () => {
  it("resolves a bare __TODAY__ to the local calendar date of now", () => {
    expect(resolveDateTokens("__TODAY__", NOW)).toBe("2026-09-18")
  })

  it("resolves negative day offsets (__TODAY-ND__)", () => {
    expect(resolveDateTokens("after:__TODAY-7D__", NOW)).toBe(
      "after:2026-09-11"
    )
    expect(resolveDateTokens("__TODAY-1D__", NOW)).toBe("2026-09-17")
  })

  it("resolves positive day offsets (__TODAY+ND__)", () => {
    expect(resolveDateTokens("before:__TODAY+1D__", NOW)).toBe(
      "before:2026-09-19"
    )
    expect(resolveDateTokens("__TODAY+0D__", NOW)).toBe("2026-09-18")
  })

  it("replaces every token in one query, each from the same now", () => {
    expect(
      resolveDateTokens("after:__TODAY-7D__ before:__TODAY+1D__", NOW)
    ).toBe("after:2026-09-11 before:2026-09-19")
  })

  it("is case-insensitive", () => {
    expect(resolveDateTokens("__today__", NOW)).toBe("2026-09-18")
    expect(resolveDateTokens("__Today-7d__", NOW)).toBe("2026-09-11")
    expect(resolveDateTokens("__today+2d__", NOW)).toBe("2026-09-20")
  })

  it("leaves malformed variants unchanged (documented passthrough)", () => {
    for (const input of [
      "__TODAY-__",
      "__TODAYXYZ__",
      "__TODAY-7__",
      "__TODAY+D__",
      "__YESTERDAY__",
    ]) {
      expect(resolveDateTokens(input, NOW)).toBe(input)
    }
  })

  it("keeps non-token text byte-identical", () => {
    const query = 'from:alice -subject:"weekly digest" is:unread'
    expect(resolveDateTokens(query, NOW)).toBe(query)
  })

  it("rolls with the clock: six days later the same query expands to a newer date", () => {
    // The spec scenario: a split defined as after:__TODAY-7D__ shows the
    // rolling last seven days when opened six days later — no edit.
    const dayX = resolveDateTokens("after:__TODAY-7D__", NOW)
    const dayXPlus6 = resolveDateTokens(
      "after:__TODAY-7D__",
      new Date(2026, 8, 24, 9, 0, 0)
    )
    expect(dayX).toBe("after:2026-09-11")
    expect(dayXPlus6).toBe("after:2026-09-17")
    expect(dayXPlus6).not.toBe(dayX)
  })

  it("crosses month and year boundaries and honors leap years", () => {
    expect(resolveDateTokens("__TODAY-7D__", new Date(2026, 0, 3))).toBe(
      "2025-12-27"
    )
    expect(resolveDateTokens("__TODAY+1D__", new Date(2028, 1, 28))).toBe(
      "2028-02-29"
    )
  })

  it("treats multi-digit offsets as plain integers", () => {
    expect(resolveDateTokens("__TODAY-30D__", NOW)).toBe("2026-08-19")
  })

  it("emits the exact date spelling the before:/after: parser accepts", () => {
    // Resolved output parses as a real date boundary (UTC midnight unix
    // seconds), not free text — __TODAY__ behaves exactly like the user
    // typing the date by hand.
    const resolved = resolveDateTokens("after:__TODAY-7D__", NOW)
    const parsed = parseSearchQuery(resolved)
    expect(parsed.after).toEqual([Math.floor(Date.UTC(2026, 8, 11) / 1000)])
    expect(parsed.freeText).toEqual([])
  })

  it("resolves with the real clock when now is omitted", () => {
    expect(resolveDateTokens("__TODAY__")).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
