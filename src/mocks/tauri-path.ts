import { installMockHarness } from "./index"

/**
 * Mock @tauri-apps/api/path (mock dev mode only): fixed POSIX-style paths
 * under /mock; join() uses "/" always.
 */

export async function appDataDir(): Promise<string> {
  installMockHarness()
  return "/mock/appdata"
}

export async function join(...parts: string[]): Promise<string> {
  installMockHarness()
  return parts
    .filter((part) => part !== "")
    .join("/")
    .replace(/\/{2,}/g, "/")
}

export async function dirname(path: string): Promise<string> {
  installMockHarness()
  const index = path.lastIndexOf("/")
  return index <= 0 ? "/" : path.slice(0, index)
}

export async function basename(path: string): Promise<string> {
  installMockHarness()
  const index = path.lastIndexOf("/")
  return index === -1 ? path : path.slice(index + 1)
}

export async function homeDir(): Promise<string> {
  installMockHarness()
  return "/mock/home"
}

export async function tempDir(): Promise<string> {
  installMockHarness()
  return "/mock/tmp"
}
