/**
 * Dangerous-attachment policy (task 18.8, mail-security "Dangerous
 * attachment warnings", design D17). A static extension table mirroring
 * Gmail's well-known blocklist, in two tiers:
 *
 * - "block": executables, installers, scripts and shortcut formats that
 *   run (or can trick the OS into running) code — `.exe`, `.msi`, `.scr`,
 *   `.bat`, `.cmd`, `.com`, `.js`, `.jse`, `.vbs`, `.jar`, `.hta`, `.lnk`.
 * - "caution": macro-enabled Office documents — `.docm`, `.xlsm`,
 *   `.pptm` — legitimate documents that can carry live macros.
 *
 * Everything else is "safe": ordinary documents and media open without
 * extra prompts. Deliberately filename-based and static (D17): the check
 * is deterministic, has zero false-positive cost for normal documents,
 * and matches what the largest providers do; content sniffing and
 * archive recursion are deferred.
 */

/** Risk tier of one attachment filename. */
export type AttachmentRisk = "block" | "caution" | "safe"

/** Extensions that run (or can launch) code — confirm with a hard warning. */
export const BLOCK_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe",
  "msi",
  "scr",
  "bat",
  "cmd",
  "com",
  "js",
  "jse",
  "vbs",
  "jar",
  "hta",
  "lnk",
])

/** Macro-enabled Office documents — confirm with a softer warning. */
export const CAUTION_EXTENSIONS: ReadonlySet<string> = new Set([
  "docm",
  "xlsm",
  "pptm",
])

/**
 * The file's extension for policy purposes: the last dot-suffix of the
 * trimmed name, lowercased, with trailing dots/spaces stripped so
 * `"EVIL.exe."` / `"TROJAN.SCR "` (a common mail-client hiding trick)
 * still classify by their real suffix. A name with no extension at all
 * is "safe" here — nothing to match.
 */
export function attachmentExtension(filename: string | null): string | null {
  const trimmed = (filename ?? "").trim().replace(/[.\s]+$/, "")
  const dot = trimmed.lastIndexOf(".")
  if (dot <= -1 || dot === trimmed.length - 1) return null
  return trimmed.slice(dot + 1).toLowerCase()
}

/**
 * The risk tier of one attachment filename: "block" for executables and
 * scripts, "caution" for macro-enabled Office documents, "safe"
 * otherwise (including unnamed/extensionless files).
 */
export function attachmentRisk(filename: string | null): AttachmentRisk {
  const extension = attachmentExtension(filename)
  if (extension === null) return "safe"
  if (BLOCK_EXTENSIONS.has(extension)) return "block"
  if (CAUTION_EXTENSIONS.has(extension)) return "caution"
  return "safe"
}
