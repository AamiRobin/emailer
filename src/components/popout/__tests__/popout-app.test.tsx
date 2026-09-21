import { describe, expect, it } from "vitest"

import { popoutDraftIsDirty } from "@/services/desktop/popout-draft"

/**
 * Pop-out draft-guard decision tests (task 1.9, spec "Pop-out thread
 * windows"): a close with a draft in progress must prompt. The dirty
 * check is recipient/subject based — a signature-only body is not a
 * draft, and a closed composer is never dirty.
 */

function state(overrides: Partial<Parameters<typeof popoutDraftIsDirty>[0]> = {}) {
  return {
    open: true,
    to: [] as { email: string }[],
    cc: [] as { email: string }[],
    bcc: [] as { email: string }[],
    subject: "",
    ...overrides,
  }
}

describe("popoutDraftIsDirty", () => {
  it("a closed composer is never dirty", () => {
    expect(
      popoutDraftIsDirty(state({ open: false, to: [{ email: "a@b.c" }] }))
    ).toBe(false)
  })

  it("a fresh composer (no recipients, no subject) is clean", () => {
    expect(popoutDraftIsDirty(state())).toBe(false)
  })

  it("a subject, any recipient class, or whitespace-subject counts", () => {
    expect(popoutDraftIsDirty(state({ subject: "Hello" }))).toBe(true)
    expect(popoutDraftIsDirty(state({ to: [{ email: "a@b.c" }] }))).toBe(true)
    expect(popoutDraftIsDirty(state({ cc: [{ email: "a@b.c" }] }))).toBe(true)
    expect(popoutDraftIsDirty(state({ bcc: [{ email: "a@b.c" }] }))).toBe(true)
    expect(popoutDraftIsDirty(state({ subject: "   " }))).toBe(false)
  })
})
