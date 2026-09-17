import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // .kilo: tool-managed git worktrees; src-tauri/target: Rust build output
  // (tauri embeds minified frontend assets as codegen .js during builds)
  globalIgnores(['dist', 'examples', 'openspec', '.kilo', 'src-tauri/target']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      // shadcn registry primitives legitimately export variant helpers
      // (buttonVariants, toggleVariants, …) next to components; D12 forbids
      // modifying them, so relax the fast-refresh rule for this directory.
      'react-refresh/only-export-components': 'off',
    },
  },
])
