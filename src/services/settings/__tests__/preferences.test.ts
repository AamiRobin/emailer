import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The desktop-preference writers push their values to Rust commands; in
// the vitest runtime the real core module has no Tauri IPC, so resolve
// the commands as the app would (null success) — the assertions target
// the settings-table round-trips.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}))

import type { SqlExecutor } from "@/services/db/executor"
import {
  applyBootPreferences,
  applyDensity,
  applyFontScale,
  DEFAULT_FOLLOW_UP_DAYS,
  DEFAULT_NUDGE_DAYS,
  getAccentPreference,
  getComposerModePreference,
  getDensity,
  getFollowUpDays,
  getFontScale,
  getNudgeDays,
  getReadingPanePreference,
  getSendDelaySeconds,
  getThemeModePreference,
  getSidebarCollapsedPreference,
  SIDEBAR_AUTO_RAIL_WIDTH,
  sendDelaySettingKey,
  attachmentGuardSettingKey,
  emptySubjectGuardSettingKey,
  getAttachmentGuardSuppressed,
  getEmptySubjectGuardSuppressed,
  setAttachmentGuardSuppressedPreference,
  setComposerModePreference,
  setEmptySubjectGuardSuppressedPreference,
  setAccentPreference,
  setDensityPreference,
  setFollowUpDaysPreference,
  setFontScalePreference,
  getThreadSorts,
  setThreadSorts,
  getGroupBySenderPreference,
  setGroupBySenderPreference,
  setNudgeDaysPreference,
  setReadingPanePreference,
  setSendDelaySecondsPreference,
  setThemeModePreference,
  setSidebarCollapsedPreference,
  getImapDraftsFolderOverride,
  imapDraftsFolderSettingKey,
  setImapDraftsFolderPreference,
  getShortcutOverrides,
  setShortcutOverrides,
  getPgpEnabled,
  pgpEnabledSettingKey,
  setPgpEnabledPreference,
  getJunkFilterEnabled,
  junkFilterEnabledSettingKey,
  setJunkFilterEnabledPreference,
  getGravatarEnabled,
  setGravatarEnabledPreference,
  getMalwareLookupEnabled,
  getMalwareLookupApiKey,
  setMalwareLookupEnabledPreference,
  setMalwareLookupApiKeyPreference,
  getCloseAction,
  isCloseAction,
  setCloseActionPreference,
  getComposeShortcut,
  setComposeShortcutPreference,
  getMarkReadOnOpen,
  setMarkReadOnOpenPreference,
} from "../preferences"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { setDefaultKeyStore } from "@/services/crypto/key-management"
import { createInMemoryKeyStore } from "@/services/crypto/__tests__/in-memory-key-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"

/**
 * Preferences service tests (tasks 11.2/11.3): persistence round-trips
 * against the real v1 schema (node:sqlite) plus the live-application and
 * boot-apply side effects on the document root and the ui-store.
 */

function resetDocument(): void {
  document.documentElement.removeAttribute("data-accent")
  document.documentElement.style.removeProperty("--density")
  document.documentElement.style.removeProperty("--font-scale")
}

function resetStore(): void {
  localStorage.clear()
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
    previousView: DEFAULT_VIEW,
  })
}

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
  resetDocument()
  resetStore()
})

afterEach(() => {
  resetDocument()
  resetStore()
  executor.close()
})

describe("density", () => {
  it("defaults to the default preset and round-trips", async () => {
    expect(await getDensity(executor)).toBe("default")

    await setDensityPreference(executor, "compact")
    expect(await getDensity(executor)).toBe("compact")
    expect(document.documentElement.style.getPropertyValue("--density")).toBe(
      "0.85"
    )

    await setDensityPreference(executor, "relaxed")
    expect(document.documentElement.style.getPropertyValue("--density")).toBe(
      "1.25"
    )
  })

  it("falls back to the default when the stored value is unknown", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["appearance.density", JSON.stringify("gigantic")]
    )
    expect(await getDensity(executor)).toBe("default")
  })

  it("applyDensity maps every preset to its token value", () => {
    applyDensity("compact")
    expect(document.documentElement.style.getPropertyValue("--density")).toBe(
      "0.85"
    )
    applyDensity("default")
    expect(document.documentElement.style.getPropertyValue("--density")).toBe(
      "1"
    )
  })
})

