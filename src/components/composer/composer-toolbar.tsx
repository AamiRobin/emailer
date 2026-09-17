import { useState, type FormEvent } from "react"
import type { Editor } from "@tiptap/react"
import { useEditorState } from "@tiptap/react"
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  FileSignature,
  Italic,
  Link2,
  List,
  ListOrdered,
  Lock,
  Underline as UnderlineIcon,
} from "lucide-react"
import type { ReactNode } from "react"

import type { SnippetRow } from "@/services/db/snippets"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Toggle } from "@/components/ui/toggle"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { SnippetPicker } from "./snippet-picker"

/**
 * Formatting toolbar for the TipTap composer body (task 8.2). Buttons are
 * Toggle primitives wired to editor chain commands; pressed state derives
 * from the editor through `useEditorState` so marks/lists/alignment
 * reflect the cursor position reactively. Link insertion runs through a
 * popover prompting for the URL (with unlink when a link is active).
 * The editor routes the resulting HTML into composer-store (task 8.2:
 * "applies and serializes into the sent HTML").
 *
 * Task 6.2: a trailing "Snippet" entry opens the snippet picker; picking
 * a snippet inserts its body at the cursor (snippet-picker.tsx).
 *
 * Task 18.5: trailing "Sign (PGP)" / "Encrypt (PGP)" toggles set the
 * PER-MESSAGE PGP intent (composer store, not an account setting); the
 * send flow turns them into RFC 3156 PGP/MIME. Unlike the formatting
 * toggles they do not depend on the editor state.
 */

interface ComposerToolbarProps {
  editor: Editor | null
  /** Global snippets for the picker (loaded by the composer view). */
  snippets: SnippetRow[]
  /** Per-message PGP toggles (task 18.5) and their store flips. */
  pgpSign: boolean
  pgpEncrypt: boolean
  onTogglePgpSign: () => void
  onTogglePgpEncrypt: () => void
}

/** Prepend https:// to scheme-less URLs; empty stays empty. */
function normalizeLinkUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return ""
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  return `https://${value}`
}

function ToolbarToggle({
  label,
  pressed,
  disabled,
  onToggle,
  children,
}: {
  label: string
  pressed: boolean
  disabled: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            size="sm"
            aria-label={label}
            pressed={pressed}
            disabled={disabled}
            onPressedChange={onToggle}
          >
            {children}
          </Toggle>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

export function ComposerToolbar({
  editor,
  snippets,
  pgpSign,
  pgpEncrypt,
  onTogglePgpSign,
  onTogglePgpEncrypt,
}: ComposerToolbarProps) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState("")

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            underline: e.isActive("underline"),
            bulletList: e.isActive("bulletList"),
            orderedList: e.isActive("orderedList"),
            link: e.isActive("link"),
            alignLeft: e.isActive({ textAlign: "left" }),
            alignCenter: e.isActive({ textAlign: "center" }),
            alignRight: e.isActive({ textAlign: "right" }),
          }
        : null,
  })

  const disabled = editor === null
  const chain = () => editor?.chain().focus()

  const handleLinkOpenChange = (open: boolean) => {
    setLinkOpen(open)
    if (open) {
      // Pre-fill with the existing href when editing a link.
      const current = editor?.getAttributes("link").href
      setLinkUrl(typeof current === "string" ? current : "")
    }
  }

  const applyLink = (event: FormEvent) => {
    event.preventDefault()
    const href = normalizeLinkUrl(linkUrl)
    if (!href || !editor) return
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run()
    setLinkOpen(false)
  }

  const removeLink = () => {
    editor?.chain().focus().extendMarkRange("link").unsetLink().run()
    setLinkOpen(false)
  }

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex flex-wrap items-center gap-0.5 px-3 py-1.5"
    >
      <ToolbarToggle
        label="Bold"
        pressed={active?.bold ?? false}
        disabled={disabled}
        onToggle={() => chain()?.toggleBold().run()}
      >
        <Bold />
      </ToolbarToggle>
      <ToolbarToggle
        label="Italic"
        pressed={active?.italic ?? false}
        disabled={disabled}
        onToggle={() => chain()?.toggleItalic().run()}
      >
        <Italic />
      </ToolbarToggle>
      <ToolbarToggle
        label="Underline"
        pressed={active?.underline ?? false}
        disabled={disabled}
        onToggle={() => chain()?.toggleUnderline().run()}
      >
        <UnderlineIcon />
      </ToolbarToggle>

      <Separator orientation="vertical" className="mx-1 h-5" />

      <ToolbarToggle
        label="Bullet list"
        pressed={active?.bulletList ?? false}
        disabled={disabled}
        onToggle={() => chain()?.toggleBulletList().run()}
      >
        <List />
      </ToolbarToggle>
      <ToolbarToggle
        label="Numbered list"
        pressed={active?.orderedList ?? false}
        disabled={disabled}
        onToggle={() => chain()?.toggleOrderedList().run()}
      >
        <ListOrdered />
      </ToolbarToggle>

      <Separator orientation="vertical" className="mx-1 h-5" />

      <Popover open={linkOpen} onOpenChange={handleLinkOpenChange}>
        <PopoverTrigger
          render={
            <Toggle
              size="sm"
              aria-label="Insert link"
              pressed={active?.link ?? false}
              disabled={disabled}
            >
              <Link2 />
            </Toggle>
          }
        />
        <PopoverContent className="w-80">
          <form className="flex flex-col gap-2.5" onSubmit={applyLink}>
            <Input
              value={linkUrl}
              onChange={(event) => setLinkUrl(event.target.value)}
              placeholder="https://example.com"
              aria-label="Link URL"
              autoFocus
            />
            <div className="flex items-center justify-end gap-1.5">
              {active?.link ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={removeLink}
                >
                  Remove link
                </Button>
              ) : null}
              <Button type="submit" size="sm" disabled={!linkUrl.trim()}>
                Apply link
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>

      <Separator orientation="vertical" className="mx-1 h-5" />

      <ToolbarToggle
        label="Align left"
        pressed={active?.alignLeft ?? false}
        disabled={disabled}
        onToggle={() => chain()?.setTextAlign("left").run()}
      >
        <AlignLeft />
      </ToolbarToggle>
      <ToolbarToggle
        label="Align center"
        pressed={active?.alignCenter ?? false}
        disabled={disabled}
        onToggle={() => chain()?.setTextAlign("center").run()}
      >
        <AlignCenter />
      </ToolbarToggle>
      <ToolbarToggle
        label="Align right"
        pressed={active?.alignRight ?? false}
        disabled={disabled}
        onToggle={() => chain()?.setTextAlign("right").run()}
      >
        <AlignRight />
      </ToolbarToggle>

      <Separator orientation="vertical" className="mx-1 h-5" />

      {/* Task 18.5: per-message PGP intent. Editor-independent — the
          toggles write composer-store, the send flow applies them. */}
      <ToolbarToggle
        label="Sign (PGP)"
        pressed={pgpSign}
        disabled={false}
        onToggle={onTogglePgpSign}
      >
        <FileSignature />
      </ToolbarToggle>
      <ToolbarToggle
        label="Encrypt (PGP)"
        pressed={pgpEncrypt}
        disabled={false}
        onToggle={onTogglePgpEncrypt}
      >
        <Lock />
      </ToolbarToggle>

      {/* Task 6.2: at-cursor snippet insertion. */}
      <SnippetPicker editor={editor} snippets={snippets} disabled={disabled} />
    </div>
  )
}
