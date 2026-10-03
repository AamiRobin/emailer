/// <reference types="vitest/config" />
import { readFileSync } from "node:fs"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

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

/**
 * POST /__live-ai-proxy — the mock harness's live-AI relay (mock dev
 * mode only; see liveAiChat in src/mocks/tauri-core.ts). Relays the
 * JSON-encoded request `{ url, headers, body }` to any http(s) endpoint
 * and answers `{ status, text }` (status 0 = the relay itself could not
 * complete the upstream fetch). Dev-server-local by construction.
 */
function liveAiProxy(): Plugin {
  return {
    name: "mock-live-ai-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__live-ai-proxy", (req, res) => {
        const chunks: Buffer[] = []
        req.on("data", (chunk: Buffer) => chunks.push(chunk))
        req.on("end", async () => {
          const answer = (status: number, text: string): void => {
            res.statusCode = 200
            res.setHeader("content-type", "application/json")
            res.end(JSON.stringify({ status, text }))
          }
          try {
            const parsed = JSON.parse(
              Buffer.concat(chunks).toString("utf-8")
            ) as {
              url?: unknown
              headers?: unknown
              body?: unknown
            }
            const target = typeof parsed.url === "string" ? parsed.url : ""
            if (!/^https?:\/\//i.test(target)) {
              answer(400, "relay target must be an http(s) URL")
              return
            }
            const upstream = await fetch(target, {
              method: "POST",
              headers:
                typeof parsed.headers === "object" && parsed.headers !== null
                  ? (parsed.headers as Record<string, string>)
                  : {},
              body: typeof parsed.body === "string" ? parsed.body : "",
              signal: AbortSignal.timeout(120_000),
            })
            answer(upstream.status, await upstream.text())
          } catch (error) {
            answer(
              0,
              error instanceof Error ? error.message : String(error)
            )
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    // Mock-mode-only relay for the ?liveAi=1 harness (src/mocks/
    // tauri-core.ts liveAiChat): the browser's fetch is CORS-bound, so
    // gateways that send no Access-Control-Allow-Origin are unreachable
    // from the page. The real app's HTTP client is Rust-side and has no
    // such restriction; this middleware stands in for it in the browser
    // by relaying { url, headers, body } and returning { status, text }.
    mode === "mock" && liveAiProxy(),
  ].filter(Boolean),
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
      // Two entries: the app shell and the static splash screen (task 1.7)
      // the splash window loads directly from dist/splashscreen.html.
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        splashscreen: path.resolve(import.meta.dirname, "splashscreen.html"),
      },
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
    setupFiles: ["./vitest.setup.ts"],
  },
}))