describe("font scale", () => {
  it("defaults to 1 and round-trips, applying the --font-scale token", async () => {
    expect(await getFontScale(executor)).toBe(1)

    await setFontScalePreference(executor, 1.25)
    expect(await getFontScale(executor)).toBe(1.25)
    expect(
      document.documentElement.style.getPropertyValue("--font-scale")
    ).toBe("1.25")
  })

  it("ignores unknown scales on write and read", async () => {
    await setFontScalePreference(executor, 3)
    expect(await getFontScale(executor)).toBe(1)
    expect(
      document.documentElement.style.getPropertyValue("--font-scale")
    ).toBe("")

    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["appearance.fontScale", JSON.stringify(9)]
    )
    expect(await getFontScale(executor)).toBe(1)
  })

  it("applyFontScale ignores unknown scales", () => {
    applyFontScale(0.9)
    expect(
      document.documentElement.style.getPropertyValue("--font-scale")
    ).toBe("0.9")
    applyFontScale(4.2)
    expect(
      document.documentElement.style.getPropertyValue("--font-scale")
    ).toBe("0.9")
  })
})

describe("reading pane position", () => {
  it("defaults to right and round-trips into the ui-store", async () => {
    expect(await getReadingPanePreference(executor)).toBe("right")
    expect(useUiStore.getState().readingPane).toBe("right")

    await setReadingPanePreference(executor, "bottom")
    expect(await getReadingPanePreference(executor)).toBe("bottom")
    expect(useUiStore.getState().readingPane).toBe("bottom")
  })

  it("falls back to right when the stored value is unknown", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.readingPane", JSON.stringify("floating")]
    )
    expect(await getReadingPanePreference(executor)).toBe("right")
  })

  it("applyBootPreferences restores the persisted position", async () => {
    useUiStore.setState({ readingPane: "hidden" })
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.readingPane", JSON.stringify("bottom")]
    )
    await applyBootPreferences(executor)
    expect(useUiStore.getState().readingPane).toBe("bottom")
  })
})

describe("sidebar rail state", () => {
  it("defaults to expanded and round-trips into the ui-store", async () => {
    expect(await getSidebarCollapsedPreference(executor)).toBe(false)
    expect(useUiStore.getState().sidebarCollapsed).toBe(false)

    await setSidebarCollapsedPreference(executor, true)
    expect(await getSidebarCollapsedPreference(executor)).toBe(true)
    expect(useUiStore.getState().sidebarCollapsed).toBe(true)

    await setSidebarCollapsedPreference(executor, false)
    expect(await getSidebarCollapsedPreference(executor)).toBe(false)
    expect(useUiStore.getState().sidebarCollapsed).toBe(false)
  })

  it("falls back to expanded when the stored value is not a boolean", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["appearance.sidebarCollapsed", JSON.stringify("yes")]
    )
    expect(await getSidebarCollapsedPreference(executor)).toBe(false)
  })

  it("applyBootPreferences restores the stored flag on a wide window", async () => {
    await setSidebarCollapsedPreference(executor, true)
    useUiStore.setState({ sidebarCollapsed: false })
    const originalWidth = window.innerWidth
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: SIDEBAR_AUTO_RAIL_WIDTH + 100,
    })
    try {
      await applyBootPreferences(executor)
      expect(useUiStore.getState().sidebarCollapsed).toBe(true)
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: originalWidth,
      })
    }
  })

  it("applyBootPreferences folds a narrow window to the rail without writing it back", async () => {
    // Stored expanded, but the window is narrow: boot shows the rail and
    // must NOT persist the fold over the user's stored choice.
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["appearance.sidebarCollapsed", JSON.stringify(false)]
    )
    useUiStore.setState({ sidebarCollapsed: false })
    const originalWidth = window.innerWidth
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: SIDEBAR_AUTO_RAIL_WIDTH - 100,
    })
    try {
      await applyBootPreferences(executor)
      expect(useUiStore.getState().sidebarCollapsed).toBe(true)
      expect(await getSidebarCollapsedPreference(executor)).toBe(false)
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: originalWidth,
      })
    }
  })
})

