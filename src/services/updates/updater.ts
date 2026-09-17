import { check } from "@tauri-apps/plugin-updater"
import type { Update } from "@tauri-apps/plugin-updater"

import type { SqlExecutor } from "@/services/db/executor"
import { getSetting, setSetting } from "@/services/db/settings"

/**
 * Release channels + update checks for the packaged app (see
 * docs/releases.md). The repo publishes two channels:
 *
 * - "stable" — git tags `vX.Y.Z`, shipped as the GitHub "latest" release
 * - "beta" — git tags `vX.Y.Z-beta.N`, shipped as prereleases
 *
 * The release workflow uploads each build's updater manifest to the
 * perpetual `channels` release as `latest-stable.json` /
 * `latest-beta.json`, so both endpoint URLs are static and the updater
 * only ever sees manifests that match the channel the user picked in
 * Settings → Updates.
 *
 * The channel is a plain settings row; the manifest endpoint is chosen at
 * check time (the plugin's JS `check({ endpoints })` override), so
 * switching channels takes effect on the next check — no reinstall.
 */

export type UpdateChannel = "stable" | "beta"

const UPDATE_CHANNEL_KEY = "updates.channel"

export const STABLE_ENDPOINT =
  "https://github.com/AamiRobin/emailer/releases/download/channels/latest-stable.json"
export const BETA_ENDPOINT =
  "https://github.com/AamiRobin/emailer/releases/download/channels/latest-beta.json"

export function endpointForChannel(channel: UpdateChannel): string {
  return channel === "beta" ? BETA_ENDPOINT : STABLE_ENDPOINT
}

/** Stored channel; unknown/corrupt values fail toward "stable". */
export async function getUpdateChannel(
  executor: SqlExecutor
): Promise<UpdateChannel> {
  const value = await getSetting<UpdateChannel>(
    executor,
    UPDATE_CHANNEL_KEY,
    "stable"
  )
  return value === "beta" ? "beta" : "stable"
}

export async function setUpdateChannel(
  executor: SqlExecutor,
  channel: UpdateChannel
): Promise<void> {
  await setSetting(executor, UPDATE_CHANNEL_KEY, channel)
}

/**
 * Ask the channel's manifest whether an update exists. Returns null when
 * the app is current. Throws outside the packaged desktop app (no Tauri
 * IPC) — callers present that as "not available here", not as a crash.
 */
export async function checkForUpdate(
  channel: UpdateChannel
): Promise<Update | null> {
  return check({ endpoints: [endpointForChannel(channel)], timeout: 15000 })
}
