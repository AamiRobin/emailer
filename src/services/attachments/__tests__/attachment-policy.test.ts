import { describe, expect, it } from "vitest"

import { attachmentExtension, attachmentRisk } from "../attachment-policy"

/**
 * Policy-table tests (task 18.8, design D17): the static tier list must
 * classify exactly the spec'd extensions, case-insensitively, with the
 * trailing dot/space trimming mail clients use to disguise types.
 */

describe("attachmentRisk", () => {
  it("flags every block-tier executable/script extension", () => {
    for (const name of [
      "invoice.exe",
      "setup.msi",
      "screensaver.scr",
      "autoexec.bat",
      "run.cmd",
      "host.com",
      "script.js",
      "encoded.jse",
      "macro.vbs",
      "exploit.jar",
      "panel.hta",
      "shortcut.lnk",
    ]) {
      expect(attachmentRisk(name), name).toBe("block")
    }
  })

  it("flags the macro-enabled Office formats as caution", () => {
    expect(attachmentRisk("report.docm")).toBe("caution")
    expect(attachmentRisk("budget.xlsm")).toBe("caution")
    expect(attachmentRisk("deck.pptm")).toBe("caution")
  })

  it("leaves documents, media and archives safe", () => {
    for (const name of [
      "scan.pdf",
      "contract.docx",
      "sheet.xlsx",
      "notes.txt",
      "photo.png",
      "song.mp3",
      "backup.zip",
      "data.csv",
    ]) {
      expect(attachmentRisk(name), name).toBe("safe")
    }
  })

  it("is case-insensitive", () => {
    expect(attachmentRisk("TROJAN.EXE")).toBe("block")
    expect(attachmentRisk("Report.DOCM")).toBe("caution")
    expect(attachmentRisk("scan.PDF")).toBe("safe")
  })

  it("strips trailing dots and spaces before matching", () => {
    expect(attachmentRisk("evil.exe.")).toBe("block")
    expect(attachmentRisk("evil.exe . ")).toBe("block")
    expect(attachmentRisk("ok.pdf.")).toBe("safe")
  })

  it("uses the LAST suffix for multi-dot names", () => {
    expect(attachmentRisk("resume.pdf.exe")).toBe("block")
    expect(attachmentRisk("resume.exe.pdf")).toBe("safe")
  })

  it("treats extensionless, dotfile and unnamed attachments as safe", () => {
    expect(attachmentRisk("README")).toBe("safe")
    expect(attachmentRisk(".gitignore")).toBe("safe")
    expect(attachmentRisk("")).toBe("safe")
    expect(attachmentRisk(null)).toBe("safe")
  })
})

describe("attachmentExtension", () => {
  it("extracts the lowercased last suffix", () => {
    expect(attachmentExtension("a.B.EXe")).toBe("exe")
    expect(attachmentExtension("plain")).toBeNull()
    expect(attachmentExtension("trailing.")).toBeNull()
  })
})
