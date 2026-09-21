import { describe, expect, it } from "vitest"

import { originLabel } from "../labels"

/**
 * Origin-label helper tests (task 5.8): every TaskOrigin renders a
 * stable human label for the UI surfaces (task 5.7 sidebar / task
 * detail) to show provenance without exposing the raw enum.
 */

describe("originLabel", () => {
  it("maps every origin to its display label", () => {
    expect(originLabel("manual")).toBe("Manual")
    expect(originLabel("email")).toBe("From email")
    expect(originLabel("ai")).toBe("From AI")
  })
})
