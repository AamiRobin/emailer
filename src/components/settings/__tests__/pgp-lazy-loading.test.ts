// @vitest-environment node
import { describe, expect, it } from "vitest"

/**
 * Lazy-load guard for the settings graph (task 18.7, design D11). The
 * pgp-transform/pgp-keys suites scan a single crypto file for a static
 * openpgp import; this suite pins the same discipline one level up — the
 * whole STATIC import graph of settings-page.tsx must stay free of
 * openpgp and of the crypto/pgp-* modules. The encryption section is
 * allowed to reach the key service only through its loadPgpKeys()
 * dynamic import(), which fires after the per-account enable toggle goes
 * on, so users who keep PGP off never pay for the PGP (or openpgp)
 * chunks — the settings chunk cannot even reference them statically.
 *
 * Scans source text obtained through vite's import.meta.glob with the
 * `?raw` query (the same mechanism the crypto suites use for their
 * single-file scans): every src file's source is inlined eagerly, keyed
 * by its /src-relative path — no node fs needed. Local @/ and relative
 * specifiers are resolved against that map to walk the graph
 * transitively. Type-only imports are erased at build time (they cannot
 * pull a chunk) and dynamic import() calls ARE the lazy boundary — both
 * are stripped before scanning.
 */

/** Every src file's source text, inlined by vite's `?raw` glob, keyed by
 * the normalized (leading-slash-stripped) /src-relative path. */
const SOURCES = new Map<string, string>()
for (const [key, source] of Object.entries({
  ...import.meta.glob("/src/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("/src/**/*.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
})) {
  SOURCES.set(key.replace(/^\/+/, ""), source)
}

/** A file's source text (readFileSync's replacement over the raw map). */
function readSource(file: string): string {
  const source = SOURCES.get(file)
  if (source === undefined) {
    throw new Error(`source not inlined by the ?raw glob: ${file}`)
  }
  return source
}

/** The directory part of a normalized path ("" for top-level files). */
function dirnameOf(file: string): string {
  const cut = file.lastIndexOf("/")
  return cut === -1 ? "" : file.slice(0, cut)
}

/** Join a base directory and a relative specifier, collapsing "." and
 * ".." segments (path.resolve's replacement for /src-relative paths). */
function resolvePath(baseDir: string, specifier: string): string {
  const segments = `${baseDir}/${specifier}`.split("/")
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") resolved.pop()
    else resolved.push(segment)
  }
  return resolved.join("/")
}

const SETTINGS_PAGE = "src/components/settings/settings-page.tsx"
const PGP_SECTION = "src/components/settings/pgp-section.tsx"
const PGP_KEYS = "src/services/crypto/pgp-keys.ts"

/** Specifiers that must never appear as a static value import anywhere in
 * the settings graph: openpgp itself, or any PGP crypto module. */
const FORBIDDEN_SPECIFIER_PARTS = ["openpgp", "crypto/pgp-"]

function staticValueImportSpecifiers(source: string): string[] {
  // Erase type-only import statements (build-time erased) and blind the
  // dynamic import( boundaries (incl. `typeof import(...)` type queries)
  // so they can neither match nor fuse statements in the scans below.
  const cleaned = source
    .replace(/^[ \t]*import\s+type\b[\s\S]*?["'][^"']+["'][^\n]*\n/gm, "")
    .replace(/\bimport\s*\(/g, "import_(")

  const specifiers = new Set<string>()
  for (const match of cleaned.matchAll(
    /^[ \t]*import\b[\s\S]*?from\s*["']([^"']+)["']/gm
  )) {
    specifiers.add(match[1]!)
  }
  for (const match of cleaned.matchAll(/^[ \t]*import\s*["']([^"']+)["']/gm)) {
    specifiers.add(match[1]!)
  }
  return [...specifiers]
}

/** Resolve a local specifier to a keyed source file, or null for bare
 * packages (node_modules — openpgp would show up as the bare "openpgp"
 * and is checked as a specifier directly). */
function resolveLocalImport(
  fromFile: string,
  specifier: string
): string | null {
  const isAlias = specifier.startsWith("@/")
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../")
  if (!isAlias && !isRelative) return null
  const base = isAlias
    ? resolvePath("src", specifier.slice(2))
    : resolvePath(dirnameOf(fromFile), specifier)
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (SOURCES.has(candidate)) {
      return candidate
    }
  }
  return null
}

