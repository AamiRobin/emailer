import { installMockHarness } from "./index"

/**
 * Mock @tauri-apps/plugin-opener (mock dev mode only): opening URLs and
 * paths logs instead of leaving the app.
 */

export async function openUrl(url: string): Promise<void> {
  installMockHarness()
  console.info(`[mock opener] would open URL: ${url}`)
}

export async function openPath(path: string): Promise<void> {
  installMockHarness()
  console.info(`[mock opener] would open path: ${path}`)
}
