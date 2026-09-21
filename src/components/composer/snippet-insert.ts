import { Extension } from "@tiptap/core"
import type { Editor } from "@tiptap/react"
import { Plugin, PluginKey } from "@tiptap/pm/state"

import {
  substituteSnippetVariables,
  type SnippetVariableContext,
} from "@/services/composer/snippet-variables"
import type { SnippetRow } from "@/services/db/snippets"
import { useAccountStore } from "@/stores/account-store"
import { useComposerStore } from "@/stores/composer-store"

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
 *
 * Task 2.3 (design D11) adds a `{{variable}}` substitution pass over the
 * plain body BEFORE the HTML conversion on both paths: known context
 * variables fill silently. On the menu path the unresolved ids collect
 * into ONE injected prompt (see setSnippetVariablePrompt) and the answers
 * apply to all occurrences before insertion; on the keyboard path the
 * prompt cannot run (see the comment in the handler) and unresolved ids
 * stay literal `{{id}}` text.
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

/**
 * The compose context substitution resolves against (task 2.3, design
 * D11): the first To-recipient as typed, plus the composing account's
 * identity (the composer's active account, falling back to the shell's —
 * the same resolution composer.tsx uses). Read from the stores at
 * insertion time: snippets insert from click/keydown handlers, never
 * mid-render, so getState() is the right access path (same discipline as
 * the shortcut map below).
 */
function snippetVariableContext(): SnippetVariableContext {
  const composer = useComposerStore.getState()
  const accounts = useAccountStore.getState()
  const accountId = composer.activeAccountId ?? accounts.activeAccountId
  const account = accountId
    ? accounts.accounts.find((candidate) => candidate.id === accountId)
    : undefined
  return {
    recipient: composer.to[0] ?? null,
    myName: account?.displayName ?? null,
    myEmail: account?.email ?? null,
  }
}

/**
 * The unknown-variable prompt, injected by the composer (task 2.3, design
 * D11): receives the unique unresolved ids in first-appearance order and
 * resolves with the collected answers (id → value), or null when the
 * dialog was cancelled (nothing inserts). Module-level like the shortcut
 * map so this module stays React-free — composer.tsx owns the dialog
 * state and swaps the implementation on mount; tests can install their
 * own or leave it unset.
 */
export type SnippetVariablePrompt = (
  variables: string[]
) => Promise<Record<string, string> | null>

let snippetVariablePrompt: SnippetVariablePrompt | null = null

/** Install/remove the prompt flow (the composer's mount effect; tests). */
export function setSnippetVariablePrompt(
  prompt: SnippetVariablePrompt | null
): void {
  snippetVariablePrompt = prompt
}

/** Insert a snippet body as HTML at the current cursor position, with
 * `{{variable}}` substitution first (task 2.3, design D11): known
 * variables fill from the compose context, unresolved ones collect into
 * ONE prompt and each answer applies to all occurrences before the text
 * converts to HTML. Synchronous fast path when nothing needs asking (the
 * common case, which also keeps the insert-at-caret behavior observable
 * synchronously); the prompting path continues asynchronously off the
 * click handler. Cancelling the prompt inserts nothing. */
export function insertSnippetBody(editor: Editor, body: string): void {
  const context = snippetVariableContext()
  const { text, unknownVariables } = substituteSnippetVariables(body, context)
  if (unknownVariables.length === 0 || !snippetVariablePrompt) {
    // Nothing to ask (or no prompt flow installed — tests, or a host that
    // never mounted the dialog): insert as substituted, with unresolved
    // placeholders left literal rather than dropping the snippet.
    editor.chain().focus().insertContent(snippetBodyToHtml(text)).run()
    return
  }
  void snippetVariablePrompt(unknownVariables).then((answers) => {
    // The composer (and its editor) can unmount while the dialog is open.
    if (answers === null || editor.isDestroyed) return
    const resolved = substituteSnippetVariables(body, context, answers).text
    editor.chain().focus().insertContent(snippetBodyToHtml(resolved)).run()
  })
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
              // Substitution on the keyboard path too (task 2.3, design
              // D11) — but WITHOUT prompting: a keydown handler must return
              // synchronously and a dialog round-trip cannot, so ids
              // without a context value stay literal `{{id}}` in the
              // expanded text — visible, editable placeholders. The menu
              // path (insertSnippetBody) is the one that MUST show the
              // prompt dialog.
              const { text } = substituteSnippetVariables(
                snippet.body,
                snippetVariableContext()
              )
              editor
                .chain()
                .focus()
                .deleteRange({ from, to: $from.pos })
                .insertContent(snippetBodyToHtml(text))
                .run()
              return true
            },
          },
        }),
      ]
    },
  })
}
