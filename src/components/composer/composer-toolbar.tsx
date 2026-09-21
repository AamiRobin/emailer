import { useState, type FormEvent } from "react"
import type { Editor } from "@tiptap/react"
import { useEditorState } from "@tiptap/react"
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  FileSignature,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Lock,
  Redo2,
  Sparkles,
  Strikethrough,
  TextQuote,
  Underline as UnderlineIcon,
  Undo2,
} from "lucide-react"
import type { ReactNode } from "react"

import type { ComposeTransformMode } from "@/services/ai/compose-transform"
import type { SnippetRow } from "@/services/db/snippets"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { COMPOSE_TRANSFORM_LABELS } from "./compose-transform"
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
 *
 * Task 4.6 (ai-assistance spec, design D1): a trailing "AI" dropdown with
 * the three compose transforms (improve / shorten / formalize), rendered
 * ONLY when AI is configured and the composeTransform surface is enabled
 * (spec: unconfigured surfaces hide — the composer loads the flags once on
 * mount and passes `aiTransformAvailable` down). Running one hands the
 * mode to the composer, which captures the target and shows the pending
 * replacement bar; while a replacement is pending (`composeTransformPending`)
 * the menu disables so a second transform can't overlap the first.
 *
 * Batch C3 rounds the toolbar out with what TipTap already ships and the
 * editor config already enables (StarterKit's strike / blockquote / code
 * marks and its undo-redo extension — link and underline stay the only
 * disabled members): Undo/Redo lead the toolbar, Strikethrough and inline
 * Code join the marks group, Blockquote joins the lists group. Shortcuts
 * are TipTap's own v3 keymaps (no shortcut-registry entries) — Undo
 * Mod-z, Redo Mod-Shift-z, Strikethrough Mod-Shift-s, Code Mod-e,
 * Blockquote Mod-Shift-b; the tooltips carry the static hints and the
 * composer's own bindings (send, minimize) live on different chords and
 * never collide.
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
  /** AI configured AND the composeTransform surface enabled (task 4.6). */
  aiTransformAvailable: boolean
  /** A transform is pending (running/ready/errored) — one at a time. */
  composeTransformPending: boolean
  onComposeTransform: (mode: ComposeTransformMode) => void
  /** The draft's mode kind (batch C3): the AI menu's generative entries
   * branch on it — "Draft from prompt" is a new-compose affordance (it
   * writes a whole body; the transforms cover editing existing text),
   * "Generate reply" only exists for reply/forward drafts. */
  aiModeKind: "new" | "reply" | "forward"
  /** The reply/forward source thread for "Generate reply"; null hides the
   * item (no thread to draft from). */
  generateReplyThreadId: string | null
  onDraftFromPrompt: () => void
  onGenerateReply: () => void
  /** Inline image picker (batch C2): opens the image file dialog; the
   * composer owns the cap routing and the insertion. */
  onInsertImage: () => void
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

/**
 * The "AI" dropdown (task 4.6 + batch C3): one item per transform mode,
 * then the generative entries — "Draft from prompt" (new compose only; a
 * whole-body draft from the dialog's instruction, so it is disabled where
 * the transforms cover editing) and "Generate reply" (reply/forward only,
 * with a thread to draft from). Every offer lands in the composer's ONE
 * pending-replacement flow. Trigger disabled while a replacement is
 * pending — resolve (accept/discard) the current one first so two offers
 * can never target the same range.
 */
