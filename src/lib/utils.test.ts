import { describe, expect, it } from "vitest"

import { cn } from "./utils"

describe("cn", () => {
  it("joins class names and drops falsy values", () => {
    const falsy = false as const
    expect(cn("foo", falsy && "bar", undefined, "baz")).toBe("foo baz")
  })

  it("resolves conflicting tailwind classes (last wins)", () => {
    expect(cn("p-2", "p-4")).toBe("p-4")
  })
})
