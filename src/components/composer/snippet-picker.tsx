import { useState } from "react"
import type { Editor } from "@tiptap/react"
import { ScrollText } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import type { SnippetRow } from "@/services/db/snippets"
import { snippetVariableIdsInBody } from "@/services/composer/snippet-variables"
import { insertSnippetBody } from "./snippet-insert"

/**
 * Toolbar dropdown listing the snippets by name, shortcut and body
 * preview (task 6.2). Picking one inserts its body at the current cursor
 * position (insertSnippetBody) and closes the menu. The empty state points
 * at the settings section that owns snippet CRUD. The keyboard
 * shortcut-expansion entry point lives in snippet-insert.ts.
 *
 * Task 2.4 (design D11): entries whose body uses `{{variable}}`
 * placeholders say so — a compact one-line hint with the number of
 * DISTINCT variables, since insertion prompts for any the compose context
 * can't fill. Deliberately just a hint (this is a quick-insert surface);
 * the full variable documentation lives in Settings → Snippets.
 */
export function SnippetPicker({
  editor,
  snippets,
  disabled,
}: {
  editor: Editor | null
  snippets: SnippetRow[]
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label="Insert snippet"
            disabled={disabled}
          >
            <ScrollText aria-hidden />
            Snippet
          </Button>
        }
      />
      <PopoverContent align="start" className="w-80 p-1">
        {snippets.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No snippets yet. Add them in Settings → Snippets.
          </p>
        ) : (
          <ul
            role="listbox"
            aria-label="Snippets"
            className="max-h-64 overflow-y-auto"
          >
            {snippets.map((snippet) => {
              // Distinct ids only: a repeated variable is one prompt, so
              // the hint counts prompts the same way insertion does.
              const variableIds = snippetVariableIdsInBody(snippet.body)
              return (
                <li key={snippet.id}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full flex-col items-start gap-0.5 px-2 py-1.5"
                    aria-label={`Insert ${snippet.name}`}
                    onClick={() => {
                      if (!editor) return
                      insertSnippetBody(editor, snippet.body)
                      setOpen(false)
                    }}
                  >
                    <span className="flex w-full items-center gap-2">
                      <span className="min-w-0 truncate text-[0.8rem] font-medium">
                        {snippet.name}
                      </span>
                      {snippet.shortcut ? (
                        <kbd className="inline-flex min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-foreground">
                          {snippet.shortcut}
                        </kbd>
                      ) : null}
                    </span>
                    <span className="w-full truncate text-xs font-normal text-muted-foreground">
                      {snippet.body}
                    </span>
                    {variableIds.length > 0 && (
                      <span
                        data-testid="snippet-variable-hint"
                        className="w-full truncate text-xs font-normal text-muted-foreground"
                      >
                        {variableIds.length}{" "}
                        {variableIds.length === 1 ? "variable" : "variables"} —
                        you'll be asked for any we can't fill
                      </span>
                    )}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
