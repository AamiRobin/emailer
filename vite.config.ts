/// <reference types="vitest/config" />
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

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
