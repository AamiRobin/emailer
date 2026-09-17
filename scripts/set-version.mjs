#!/usr/bin/env node
/**
 * Release tooling: set the app version in every source of truth at once —
 * package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml.
 *
 * The release flow (docs/releases.md, README "Releases") requires the app
 * version to equal the git tag exactly (v0.2.0-beta.1 ⇔ version
 * "0.2.0-beta.1"), because tauri-action derives the release tag from the
 * app version. Run before every release commit:
 *
 *   node scripts/set-version.mjs 0.2.0-beta.1
 *   npm run version:set -- 0.2.0
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(
    "Usage: node scripts/set-version.mjs <semver>  e.g. 0.2.0 or 0.2.0-beta.1"
  )
  process.exit(1)
}

const root = resolve(import.meta.dirname, "..")

function editJson(relPath, apply) {
  const abs = resolve(root, relPath)
  const json = JSON.parse(readFileSync(abs, "utf8"))
  apply(json)
  writeFileSync(abs, JSON.stringify(json, null, 2) + "\n")
  console.log(`  ${relPath} → ${version}`)
}

function editCargo(relPath) {
  const abs = resolve(root, relPath)
  const text = readFileSync(abs, "utf8")
  // Only the [package] version (first `version = "..."` line).
  const next = text.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`)
  if (next === text) throw new Error(`no version line found in ${relPath}`)
  writeFileSync(abs, next)
  console.log(`  ${relPath} → ${version}`)
}

editJson("package.json", (json) => {
  json.version = version
})
editJson("src-tauri/tauri.conf.json", (json) => {
  json.version = version
})
editCargo("src-tauri/Cargo.toml")

console.log(`\nVersion set to ${version}. Commit this, then tag v${version}.`)
