import { Extension } from "@tiptap/core"
import type { Editor } from "@tiptap/react"
import { Plugin, PluginKey } from "@tiptap/pm/state"

import type { SnippetRow } from "@/services/db/snippets"

/**
 * Snippet insertion for the composer (task 6.2). Both entry points share
 * one insertion path — the body is converted to HTML and inserted at the
 * current selection with TipTap's insertContent (block-level HTML splits
 * the enclosing paragraph, so multi-paragraph bodies land as proper
 * paragraphs):
 *
 * - Menu (snippet-picker.tsx): `insertSnippetBody` runs a focused chain —
 *   focus() restores the last caret position, so after the toolbar click
 *   stole focus the insertion still lands at the cursor.
 * - Keyboard: `createSnippetExpansion` is a ProseMirror handleKeyDown
 *   plugin. This mechanism (over an input rule) is deliberate: snippets
 *   load asynchronously from the db, so the plugin reads a live shortcut
 *   map at keystroke time (see setSnippetShortcuts below — swapped by the
 *   composer's load effect, never touched during render), and a keydown
 *   handler can consume the trigger key itself. Trigger: SPACE, pressed
 *   right after a word that exactly matches a snippet shortcut. The
 *   plugin deletes the typed shortcut, inserts the body in its place and
 *   swallows the space (returning true + preventDefault), so no stray
 *   separator is left behind. Matching is exact and case-sensitive,
 *   word-boundary anchored (the trailing non-space run before the caret).
 *   A snippet without a shortcut is only reachable via the menu;
 *   duplicate shortcuts keep the first (alphabetically-named) row.
 */

/** Snippet bodies are plain text (settings Textarea). A single block (no
 * blank lines) converts to an inline fragment — insertContent merges it
 * into the current paragraph, so one-liner expansions feel like typing.
 * Blank-line-separated blocks convert to paragraphs (single newlines
 * become `<br>`), so multi-paragraph bodies insert as proper paragraphs
 * (TipTap splits the enclosing paragraph for block content). */
function snippetBodyToHtml(body: string): string {
  const blocks = body
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

/** Insert a snippet body as HTML at the current cursor position. */
export function insertSnippetBody(editor: Editor, body: string): void {
  editor.chain().focus().insertContent(snippetBodyToHtml(body)).run()
}

/** Shortcut → snippet lookup the expansion plugin consults per keystroke.
 * Module-level because the composer editor is a singleton (one composer
 * instance exists at a time) and the plugin cannot re-read React state
 * mid-keystroke; the composer swaps the map whenever listSnippets
 * resolves, and it is only ever READ at keydown. */
export type SnippetShortcutMap = ReadonlyMap<string, SnippetRow>

let sharedShortcuts: SnippetShortcutMap = new Map()

/** Replace the keyboard-expansion lookup table (called by the composer's
 * snippet load effect with the freshly loaded rows). */
export function setSnippetShortcuts(shortcuts: SnippetShortcutMap): void {
  sharedShortcuts = shortcuts
}

/** Editor extension backing the keyboard path; see the module doc for the
 * mechanism and the SPACE trigger choice. */
export function createSnippetExpansion(): Extension {
  return Extension.create({
    name: "snippetExpansion",

    addProseMirrorPlugins() {
      const editor = this.editor
      return [
        new Plugin({
          key: new PluginKey("snippetExpansion"),
          props: {
            handleKeyDown: (view, event) => {
              // Asian IME composition: the keydown that COMMITS a
              // candidate (often the space key) fires with isComposing /
              // the legacy keyCode 229 — expanding during composition
              // would corrupt the composing text, so bail.
              if (event.isComposing || event.keyCode === 229) return false
              if (event.key !== " ") return false
              if (
                event.shiftKey ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey
              ) {
                return false
              }
              const { state } = view
              if (!state.selection.empty) return false
              const { $from } = state.selection
              if (!$from.parent.isTextblock) return false
              // Trailing run of typeable text before the caret (object
              // replacement chars excluded so word length maps 1:1 onto
              // document positions).
              const textBefore = $from.parent.textBetween(
                0,
                $from.parentOffset,
                undefined,
                "\ufffc"
              )
              const match = /[^\s\ufffc]+$/.exec(textBefore)
              const shortcut = match?.[0]
              if (!shortcut) return false
              const snippet = sharedShortcuts.get(shortcut)
              if (!snippet) return false

              event.preventDefault()
              const from = $from.pos - shortcut.length
              editor
                .chain()
                .focus()
                .deleteRange({ from, to: $from.pos })
                .insertContent(snippetBodyToHtml(snippet.body))
                .run()
              return true
            },
          },
        }),
      ]
    },
  })
}
