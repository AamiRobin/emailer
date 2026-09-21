import { describe, expect, it } from "vitest"

import {
  SNIPPET_VARIABLE_IDS,
  SNIPPET_VARIABLE_LABELS,
  SNIPPET_VARIABLES,
  snippetVariableIdsInBody,
  substituteSnippetVariables,
} from "../snippet-variables"

/**
 * Snippet variable substitution (task 2.3, design D11): pure string work,
 * no executor or React needed. Fixtures pin the date so the `date`
 * variable is assertable.
 */

const JANE = { name: "Jane Doe", email: "jane@example.com" }
const PINNED_DATE = new Date(2026, 8, 18) // Friday, September 18th, 2026

describe("snippet variable substitution (task 2.3, design D11)", () => {
  it("fills recipient variables from a typed display name", () => {
    const { text, unknownVariables } = substituteSnippetVariables(
      "Hi {{first_name}} {{last_name}} ({{full_name}}) <{{email}}>",
      { recipient: JANE }
    )
    expect(text).toBe("Hi Jane Doe (Jane Doe) <jane@example.com>")
    expect(unknownVariables).toEqual([])
  })

  it("derives names from the email local-part when no display name is known", () => {
    const { text } = substituteSnippetVariables(
      "{{first_name}}|{{last_name}}|{{full_name}}|{{email}}",
      { recipient: { email: "jane.doe@example.com" } }
    )
    expect(text).toBe("Jane|Doe|Jane Doe|jane.doe@example.com")
  })

  it("local-part heuristic strips plus-tags and splits on separators", () => {
    const { text } = substituteSnippetVariables(
      "{{first_name}} {{last_name}}",
      { recipient: { email: "mary-ann_l+lists@example.com" } }
    )
    expect(text).toBe("Mary L")
  })

  it("a single-token name resolves first/full but leaves last_name to prompt", () => {
    const { text, unknownVariables } = substituteSnippetVariables(
      "{{first_name}}/{{last_name}}",
      { recipient: { email: "jane@example.com" } }
    )
    expect(text).toBe("Jane/{{last_name}}")
    expect(unknownVariables).toEqual(["last_name"])
  })

  it("fills the date and the user's own identity from context", () => {
    const { text, unknownVariables } = substituteSnippetVariables(
      "Sent on {{date}} from {{my_name}} <{{my_email}}>",
      {
        myName: "Alex Chen",
        myEmail: "alex@chen.dev",
        today: PINNED_DATE,
      }
    )
    expect(text).toBe(
      "Sent on Friday, September 18th, 2026 from Alex Chen <alex@chen.dev>"
    )
    expect(unknownVariables).toEqual([])
  })

  it("own identity without an account prompts instead of inserting empties", () => {
    const { text, unknownVariables } = substituteSnippetVariables(
      "{{my_name}} <{{my_email}}>",
      {}
    )
    expect(text).toBe("{{my_name}} <{{my_email}}>")
    expect(unknownVariables).toEqual(["my_name", "my_email"])
  })

  it("collects a repeated unknown id ONCE, in first-appearance order", () => {
    const body = "{{tracking_id}} … {{other}} … {{tracking_id}} … {{other}}"
    const { text, unknownVariables } = substituteSnippetVariables(body, {})
    // Spec "Unknown variable prompts once": both occurrences share one
    // answer, so the prompt list holds each id exactly once.
    expect(unknownVariables).toEqual(["tracking_id", "other"])
    // Unresolved placeholders stay literal in the returned text.
    expect(text).toBe(body)
  })

  it("passes a body without placeholders through byte-identical", () => {
    const body = "Plain text\n\nwith two paragraphs & <brackets> — no vars"
    const { text, unknownVariables } = substituteSnippetVariables(body, {
      recipient: JANE,
    })
    expect(text).toBe(body)
    expect(unknownVariables).toEqual([])
  })

  it("tolerates optional whitespace inside the braces", () => {
    const { text } = substituteSnippetVariables(
      "{{ first_name }} and {{  date  }}",
      { recipient: JANE, today: PINNED_DATE }
    )
    expect(text).toBe("Jane and Friday, September 18th, 2026")
  })

  it("leaves malformed braces verbatim", () => {
    const { text } = substituteSnippetVariables(
      "a {{oops b {{first_name}} c {{}} d",
      { recipient: JANE }
    )
    // The unclosed `{{oops` and the empty `{{}}` are not placeholders; the
    // well-formed one between them still substitutes.
    expect(text).toBe("a {{oops b Jane c {{}} d")
  })

  it("prompt answers take precedence and hit every occurrence", () => {
    const { text } = substituteSnippetVariables(
      "id={{tracking_id}} id={{ tracking_id }} hi {{first_name}}",
      { recipient: JANE },
      { tracking_id: "TRK-42" }
    )
    expect(text).toBe("id=TRK-42 id=TRK-42 hi Jane")
  })

  it("a blank answer counts as unanswered and keeps the placeholder", () => {
    const { text, unknownVariables } = substituteSnippetVariables(
      "{{tracking_id}}",
      {},
      { tracking_id: "   " }
    )
    expect(text).toBe("{{tracking_id}}")
    expect(unknownVariables).toEqual(["tracking_id"])
  })

  it("registry covers exactly the design D11 ids with labels", () => {
    expect(SNIPPET_VARIABLE_IDS).toEqual([
      "first_name",
      "last_name",
      "full_name",
      "email",
      "my_name",
      "my_email",
      "date",
    ])
    for (const id of SNIPPET_VARIABLE_IDS) {
      expect(SNIPPET_VARIABLE_LABELS[id]).toBeTruthy()
    }
  })
})

describe("snippet variable UI metadata (task 2.4, design D11)", () => {
  it("SNIPPET_VARIABLES is the single source for ids and labels", () => {
    // The derived exports must stay in lockstep with the metadata rows the
    // picker hint and the settings legend render from.
    expect(SNIPPET_VARIABLE_IDS).toEqual(
      SNIPPET_VARIABLES.map((variable) => variable.id)
    )
    for (const variable of SNIPPET_VARIABLES) {
      expect(SNIPPET_VARIABLE_LABELS[variable.id]).toBe(variable.label)
      // UI copy complete: every row documents itself for the legend.
      expect(variable.description.trim()).not.toBe("")
      expect(variable.example.trim()).not.toBe("")
    }
  })

  it("snippetVariableIdsInBody lists unique ids in first-appearance order", () => {
    expect(
      snippetVariableIdsInBody("{{first_name}} {{bogus}} {{ first_name }} x")
    ).toEqual(["first_name", "bogus"])
  })

  it("snippetVariableIdsInBody tolerates plain bodies and bad braces", () => {
    expect(snippetVariableIdsInBody("Plain body, nothing here")).toEqual([])
    expect(snippetVariableIdsInBody("a {{oops b {{}} c")).toEqual([])
  })
})
