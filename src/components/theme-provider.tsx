/* eslint-disable react-refresh/only-export-components */
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes"
import type { ComponentProps } from "react"

type ThemeProviderProps = ComponentProps<typeof NextThemesProvider>

export { useTheme }

/**
 * Mode (light / dark / system) is handled by next-themes:
 * - `attribute="class"` toggles `light`/`dark` classes on `<html>`, matching
 *   the `@custom-variant dark` and `.dark` token sets in `src/index.css`
 *   (and the `html.dark` color-scheme sync there).
 * - `defaultTheme="system"` + `enableSystem` follow the OS setting live.
 * - `disableTransitionOnChange` suppresses transitions during the swap.
 * - Persists under the localStorage key "theme" (next-themes default), the
 *   same key the previous hand-rolled provider used, so stored values remain
 *   honored.
 *
 * Accent (color tint) is separate — see `src/lib/accent.ts`.
 */
export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}
