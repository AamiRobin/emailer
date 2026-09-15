import { installMockHarness } from "./index"

/**
 * Mock @tauri-apps/plugin-notification (mock dev mode only): permission
 * is always granted; notifications log to the console.
 */

export interface MockNotificationOptions {
  title: string
  body?: string
}

export async function isPermissionGranted(): Promise<boolean> {
  installMockHarness()
  return true
}

export async function requestPermission(): Promise<NotificationPermission> {
  installMockHarness()
  return "granted"
}

export async function sendNotification(
  options: MockNotificationOptions | string
): Promise<void> {
  installMockHarness()
  const { title, body } =
    typeof options === "string" ? { title: options, body: undefined } : options
  console.info(`[mock notification] ${title}${body ? ` — ${body}` : ""}`)
}
