import { invoke } from "@tauri-apps/api/core"

import type { SqlExecutor } from "@/services/db/executor"
import { getSetting, setSetting } from "@/services/db/settings"

/**
 * Release channels + update checks for the packaged app (see
 * docs/releases.md). The repo publishes two channels:
 *
 * - "stable" — git tags `vX.Y.Z`, shipped as the GitHub "latest" release
 * - "beta" — git tags `vX.Y.Z-beta.N`, shipped as prereleases
 *
 * The plugin's JS `check()` cannot override the manifest endpoint per
 * call, so checks go through the Rust commands in src-tauri/src/updates.rs
 * (which pick the channel's manifest URL and keep the installable handle
 * in state). The channel is a plain settings row; switching takes effect
 * on the next check — no reinstall.
 */

export type UpdateChannel = "stable" | "beta"

const UPDATE_CHANNEL_KEY = "updates.channel"

/** Progress payloads for the `updates://download-progress` Rust event. */
export interface DownloadProgress {
  received: number
  total: number | null
}

export const UPDATE_DOWNLOAD_PROGRESS_EVENT = "updates://download-progress"
export const UPDATE_DOWNLOAD_FINISHED_EVENT = "updates://download-finished"

/** Snapshot of a pending update (the installable handle lives Rust-side). */
export interface UpdateMetadata {
  version: string
  currentVersion: string
  notes: string | null
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
export function checkForUpdate(
  channel: UpdateChannel
): Promise<UpdateMetadata | null> {
  return invoke("check_for_update", { channel })
}

/** Download the pending update (progress via events) and install it. */
export function downloadAndInstallUpdate(): Promise<void> {
  return invoke("download_and_install_update")
}
