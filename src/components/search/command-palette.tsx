import { useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import {
  CircleHelp,
  Search,
  Settings,
  SquarePen,
  Tag,
  UserRound,
  Zap,
} from "lucide-react"

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { FOLDER_ITEMS } from "@/components/layout/folders"
import { ProviderIcon } from "@/components/providers/provider-icon"
import { filterByFuzzy } from "@/lib/fuzzy-match"
import { brandForAccount } from "@/services/account-flows"
import {
  currentQuickStepTargets,
  runQuickStepWithConfirm,
} from "@/services/quick-steps/run-with-confirm"
import { useAccountStore } from "@/stores/account-store"
import { usePaletteStore } from "@/stores/palette-store"
import { useUiStore } from "@/stores/ui-store"
import { usePaletteLabels } from "./use-palette-labels"
import { usePaletteQuickSteps } from "./use-palette-quick-steps"

/**
 * The command palette (task 6.7): a Cmd/Ctrl+K dialog with fuzzy search
 * over actions (compose, search mail, settings), quick steps (task 3.2 —
 * one "Run quick step" entry per chain, run against the current
 * selection or the active thread), the seven system folders, the active
 * account's user labels and account switching.
 *
 * Self-contained by design — nothing here registers keybindings or mounts
 * itself. Shell integration (later task) is: render <CommandPalette />
 * once and toggle usePaletteStore (the global Cmd/Ctrl+K binding lives in
 * the 6.6 shortcuts hook).
 *
 * Rendering uses the shadcn `command` primitive (cmdk) with its built-in
 * filter disabled: filtering and ranking go through the pure scorer in
 * src/lib/fuzzy-match.ts so matches rank prefix > contiguous >
 * subsequence across both labels and keywords. cmdk keeps arrow-key
 * navigation, Enter selection and the roving highlight; Base UI's dialog
 * supplies Escape/backdrop dismissal and focus handling.
 */

type PaletteGroup =
  | "actions"
  | "quick-steps"
  | "folders"
  | "labels"
  | "accounts"

const GROUP_ORDER: PaletteGroup[] = [
  "actions",
  "quick-steps",
  "folders",
  "labels",
  "accounts",
]

const GROUP_HEADINGS: Record<PaletteGroup, string> = {
  actions: "Actions",
  "quick-steps": "Quick steps",
  folders: "Folders",
  labels: "Labels",
  accounts: "Accounts",
}

interface PaletteItem {
  id: string
  group: PaletteGroup
  label: string
  keywords: string[]
  /** Lucide icon, or a brand-glyph component for account entries. */
  icon: LucideIcon | ((props: { className?: string }) => ReactNode)
  /** Side effect when selected; closing the palette happens after run. */
  run: () => void
}

export function CommandPalette() {
  const open = usePaletteStore((state) => state.open)
  const setOpen = usePaletteStore((state) => state.setOpen)
  const [query, setQuery] = useState("")

  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const accounts = useAccountStore((state) => state.accounts)
  const labels = usePaletteLabels(activeAccountId)
  // Quick steps (task 3.2): re-read on every open, so a settings edit
  // shows up on the next Cmd/Ctrl+K.
  const quickSteps = usePaletteQuickSteps(open)

  // Autofocus: the cmdk input is portaled by the dialog, and Base UI
  // moves focus to the popup after mount, so focus the input one frame
  // later (no-op if the dialog was already closed again). The same frame
  // starts a fresh query session, so reopening never shows stale text.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      setQuery("")
      const input = document.querySelector<HTMLInputElement>(
        '[data-slot="command-input"]'
      )
      input?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  const items = useMemo<PaletteItem[]>(() => {
    const actionItems: PaletteItem[] = [
      {
        id: "action-compose",
        group: "actions",
        label: "Compose new message",
        keywords: ["compose", "write", "new", "email"],
        icon: SquarePen,
        run: () => useUiStore.getState().setComposerOpen(true),
      },
      {
        id: "action-search",
        group: "actions",
        label: "Search mail",
        keywords: ["search", "find", "query", "messages"],
        icon: Search,
        run: () =>
          useUiStore
            .getState()
            .setView({ kind: "search", query: query.trim() }),
      },
      {
        id: "action-settings",
        group: "actions",
        label: "Open settings",
        keywords: ["settings", "preferences"],
        icon: Settings,
        run: () => useUiStore.getState().setView({ kind: "settings" }),
      },
      {
        // The help-menu entry (task 2.9): the app has no OS menu bar, so
        // the palette command stands in for it, opening the bundled help
        // center dialog (ui-store.helpCenterOpen drives the shell mount).
        id: "action-help",
        group: "actions",
        label: "Open help center",
        keywords: ["help", "support", "guide", "documentation", "faq"],
        icon: CircleHelp,
        run: () => useUiStore.getState().setHelpCenterOpen(true),
      },
    ]
    const quickStepItems: PaletteItem[] = quickSteps.map((step) => ({
      id: `quick-step-${step.id}`,
      group: "quick-steps",
      label: `Run quick step: ${step.name}`,
      keywords: ["quick", "step", "run", ...step.name.split(/\s+/)],
      icon: Zap,
      run: () => {
        // Current selection, else the open thread (the same targeting the
        // context-menu entry and the digit shortcut use); the shared
        // runner owns the confirm-once gate and the toast.
        void runQuickStepWithConfirm(step, currentQuickStepTargets())
      },
    }))
    const folderItems: PaletteItem[] = FOLDER_ITEMS.map((folder) => ({
      id: `folder-${folder.countKey}`,
      group: "folders",
      label: folder.title,
      keywords: [folder.countKey],
      icon: folder.icon,
      run: () =>
        useUiStore
          .getState()
          .setView({ kind: "folder", folder: folder.folder }),
    }))
    const labelItems: PaletteItem[] = labels.map((label) => ({
      id: `label-${label.id}`,
      group: "labels",
      label: label.name,
      keywords: label.name.split("/"),
      icon: Tag,
      run: () =>
        useUiStore
          .getState()
          .setView({ kind: "label", labelId: label.id, name: label.name }),
    }))
    const accountItems: PaletteItem[] = accounts.map((account) => {
      const brand = brandForAccount(account.type, account.email)
      return {
        id: `account-${account.id}`,
        group: "accounts",
        label: `Switch to ${account.email}`,
        keywords: ["switch", "account", account.email],
        // Brand glyph when the provider is known; generic user icon
        // otherwise (unchanged behavior for custom domains).
        icon: brand
          ? ({ className }: { className?: string }) => (
              <ProviderIcon provider={brand} className={className} />
            )
          : UserRound,
        run: () => {
          void useAccountStore.getState().setActive(account.id)
        },
      }
    })
    return [
      ...actionItems,
      ...quickStepItems,
      ...folderItems,
      ...labelItems,
      ...accountItems,
    ]
  }, [accounts, labels, quickSteps, query])

  const visibleItems = useMemo(
    () => filterByFuzzy(items, query, (item) => [item.label, ...item.keywords]),
    [items, query]
  )

  const groups = useMemo(() => {
    const byGroup = new Map<PaletteGroup, PaletteItem[]>()
    for (const item of visibleItems) {
      const list = byGroup.get(item.group)
      if (list) {
        list.push(item)
      } else {
        byGroup.set(item.group, [item])
      }
    }
    return GROUP_ORDER.map((group) => ({
      group,
      items: byGroup.get(group) ?? [],
    })).filter((entry) => entry.items.length > 0)
  }, [visibleItems])

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <Command shouldFilter={false} loop>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search mail or jump to a folder, label, account…"
        />
        <CommandList>
          {groups.map(({ group, items: groupItems }) => (
            <CommandGroup key={group} heading={GROUP_HEADINGS[group]}>
              {groupItems.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  onSelect={() => {
                    item.run()
                    setOpen(false)
                  }}
                >
                  <item.icon className="text-muted-foreground" />
                  <span className="truncate">{item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          {groups.length === 0 && (
            <CommandEmpty>No matching commands</CommandEmpty>
          )}
        </CommandList>
      </Command>
      <div className="flex items-center gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
        <span>↑↓ navigate</span>
        <span>↵ select</span>
        <span>esc close</span>
      </div>
    </CommandDialog>
  )
}
