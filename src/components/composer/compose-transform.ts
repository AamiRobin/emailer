import { getHTMLFromFragment } from "@tiptap/core"
import type { Editor } from "@tiptap/react"

import type { ComposeTransformMode } from "@/services/ai/compose-transform"

/**
 * Editor integration for the compose text transform (task 4.6, ai-assistance
 * spec "Compose text transform"): capturing the transform target (the
 * selection, else the whole body), converting the model's plain-text answer
 * into editor HTML, and splicing a pending replacement in. Split out of
 * composer.tsx so the mechanics are unit-testable against a real editor;
 * the pending/accept/undo FLOW stays in the component.
 */

/** A captured transform target: where the replacement goes, the exact text
 * the provider sees, and the HTML snapshot for undo. */
export interface ComposeTransformTarget {
  range: { from: number; to: number }
  /** Plain text sent to the provider — paragraphs separated by "\n\n". */
  text: string
  /** Serialized HTML of exactly the captured range (the undo snapshot). */
  originalHtml: string
}

/**
 * Capture what the transform applies to (task 4.6): the current selection
 * when non-empty, else the WHOLE body (spec: "on selected draft text (or
 * the whole body when nothing is selected)"). Returns null when there is
 * nothing transformable (blank target) — the caller skips the request
 * instead of prompting the model with empty input. Toolbar clicks steal
 * DOM focus but never move the editor's own state selection, so reading
 * `editor.state.selection` here still sees the user's text selection.
 */
export function captureTransformTarget(
  editor: Editor
): ComposeTransformTarget | null {
  const { from, to, empty } = editor.state.selection
  const range = empty ? { from: 0, to: editor.state.doc.content.size } : { from, to }
  const text = editor.state.doc.textBetween(range.from, range.to, "\n\n")
  if (text.trim() === "") return null
  const fragment = editor.state.doc.cut(range.from, range.to).content
  return {
    range,
    text,
    originalHtml: getHTMLFromFragment(fragment, editor.schema),
  }
}

/**
 * Transformed plain text → editor HTML, mirroring snippet-insert.ts's
 * `snippetBodyToHtml` (the service's output contract guarantees
 * blank-line-separated paragraphs): a single block becomes an inline
 * fragment (insertContentAt merges it into the enclosing paragraph, so
 * one-liner transforms don't fragment the paragraph), multiple blocks
 * become paragraphs with single newlines as `<br>`.
 */
export function transformedTextToHtml(text: string): string {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== "")
  if (blocks.length === 0) return ""
  const inline = (block: string) => escapeHtml(block).replace(/\n/g, "<br>")
  if (blocks.length === 1) return inline(blocks[0])
  return blocks.map((block) => `<p>${inline(block)}</p>`).join("")
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** What the caller needs to put the original content back (undo). */
export interface ComposeTransformUndo {
  range: { from: number; to: number }
}

/**
 * Replace `range` with `html` (task 4.6 Accept). Returns the extent the
 * inserted content now occupies — the replacement shifts positions when
 * its length differs, so the undo snapshot is recomputed from the document
 * size delta (the only change was inside the range) — or null when the
 * editor died before the replacement could run. Positions are clamped to
 * the live document first: the user keeps editing while a replacement is
 * pending (the flow never blocks the draft), so a stale captured range may
 * overflow the doc it is finally applied to. Deliberately no `focus()`:
 * the chain must not steal focus from the bar's button nor scroll the
 * body — `insertContentAt` keeps the editor's selection state at the end
 * of the inserted content, so the user's next click into the editor
 * resumes right there. The transaction is a regular history entry, so the
 * editor's own undo (StarterKit's undo/redo) covers the replacement too —
 * the explicit Undo affordance in the accept toast uses the returned
 * range for discoverability.
 */
export function replaceDraftRange(
  editor: Editor,
  range: { from: number; to: number },
  html: string
): ComposeTransformUndo | null {
  if (editor.isDestroyed) return null
  const size = editor.state.doc.content.size
  const from = Math.max(0, Math.min(range.from, size))
  const to = Math.max(from, Math.min(range.to, size))
  const sizeBefore = editor.state.doc.content.size
  editor.chain().insertContentAt({ from, to }, html).run()
  const sizeAfter = editor.state.doc.content.size
  return { range: { from, to: to + (sizeAfter - sizeBefore) } }
}

/** Visible labels for the three modes (toolbar menu + bar copy). */
export const COMPOSE_TRANSFORM_LABELS: Record<ComposeTransformMode, string> = {
  improve: "Improve writing",
  shorten: "Shorten",
  formalize: "Formalize",
}