describe("composer surface size", () => {
  it("defaults to centered and round-trips into the ui-store", async () => {
    expect(await getComposerModePreference(executor)).toBe("centered")
    // The ui-store default is the same centered card (fresh installs).
    useUiStore.setState({ composerMode: "centered" })

    await setComposerModePreference(executor, "full")
    expect(await getComposerModePreference(executor)).toBe("full")
    expect(useUiStore.getState().composerMode).toBe("full")
  })

  it("falls back to centered when the stored value is unknown", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.composerMode", JSON.stringify("docked")]
    )
    expect(await getComposerModePreference(executor)).toBe("centered")
  })

  it("applyBootPreferences restores the persisted mode", async () => {
    useUiStore.setState({ composerMode: "centered" })
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.composerMode", JSON.stringify("full")]
    )
    await applyBootPreferences(executor)
    expect(useUiStore.getState().composerMode).toBe("full")
  })
})

describe("accent + theme-mode mirrors", () => {
  it("accent defaults to neutral and round-trips the mirrored id", async () => {
    expect(await getAccentPreference(executor)).toBe("default")

    await setAccentPreference(executor, "teal")
    expect(await getAccentPreference(executor)).toBe("teal")
  })

  it("theme mode defaults to system and round-trips the mirrored mode", async () => {
    expect(await getThemeModePreference(executor)).toBe("system")

    await setThemeModePreference(executor, "dark")
    expect(await getThemeModePreference(executor)).toBe("dark")
  })
})

describe("per-account undo-send delay (design D3, task 5.1)", () => {
  it("defaults to 10s when unset and round-trips", async () => {
    expect(await getSendDelaySeconds(executor, "acc-1")).toBe(10)

    await setSendDelaySecondsPreference(executor, "acc-1", 20)
    expect(await getSendDelaySeconds(executor, "acc-1")).toBe(20)
  })

  it("namespaces the settings key per account", async () => {
    expect(sendDelaySettingKey("acc-1")).toBe("mail.sendDelaySeconds:acc-1")

    await setSendDelaySecondsPreference(executor, "acc-1", 5)
    await setSendDelaySecondsPreference(executor, "acc-2", 30)
    expect(await getSendDelaySeconds(executor, "acc-1")).toBe(5)
    expect(await getSendDelaySeconds(executor, "acc-2")).toBe(30)
  })

  it("clamps on write and read, keeping 0 as the immediate-send opt-out", async () => {
    await setSendDelaySecondsPreference(executor, "acc-1", 2)
    expect(await getSendDelaySeconds(executor, "acc-1")).toBe(5)

    await setSendDelaySecondsPreference(executor, "acc-1", 60)
    expect(await getSendDelaySeconds(executor, "acc-1")).toBe(30)

    await setSendDelaySecondsPreference(executor, "acc-1", 0)
    expect(await getSendDelaySeconds(executor, "acc-1")).toBe(0)
  })

  it("falls back to the default on a corrupt stored value", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [sendDelaySettingKey("acc-1"), JSON.stringify("whenever")]
    )
    expect(await getSendDelaySeconds(executor, "acc-1")).toBe(10)
  })
})

