import { create } from "zustand"

/**
 * Command-palette open state (task 6.7). Deliberately the only thing the
 * palette owns globally: the content is a self-contained component
 * (src/components/search/command-palette.tsx) that the shell mounts once.
 *
 * The global Cmd/Ctrl+K keybinding lives in the shortcuts hook (task 6.6)
 * and toggles this store — the palette never registers keybindings of its
 * own, so importing { usePaletteStore } + rendering <CommandPalette /> is
 * the whole integration contract.
 */
interface PaletteState {
  open: boolean
  setOpen: (open: boolean) => void
  close: () => void
}

export const usePaletteStore = create<PaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  close: () => set({ open: false }),
}))
