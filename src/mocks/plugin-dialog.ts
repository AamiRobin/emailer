import { installMockHarness } from "./index"

/**
 * Mock @tauri-apps/plugin-dialog (mock dev mode only): every picker
 * resolves null, i.e. "the user cancelled" — the flows calling these
 * already treat null as a no-op.
 */

export interface MockDialogOpenOptions {
  multiple?: boolean
  directory?: boolean
  filters?: { name: string; extensions: string[] }[]
}

export async function open(
  _options?: MockDialogOpenOptions
): Promise<string | string[] | null> {
  void _options
  installMockHarness()
  return null
}

export async function save(_options?: {
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}): Promise<string | null> {
  void _options
  installMockHarness()
  return null
}

export async function message(
  message: string,
  _options?: { title?: string; kind?: string }
): Promise<void> {
  void _options
  installMockHarness()
  console.info(`[mock dialog] ${message}`)
}

export async function ask(
  _message: string,
  _options?: { title?: string; kind?: string }
): Promise<boolean> {
  void _message
  void _options
  installMockHarness()
  return false
}

export async function confirm(
  _message: string,
  _options?: { title?: string; kind?: string }
): Promise<boolean> {
  void _message
  void _options
  installMockHarness()
  return false
}