describe("per-account send-guard suppression (task 5.3)", () => {
  it("defaults to not suppressed and round-trips both guards", async () => {
    expect(await getAttachmentGuardSuppressed(executor, "acc-1")).toBe(false)
    expect(await getEmptySubjectGuardSuppressed(executor, "acc-1")).toBe(false)

    await setAttachmentGuardSuppressedPreference(executor, "acc-1", true)
    await setEmptySubjectGuardSuppressedPreference(executor, "acc-1", true)
    expect(await getAttachmentGuardSuppressed(executor, "acc-1")).toBe(true)
    expect(await getEmptySubjectGuardSuppressed(executor, "acc-1")).toBe(true)

    // Un-suppressing works too (the flag is a plain boolean, not a tombstone).
    await setAttachmentGuardSuppressedPreference(executor, "acc-1", false)
    await setEmptySubjectGuardSuppressedPreference(executor, "acc-1", false)
    expect(await getAttachmentGuardSuppressed(executor, "acc-1")).toBe(false)
    expect(await getEmptySubjectGuardSuppressed(executor, "acc-1")).toBe(false)
  })

  it("namespaces the settings keys per account and per guard", async () => {
    expect(attachmentGuardSettingKey("acc-1")).toBe(
      "mail.attachmentGuardSuppressed:acc-1"
    )
    expect(emptySubjectGuardSettingKey("acc-1")).toBe(
      "mail.emptySubjectGuardSuppressed:acc-1"
    )

    await setAttachmentGuardSuppressedPreference(executor, "acc-1", true)
    await setAttachmentGuardSuppressedPreference(executor, "acc-2", false)
    await setEmptySubjectGuardSuppressedPreference(executor, "acc-2", true)
    expect(await getAttachmentGuardSuppressed(executor, "acc-1")).toBe(true)
    expect(await getAttachmentGuardSuppressed(executor, "acc-2")).toBe(false)
    expect(await getEmptySubjectGuardSuppressed(executor, "acc-1")).toBe(false)
    expect(await getEmptySubjectGuardSuppressed(executor, "acc-2")).toBe(true)
  })

  it("reads corrupt or non-boolean stored values as not suppressed", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [attachmentGuardSettingKey("acc-1"), JSON.stringify("never ask")]
    )
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [emptySubjectGuardSettingKey("acc-1"), JSON.stringify(null)]
    )
    expect(await getAttachmentGuardSuppressed(executor, "acc-1")).toBe(false)
    expect(await getEmptySubjectGuardSuppressed(executor, "acc-1")).toBe(false)
  })
})

describe("per-scope thread-list sort map (task 4.1)", () => {
  it("defaults to an empty map and round-trips scope entries", async () => {
    expect(await getThreadSorts(executor)).toEqual({})

    await setThreadSorts(executor, {
      "special:inbox": "date_asc",
      "label:label-9": "sender",
      search: "unread_first",
    })
    expect(await getThreadSorts(executor)).toEqual({
      "special:inbox": "date_asc",
      "label:label-9": "sender",
      search: "unread_first",
    })
  })

  it("drops invalid options and shapes instead of throwing", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [
        "mail.threadSorts",
        JSON.stringify({
          "special:inbox": "date_asc",
          "special:trash": "newest-first",
          search: 42,
        }),
      ]
    )
    expect(await getThreadSorts(executor)).toEqual({
      "special:inbox": "date_asc",
    })

    await executor.execute(
      // placeholders ascend by occurrence in the SQL text (see executor.ts)
      "UPDATE settings SET value = $1 WHERE key = $2",
      [JSON.stringify(["not", "an", "object"]), "mail.threadSorts"]
    )
    expect(await getThreadSorts(executor)).toEqual({})
  })
})

describe("group-by-sender preference (task 9.4)", () => {
  it("defaults to off and round-trips the boolean", async () => {
    expect(await getGroupBySenderPreference(executor)).toBe(false)

    await setGroupBySenderPreference(executor, true)
    expect(await getGroupBySenderPreference(executor)).toBe(true)

    await setGroupBySenderPreference(executor, false)
    expect(await getGroupBySenderPreference(executor)).toBe(false)
  })

  it("reads a corrupt stored value as off", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.groupBySender", JSON.stringify("yes please")]
    )
    expect(await getGroupBySenderPreference(executor)).toBe(false)
  })
})

describe("nudge + follow-up thresholds (tasks 14.1/14.2, design D8)", () => {
  it("defaults to 3 days for both and round-trips", async () => {
    expect(await getNudgeDays(executor)).toBe(DEFAULT_NUDGE_DAYS)
    expect(await getFollowUpDays(executor)).toBe(DEFAULT_FOLLOW_UP_DAYS)

    await setNudgeDaysPreference(executor, 5)
    expect(await getNudgeDays(executor)).toBe(5)
    await setFollowUpDaysPreference(executor, 7)
    expect(await getFollowUpDays(executor)).toBe(7)
  })

  it("clamps both thresholds to 1–30 on write and read", async () => {
    await setNudgeDaysPreference(executor, 0)
    expect(await getNudgeDays(executor)).toBe(1)
    await setFollowUpDaysPreference(executor, 99)
    expect(await getFollowUpDays(executor)).toBe(30)

    // Out-of-range values stored out-of-band (an older build, a hand
    // edit) clamp on read too.
    await executor.execute(
      "UPDATE settings SET value = $1 WHERE key = 'mail.nudgeDays'",
      [JSON.stringify(500)]
    )
    expect(await getNudgeDays(executor)).toBe(30)
  })

  it("reads corrupt or non-number stored values as the defaults", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.nudgeDays", JSON.stringify("soon")]
    )
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.followUpDays", JSON.stringify(null)]
    )
    expect(await getNudgeDays(executor)).toBe(DEFAULT_NUDGE_DAYS)
    expect(await getFollowUpDays(executor)).toBe(DEFAULT_FOLLOW_UP_DAYS)
  })
})

