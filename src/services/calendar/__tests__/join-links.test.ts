import { describe, expect, it } from "vitest"

import { extractJoinLink } from "../join-links"

/**
 * Join-link extraction tests (parity-round-3 task 8.4, design D5): the
 * CURATED matcher (zoom/meet/teams/webex/dial-in) over LOCATION and
 * DESCRIPTION surfaces — random description links must never become the
 * join button, and the first curated surface/URL wins.
 */

describe("extractJoinLink", () => {
  it("finds the curated video hosts", () => {
    expect(extractJoinLink("https://zoom.us/j/1234567890")).toEqual({
      url: "https://zoom.us/j/1234567890",
      label: "Zoom",
    })
    expect(
      extractJoinLink("https://meet.google.com/abc-defg-hij")
    ).toMatchObject({ label: "Google Meet" })
    expect(
      extractJoinLink(
        "https://teams.microsoft.com/l/meetup-join/19%3ameeting/abc"
      )
    ).toMatchObject({ label: "Microsoft Teams" })
    expect(
      extractJoinLink("https://example.webex.com/meet/room-1")
    ).toMatchObject({ label: "Webex" })
  })

  it("matches subdomains of curated hosts", () => {
    expect(
      extractJoinLink("https://us02web.zoom.us/j/999")
    ).toMatchObject({ label: "Zoom" })
  })

  it("prefers LOCATION over DESCRIPTION (surface order)", () => {
    const link = extractJoinLink(
      "Room 4",
      "Agenda: https://docs.example.com/agenda\nJoin: https://zoom.us/j/42"
    )
    expect(link).toEqual({ url: "https://zoom.us/j/42", label: "Zoom" })
  })

  it("never mistakes an unrelated link for a join button", () => {
    expect(
      extractJoinLink("Room 4", "See https://docs.example.com/agenda and https://maps.example.com/place")
    ).toBeNull()
  })

  it("strips sentence punctuation from the URL", () => {
    const link = extractJoinLink("Join at https://zoom.us/j/7.")
    expect(link?.url).toBe("https://zoom.us/j/7")
  })

  it("recognizes dial-in-only text (tel: and wording)", () => {
    expect(extractJoinLink(null, "Dial-in: +1 555 0100")).toEqual({
      url: null,
      label: "Dial-in",
    })
    const tel = extractJoinLink("Or call tel:+15550100")
    expect(tel).toEqual({ url: "tel:+15550100", label: "Dial-in" })
    expect(extractJoinLink(null, "one-tap: +15550100")).toMatchObject({
      label: "Dial-in",
    })
  })

  it("returns null for empty/absent surfaces", () => {
    expect(extractJoinLink(null, null)).toBeNull()
    expect(extractJoinLink("", "")).toBeNull()
    expect(extractJoinLink(undefined)).toBeNull()
  })
})