/** BFS over the static value imports of `entry`: file → its specifiers.
 * `exclude` drops one file (and thus its whole subtree) from the walk. */
function collectStaticGraph(
  entry: string,
  exclude?: string
): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (file === exclude || graph.has(file)) continue
    const specifiers: string[] = []
    for (const specifier of staticValueImportSpecifiers(readSource(file))) {
      specifiers.push(specifier)
      const resolved = resolveLocalImport(file, specifier)
      if (resolved) queue.push(resolved)
    }
    graph.set(file, specifiers)
  }
  return graph
}

function findForbiddenViolations(graph: Map<string, string[]>): string[] {
  const violations: string[] = []
  for (const [file, specifiers] of graph) {
    for (const specifier of specifiers) {
      if (FORBIDDEN_SPECIFIER_PARTS.some((part) => specifier.includes(part))) {
        violations.push(`${file} → ${specifier}`)
      }
    }
  }
  return violations
}

/**
 * The settings graph carries ONE pre-existing edge into the composer send
 * pipeline: preferences.ts reuses undo-send.ts's send-delay clamp, and
 * undo-send → composer/send (task 18.5) statically imports crypto/pgp-keys
 * for the send path (mime-builder → crypto/pgp-transform likewise). That
 * edge predates task 18.7, lives in composer files this task does not own,
 * and still never loads openpgp statically (asserted over the FULL graph
 * below). What task 18.7 must guarantee is that the PGP section adds NO
 * path of its own — which the undo-send-excluded graph pins: without that
 * pre-existing subtree, no crypto/pgp-* module is statically reachable.
 */
const PRE_EXISTING_SEND_CHAIN_ENTRY = "src/services/composer/undo-send.ts"

const fullGraph = collectStaticGraph(SETTINGS_PAGE)
const graphWithoutSendChain = collectStaticGraph(
  SETTINGS_PAGE,
  PRE_EXISTING_SEND_CHAIN_ENTRY
)
const fullGraphViolations = findForbiddenViolations(fullGraph)
const openpgpOnlyViolations = findForbiddenViolations(fullGraph).filter(
  (violation) => violation.includes("openpgp")
)

describe("settings page lazy-load graph (design D11)", () => {
  it("never statically imports openpgp anywhere in the graph", () => {
    // The heavy chunk: no file reachable from the settings page — the
    // composer send chain included — may pull openpgp statically.
    expect(openpgpOnlyViolations).toEqual([])
  })

  it("adds no static path into the PGP crypto modules from the section", () => {
    expect(fullGraphViolations).not.toEqual([])
    expect(findForbiddenViolations(graphWithoutSendChain)).toEqual([])
  })

  it("guards the pgp section but excludes the key service from the graph", () => {
    // Sanity: the section IS in the scanned graph (the guard is real),
    // while the key service is not — it is only ever reached dynamically
    // (the send chain's crypto/pgp-keys import lives outside this graph).
    expect(graphWithoutSendChain.has(PGP_SECTION)).toBe(true)
    expect(graphWithoutSendChain.has(PGP_KEYS)).toBe(false)
  })

  it("reaches the key service only through the dynamic import boundary", () => {
    const source = readSource(PGP_SECTION)
    // No static reference to the crypto module at all (value or type —
    // the summary types come from `typeof import(...)` queries).
    expect(source).not.toMatch(/from\s*["'][^"']*crypto\/pgp-keys["']/)
    expect(staticValueImportSpecifiers(source)).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("crypto/pgp-"),
        "openpgp",
      ])
    )
    // …and the boundary is actually there.
    expect(source).toContain('import("@/services/crypto/pgp-keys")')
  })

  it("keeps the chain's last hop dynamic: pgp-keys loads openpgp lazily", () => {
    const source = readSource(PGP_KEYS)
    expect(staticValueImportSpecifiers(source)).not.toContain("openpgp")
    expect(source).toContain('import("openpgp")')
  })
})