function ComposeTransformMenu({
  disabled,
  aiModeKind,
  generateReplyThreadId,
  onRun,
  onDraftFromPrompt,
  onGenerateReply,
}: {
  disabled: boolean
  aiModeKind: "new" | "reply" | "forward"
  generateReplyThreadId: string | null
  onRun: (mode: ComposeTransformMode) => void
  onDraftFromPrompt: () => void
  onGenerateReply: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label="AI transform"
            disabled={disabled}
          >
            <Sparkles aria-hidden />
            AI
          </Button>
        }
      />
      <DropdownMenuContent align="start" data-testid="compose-transform-menu">
        {(Object.keys(COMPOSE_TRANSFORM_LABELS) as ComposeTransformMode[]).map(
          (mode) => (
            <DropdownMenuItem
              key={mode}
              onClick={() => onRun(mode)}
              data-testid={`compose-transform-${mode}`}
            >
              {COMPOSE_TRANSFORM_LABELS[mode]}
            </DropdownMenuItem>
          )
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={aiModeKind !== "new"}
          onClick={onDraftFromPrompt}
          data-testid="ai-draft-from-prompt"
        >
          Draft from prompt…
        </DropdownMenuItem>
        {aiModeKind !== "new" && generateReplyThreadId !== null ? (
          <DropdownMenuItem
            onClick={onGenerateReply}
            data-testid="ai-generate-reply"
          >
            Generate reply
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ComposerToolbar({
  editor,
  snippets,
  pgpSign,
  pgpEncrypt,
  onTogglePgpSign,
  onTogglePgpEncrypt,
  aiTransformAvailable,
  composeTransformPending,
  onComposeTransform,
  aiModeKind,
  generateReplyThreadId,
  onDraftFromPrompt,
  onGenerateReply,
  onInsertImage,
}: ComposerToolbarProps) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState("")

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            canUndo: e.can().undo(),
            canRedo: e.can().redo(),
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            underline: e.isActive("underline"),
            strike: e.isActive("strike"),
            code: e.isActive("code"),
            bulletList: e.isActive("bulletList"),
            orderedList: e.isActive("orderedList"),
            blockquote: e.isActive("blockquote"),
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
      {/* Batch C3: editor history — StarterKit's undo-redo, gated by
          availability (nothing to undo/redo keeps the button dead). */}
      <ToolbarToggle
        label="Undo (Cmd/Ctrl+Z)"
        pressed={false}
        disabled={disabled || !(active?.canUndo ?? false)}
        onToggle={() => chain()?.undo().run()}
      >
        <Undo2 />
      </ToolbarToggle>
      <ToolbarToggle
        label="Redo (Cmd/Ctrl+Shift+Z)"
        pressed={false}
        disabled={disabled || !(active?.canRedo ?? false)}
        onToggle={() => chain()?.redo().run()}
      >
        <Redo2 />
      </ToolbarToggle>

      <Separator orientation="vertical" className="mx-1 h-5" />

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
      {/* Batch C3: the remaining StarterKit marks — strike's shortcut is
          TipTap v3's native Mod-Shift-s, inline code's is Mod-e. */}
      <ToolbarToggle
        label="Strikethrough (Cmd/Ctrl+Shift+S)"
        pressed={active?.strike ?? false}
        disabled={disabled}
        onToggle={() => chain()?.toggleStrike().run()}
      >
        <Strikethrough />
      </ToolbarToggle>
      <ToolbarToggle
        label="Inline code (Cmd/Ctrl+E)"
        pressed={active?.code ?? false}
        disabled={disabled}
        onToggle={() => chain()?.toggleCode().run()}
      >
        <Code />
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
      {/* Batch C3: blockquote lives with the other block-level toggles;
          shortcut is TipTap's native Mod-Shift-b. */}
      <ToolbarToggle
        label="Blockquote (Cmd/Ctrl+Shift+B)"
        pressed={active?.blockquote ?? false}
        disabled={disabled}
        onToggle={() => chain()?.toggleBlockquote().run()}
      >
        <TextQuote />
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

      {/* Batch C2: inline image — the system picker; insertion and the
          2 MB cap routing live in the composer (inline-image.ts). */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label="Insert image"
              title="Insert image"
              disabled={disabled}
              onClick={onInsertImage}
            >
              <ImageIcon aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="bottom">Insert image</TooltipContent>
      </Tooltip>

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

      {/* Task 4.6 + batch C3: compose transforms and generative offers —
          hidden unless AI is configured and the surface is enabled (spec:
          unconfigured surfaces hide instead of erroring). */}
      {aiTransformAvailable ? (
        <ComposeTransformMenu
          disabled={disabled || composeTransformPending}
          aiModeKind={aiModeKind}
          generateReplyThreadId={generateReplyThreadId}
          onRun={onComposeTransform}
          onDraftFromPrompt={onDraftFromPrompt}
          onGenerateReply={onGenerateReply}
        />
      ) : null}
    </div>
  )
}
