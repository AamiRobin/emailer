/// <reference types="vitest/config" />
import { readFileSync } from "node:fs"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// App version for the status bar: src-tauri/tauri.conf.json is the
// authoritative version for a Tauri desktop build (it is what the
// packaged binary reports), so it is injected at build time instead of
// duplicated in a component.
const APP_VERSION = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "./src-tauri/tauri.conf.json"), "utf-8")
).version as string

// Dev-only mock harness (bun run dev:mock): in "mock" mode the Tauri
// modules are redirected to in-browser fakes under src/mocks/ so the UI
// runs against an in-memory SQLite seeded with fixture mail. Every other
// mode (plain dev, build, tauri dev) resolves the real packages exactly
// as before — the alias map is empty there.
const MOCK_ALIASES: Record<string, string> = {
  "@tauri-apps/plugin-sql": path.resolve(
    import.meta.dirname,
    "./src/mocks/plugin-sql.ts"
  ),
  "@tauri-apps/api/core": path.resolve(
    import.meta.dirname,
    "./src/mocks/tauri-core.ts"
  ),
  "@tauri-apps/api/path": path.resolve(
    import.meta.dirname,
    "./src/mocks/tauri-path.ts"
  ),
  "@tauri-apps/plugin-dialog": path.resolve(
    import.meta.dirname,
    "./src/mocks/plugin-dialog.ts"
  ),
  "@tauri-apps/plugin-fs": path.resolve(
    import.meta.dirname,
    "./src/mocks/plugin-fs.ts"
  ),
  "@tauri-apps/plugin-opener": path.resolve(
    import.meta.dirname,
    "./src/mocks/plugin-opener.ts"
  ),
  "@tauri-apps/plugin-notification": path.resolve(
    import.meta.dirname,
    "./src/mocks/plugin-notification.ts"
  ),
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      ...(mode === "mock" ? MOCK_ALIASES : {}),
    },
  },
  // sqlite-wasm must stay out of dep pre-bundling: its ESM entry locates
  // sqlite3.wasm via import.meta.url, which only resolves when the package
  // is served as-is from node_modules.
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // React must be a single chunk shared by the entry and every
            // lazy chunk (Composer, SettingsPage): left to default chunking,
            // rolldown duplicated react/react-dom across the entry and the
            // async chunks, so the lazy components called hooks against a
            // second React instance ("Invalid hook call" in the packaged
            // app — invisible to vitest, which bundles one module graph).
            {
              name: "react-vendor",
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 3000,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
}))