describe("keyboard-shortcut overrides (task 20.1, design D15)", () => {
  it("defaults to an empty map and round-trips display strings", async () => {
    expect(await getShortcutOverrides(executor)).toEqual({})

    await setShortcutOverrides(executor, { archive: "a", palette: "p" })
    expect(await getShortcutOverrides(executor)).toEqual({
      archive: "a",
      palette: "p",
    })
  })

  it("drops unknown ids and non-string or blank values on read", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [
        "mail.shortcutOverrides",
        JSON.stringify({
          archive: "a",
          "not-a-shortcut": "x",
          trash: 42,
          toggleRead: "",
        }),
      ]
    )
    expect(await getShortcutOverrides(executor)).toEqual({ archive: "a" })
  })

  it("reads a corrupt or non-object row as empty", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.shortcutOverrides", JSON.stringify(["not", "an", "object"])]
    )
    expect(await getShortcutOverrides(executor)).toEqual({})
  })

  it("an empty written map reads back as empty (global reset)", async () => {
    await setShortcutOverrides(executor, { archive: "a" })
    await setShortcutOverrides(executor, {})
    expect(await getShortcutOverrides(executor)).toEqual({})
  })
})

describe("malware hash-lookup preferences (task 18.9)", () => {
  it("the global opt-in defaults to off and round-trips", async () => {
    expect(await getMalwareLookupEnabled(executor)).toBe(false)

    await setMalwareLookupEnabledPreference(executor, true)
    expect(await getMalwareLookupEnabled(executor)).toBe(true)

    await setMalwareLookupEnabledPreference(executor, false)
    expect(await getMalwareLookupEnabled(executor)).toBe(false)
  })

  it("reads corrupt or non-boolean stored values as off", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.malwareLookupEnabled", JSON.stringify("yes")]
    )
    expect(await getMalwareLookupEnabled(executor)).toBe(false)
  })

  it("the API key defaults to empty, trims on write and read", async () => {
    setDefaultKeyStore(createInMemoryKeyStore())
    try {
      expect(await getMalwareLookupApiKey(executor)).toBe("")

      await setMalwareLookupApiKeyPreference(executor, "  vt-key-123  ")
      expect(await getMalwareLookupApiKey(executor)).toBe("vt-key-123")

      await setMalwareLookupApiKeyPreference(executor, "   ")
      expect(await getMalwareLookupApiKey(executor)).toBe("")
    } finally {
      setDefaultKeyStore(null)
    }
  })

  it("stores the API key encrypted, not as plaintext", async () => {
    setDefaultKeyStore(createInMemoryKeyStore())
    try {
      await setMalwareLookupApiKeyPreference(executor, "vt-key-123")
      const row = await executor
        .select<{ value: string }>(
          "SELECT value FROM settings WHERE key = $1",
          ["mail.malwareLookupApiKey"]
        )
        .then((rows) => rows[0]?.value ?? "")
      expect(row).not.toContain("vt-key-123")
      expect(await getMalwareLookupApiKey(executor)).toBe("vt-key-123")
    } finally {
      setDefaultKeyStore(null)
    }
  })

  it("still reads legacy plaintext key rows", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.malwareLookupApiKey", JSON.stringify("legacy-key")]
    )
    expect(await getMalwareLookupApiKey(executor)).toBe("legacy-key")
  })

  it("reads a corrupt non-string key row as empty", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.malwareLookupApiKey", JSON.stringify(42)]
    )
    expect(await getMalwareLookupApiKey(executor)).toBe("")
  })
})

