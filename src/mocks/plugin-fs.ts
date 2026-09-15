import { installMockHarness } from "./index"

/**
 * Mock @tauri-apps/plugin-fs (mock dev mode only): an in-memory file
 * store keyed by absolute path. Binary and text helpers share one Map so
 * the credential key file (credentials.key, written through
 * writeTextFile + rename by key-management.ts) is readable back by
 * exists/readTextFile — the AES key round-trips inside the mock.
 */

const files = new Map<string, Uint8Array>()

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function bytesText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** Absolute path of a request, resolving the AppData base like the plugin. */
function resolvePath(path: string, baseDir?: string): string {
  if (!baseDir) return path
  return `${appDataPath()}/${path}`
}

export function appDataPath(): string {
  return "/mock/appdata"
}

export const BaseDirectory = {
  AppData: "appdata",
  AppCache: "appcache",
  AppLocalData: "applocaldata",
  AppLog: "applog",
  Audio: "audio",
  Cache: "cache",
  Config: "config",
  Data: "data",
  Desktop: "desktop",
  Document: "document",
  Download: "download",
  Home: "home",
  LocalData: "localdata",
  Picture: "picture",
  Public: "public",
  Resource: "resource",
  Runtime: "runtime",
  Temp: "temp",
  Template: "template",
  Video: "video",
} as const

export type BaseDirectory = (typeof BaseDirectory)[keyof typeof BaseDirectory]

export interface ReadFileOptions {
  baseDir?: BaseDirectory
}

export interface WriteFileOptions {
  baseDir?: BaseDirectory
  create?: boolean
  createNew?: boolean
  append?: boolean
}

export interface MkdirOptions {
  baseDir?: BaseDirectory
  recursive?: boolean
}

export interface RemoveOptions {
  baseDir?: BaseDirectory
  recursive?: boolean
}

export interface ExistsOptions {
  baseDir?: BaseDirectory
}

export async function readFile(
  path: string,
  options?: ReadFileOptions
): Promise<Uint8Array> {
  installMockHarness()
  const stored = files.get(resolvePath(path, options?.baseDir))
  if (!stored) {
    throw new Error(`[mock] fs: file not found: ${path}`)
  }
  return stored.slice()
}

export async function readTextFile(
  path: string,
  options?: ReadFileOptions
): Promise<string> {
  return bytesText(await readFile(path, options))
}

export async function writeFile(
  path: string,
  contents: Uint8Array,
  options?: WriteFileOptions
): Promise<void> {
  installMockHarness()
  files.set(resolvePath(path, options?.baseDir), contents.slice())
}

export async function writeTextFile(
  path: string,
  contents: string,
  options?: WriteFileOptions
): Promise<void> {
  await writeFile(path, textBytes(contents), options)
}

export async function mkdir(
  path: string,
  _options?: MkdirOptions
): Promise<void> {
  // Directories are implicit in the flat in-memory store.
  void path
  void _options
}

export async function remove(
  path: string,
  _options?: RemoveOptions
): Promise<void> {
  installMockHarness()
  files.delete(resolvePath(path, _options?.baseDir))
}

export async function exists(
  path: string,
  options?: ExistsOptions
): Promise<boolean> {
  installMockHarness()
  return files.has(resolvePath(path, options?.baseDir))
}

export interface RenameOptions {
  oldPathBaseDir?: BaseDirectory
  newPathBaseDir?: BaseDirectory
}

export async function rename(
  oldPath: string,
  newPath: string,
  options?: RenameOptions
): Promise<void> {
  installMockHarness()
  const key = resolvePath(oldPath, options?.oldPathBaseDir)
  const stored = files.get(key)
  if (!stored) {
    throw new Error(`[mock] fs: file not found: ${oldPath}`)
  }
  files.set(resolvePath(newPath, options?.newPathBaseDir), stored)
  files.delete(key)
}
