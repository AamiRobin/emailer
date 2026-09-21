import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import type { SnippetRow } from "@/services/db/snippets"
import { SnippetPicker } from "../snippet-picker"

/**
 * Snippet picker variable hint (task 2.4, design D11): entries whose body
 * contains `{{variable}}` placeholders show a compact hint with the count
 * of DISTINCT variables; plain bodies show none. Render-only — editor is
 * null so a stray click is a no-op; the insertion flow (including the
 * prompt) is covered by the composer suite and snippet-insert tests.
 */

function row(input: { name: string; body: string }): SnippetRow {
  return {
    id: input.name.toLowerCase(),
    name: input.name,
    body: input.body,
    shortcut: null,
    created_at: 0,
  }
}

function openPicker(snippets: SnippetRow[]): void {
  render(<SnippetPicker editor={null} snippets={snippets} disabled={false} />)
  fireEvent.click(screen.getByRole("button", { name: "Insert snippet" }))
}

afterEach(cleanup)

describe("SnippetPicker variable hint (task 2.4)", () => {
  it("hints the variable count for a body with placeholders", () => {
    openPicker([
      // Repeated id counts once — one answer fills all occurrences.
      row({
        name: "Greet",
        body: "Hi {{first_name}}, {{first_name}} on {{date}}!",
      }),
    ])

    const entry = screen.getByRole("button", { name: "Insert Greet" })
    const hint = entry.querySelector('[data-testid="snippet-variable-hint"]')
    expect(hint).not.toBeNull()
    expect(hint?.textContent).toBe(
      "2 variables — you'll be asked for any we can't fill"
    )
  })

  it("singular hint for a single variable", () => {
    openPicker([row({ name: "Sign", body: "— {{my_name}}" })])

    const hint = screen
      .getByRole("button", { name: "Insert Sign" })
      .querySelector('[data-testid="snippet-variable-hint"]')
    expect(hint?.textContent).toContain("1 variable ")
  })

  it("shows no hint for a plain body", () => {
    openPicker([
      row({ name: "Plain", body: "Just text, no placeholders" }),
      row({ name: "Greet", body: "Hi {{first_name}}!" }),
    ])

    expect(
      screen
        .getByRole("button", { name: "Insert Plain" })
        .querySelector('[data-testid="snippet-variable-hint"]')
    ).toBeNull()
    // The hint only annotates the variable-using entry.
    expect(screen.getAllByTestId("snippet-variable-hint")).toHaveLength(1)
  })
})