describe("close action (task 1.2, desktop integration)", () => {
  it("defaults to quit and round-trips", async () => {
    expect(await getCloseAction(executor)).toBe("quit")

    await setCloseActionPreference(executor, "hide")
    expect(await getCloseAction(executor)).toBe("hide")

    await setCloseActionPreference(executor, "quit")
    expect(await getCloseAction(executor)).toBe("quit")
  })

  it("falls back to quit when the stored value is corrupt", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["desktop.closeAction", JSON.stringify("minimize")]
    )
    expect(await getCloseAction(executor)).toBe("quit")
  })

  it("isCloseAction accepts only the two enum values", () => {
    expect(isCloseAction("hide")).toBe(true)
    expect(isCloseAction("quit")).toBe(true)
    expect(isCloseAction("minimize")).toBe(false)
    expect(isCloseAction(null)).toBe(false)
  })
})

describe("global compose shortcut (task 1.5)", () => {
  it("defaults to null and round-trips an accelerator", async () => {
    expect(await getComposeShortcut(executor)).toBeNull()

    await setComposeShortcutPreference(executor, "CmdOrCtrl+Shift+E")
    expect(await getComposeShortcut(executor)).toBe("CmdOrCtrl+Shift+E")

    await setComposeShortcutPreference(executor, null)
    expect(await getComposeShortcut(executor)).toBeNull()
  })

  it("reads corrupt rows and blanks as null (no registration)", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["desktop.composeShortcut", JSON.stringify(42)]
    )
    expect(await getComposeShortcut(executor)).toBeNull()

    await setComposeShortcutPreference(executor, "   ")
    expect(await getComposeShortcut(executor)).toBeNull()
  })
})

describe("applyBootPreferences", () => {
  it("sets the tokens and feeds the reading pane into the ui-store", async () => {
    await setDensityPreference(executor, "compact")
    await setFontScalePreference(executor, 1.1)
    await setReadingPanePreference(executor, "hidden")
    // Return the store to the default so the boot apply has work to do.
    useUiStore.setState({ readingPane: "right" })

    await applyBootPreferences(executor)

    expect(document.documentElement.style.getPropertyValue("--density")).toBe(
      "0.85"
    )
    expect(
      document.documentElement.style.getPropertyValue("--font-scale")
    ).toBe("1.1")
    expect(useUiStore.getState().readingPane).toBe("hidden")
  })

  it("re-applies the accent only when a mirror row exists", async () => {
    // No mirror row: the localStorage choice initAccent() applied (simulated
    // here by a direct attribute set) must survive the boot apply.
    document.documentElement.setAttribute("data-accent", "rose")
    await applyBootPreferences(executor)
    expect(document.documentElement.getAttribute("data-accent")).toBe("rose")

    // With a mirrored row the boot apply restores it (e.g. cleared
    // localStorage).
    await setAccentPreference(executor, "amber")
    await applyBootPreferences(executor)
    expect(document.documentElement.getAttribute("data-accent")).toBe("amber")
  })

  it("round-trips the per-account IMAP drafts-folder override (task 17.2)", async () => {
    expect(await getImapDraftsFolderOverride(executor, "acc-1")).toBeNull()
    expect(imapDraftsFolderSettingKey("acc-1")).toBe(
      "mail.imapDraftsFolder:acc-1"
    )

    await setImapDraftsFolderPreference(executor, "acc-1", "My/Drafts")
    await setImapDraftsFolderPreference(executor, "acc-2", "Archive/Drafts")
    expect(await getImapDraftsFolderOverride(executor, "acc-1")).toBe(
      "My/Drafts"
    )
    expect(await getImapDraftsFolderOverride(executor, "acc-2")).toBe(
      "Archive/Drafts"
    )

    // Values are trimmed on write; null and blank clear the override.
    await setImapDraftsFolderPreference(executor, "acc-1", "  Padded/Box  ")
    expect(await getImapDraftsFolderOverride(executor, "acc-1")).toBe(
      "Padded/Box"
    )
    await setImapDraftsFolderPreference(executor, "acc-1", null)
    expect(await getImapDraftsFolderOverride(executor, "acc-1")).toBeNull()
    await setImapDraftsFolderPreference(executor, "acc-1", "   ")
    expect(await getImapDraftsFolderOverride(executor, "acc-1")).toBeNull()
    // The other account's override is untouched.
    expect(await getImapDraftsFolderOverride(executor, "acc-2")).toBe(
      "Archive/Drafts"
    )
  })

  it("reads corrupt or non-string stored overrides as null", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [imapDraftsFolderSettingKey("acc-1"), JSON.stringify(42)]
    )
    expect(await getImapDraftsFolderOverride(executor, "acc-1")).toBeNull()
  })

  it("round-trips the per-account PGP opt-in (task 18.7)", async () => {
    expect(await getPgpEnabled(executor, "acc-1")).toBe(false)
    expect(pgpEnabledSettingKey("acc-1")).toBe("mail.pgpEnabled:acc-1")

    await setPgpEnabledPreference(executor, "acc-1", true)
    expect(await getPgpEnabled(executor, "acc-1")).toBe(true)
    // Strictly per account: another account stays off.
    expect(await getPgpEnabled(executor, "acc-2")).toBe(false)

    await setPgpEnabledPreference(executor, "acc-1", false)
    expect(await getPgpEnabled(executor, "acc-1")).toBe(false)
  })

  it("reads corrupt or non-boolean PGP rows as off (fail toward off)", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [pgpEnabledSettingKey("acc-1"), JSON.stringify("yes")]
    )
    expect(await getPgpEnabled(executor, "acc-1")).toBe(false)
  })

  it("junk-filter toggle: default off, per-account round-trip", async () => {
    expect(await getJunkFilterEnabled(executor, "acc-1")).toBe(false)
    expect(junkFilterEnabledSettingKey("acc-1")).toBe(
      "mail.junkFilterEnabled:acc-1"
    )

    await setJunkFilterEnabledPreference(executor, "acc-1", true)
    expect(await getJunkFilterEnabled(executor, "acc-1")).toBe(true)
    // Strictly per account: another account stays off.
    expect(await getJunkFilterEnabled(executor, "acc-2")).toBe(false)

    await setJunkFilterEnabledPreference(executor, "acc-1", false)
    expect(await getJunkFilterEnabled(executor, "acc-1")).toBe(false)
  })

  it("reads corrupt or non-boolean junk-filter rows as off", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [junkFilterEnabledSettingKey("acc-1"), JSON.stringify("on")]
    )
    expect(await getJunkFilterEnabled(executor, "acc-1")).toBe(false)
  })

  it("gravatar opt-in: default off, global round-trip (task 2.5, design D12)", async () => {
    expect(await getGravatarEnabled(executor)).toBe(false)

    await setGravatarEnabledPreference(executor, true)
    expect(await getGravatarEnabled(executor)).toBe(true)

    await setGravatarEnabledPreference(executor, false)
    expect(await getGravatarEnabled(executor)).toBe(false)
  })

  it("reads corrupt or non-boolean gravatar rows as off (privacy default)", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["contacts.gravatarEnabled", JSON.stringify("yes")]
    )
    // Off is the privacy default: a hash of the address must never be
    // sent to gravatar.com because a row went corrupt.
    expect(await getGravatarEnabled(executor)).toBe(false)
  })

  it("keeps the defaults when the executor fails", async () => {
    const failing: SqlExecutor = {
      select: () => Promise.reject(new Error("no database")),
      execute: () => Promise.reject(new Error("no database")),
    }
    // Must not throw.
    await applyBootPreferences(failing)
    expect(useUiStore.getState().readingPane).toBe("right")
    expect(document.documentElement.style.getPropertyValue("--density")).toBe(
      ""
    )
  })
})

describe("mark-as-read on open (task 1.4, settings spec)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("defaults to on, round-trips, and persists across re-reads", async () => {
    // default: the historical behavior — opening marks read
    expect(await getMarkReadOnOpen(executor)).toBe(true)

    await setMarkReadOnOpenPreference(executor, false)
    expect(await getMarkReadOnOpen(executor)).toBe(false)
    // a fresh read of the same row (next launch) keeps the choice
    expect(await getMarkReadOnOpen(executor)).toBe(false)

    await setMarkReadOnOpenPreference(executor, true)
    expect(await getMarkReadOnOpen(executor)).toBe(true)
  })

  it("reads corrupt or non-boolean rows as on (the historical default)", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.markReadOnOpen", JSON.stringify("off")]
    )
    expect(await getMarkReadOnOpen(executor)).toBe(true)
  })
})
