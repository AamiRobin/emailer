import { describe, expect, it } from "vitest"

import type { ImapFolder } from "../invoke"
import {
  leafFolderName,
  roleToSpecialUse,
  systemLabelForSpecialUse,
  toEmailFolder,
  toEmailFolders,
  toFolderLabelMapping,
  userFolderLabelId,
} from "../folder-mapper"

function imapFolder(overrides: Partial<ImapFolder> = {}): ImapFolder {
  return {
    name: "INBOX",
    delimiter: "/",
    selectable: true,
    role: null,
    ...overrides,
  }
}

describe("toEmailFolder — container filter", () => {
  it("returns null for \\NoSelect container folders", () => {
    expect(
      toEmailFolder(
        imapFolder({ name: "[Gmail]", delimiter: "/", selectable: false })
      )
    ).toBeNull()
    expect(
      toEmailFolder(
        imapFolder({ name: "Archive/", selectable: false, role: "archive" })
      )
    ).toBeNull()
  })

  it("keeps selectable folders even with special roles (flagged/all sync too)", () => {
    const flagged = toEmailFolder(
      imapFolder({ name: "Flagged", role: "flagged" })
    )
    const all = toEmailFolder(imapFolder({ name: "All Mail", role: "all" }))
    expect(flagged).not.toBeNull()
    expect(all).not.toBeNull()
    expect(flagged?.specialUse).toBe("flagged")
    expect(all?.specialUse).toBe("all")
  })

  it("filters containers and keeps selectable folders in bulk", () => {
    const folders = toEmailFolders([
      imapFolder({ name: "[Gmail]", selectable: false }),
      imapFolder({ name: "INBOX", role: "inbox" }),
      imapFolder({ name: "Projects/2024" }),
    ])
    expect(folders.map((folder) => folder.path)).toEqual([
      "INBOX",
      "Projects/2024",
    ])
  })
})

describe("toEmailFolder — system role mapping", () => {
  it("maps every RFC 6154 role to a canonical system label", () => {
    expect(toEmailFolder(imapFolder({ name: "INBOX", role: "inbox" }))).toEqual(
      {
        id: "INBOX",
        name: "Inbox",
        path: "INBOX",
        type: "system",
        specialUse: "inbox",
        delimiter: "/",
      }
    )
    expect(toEmailFolder(imapFolder({ name: "Sent", role: "sent" }))?.id).toBe(
      "SENT"
    )
    expect(
      toEmailFolder(imapFolder({ name: "Drafts", role: "drafts" }))?.id
    ).toBe("DRAFTS")
    expect(
      toEmailFolder(imapFolder({ name: "Deleted", role: "trash" }))?.specialUse
    ).toBe("trash")
    // imap role "junk" normalizes to the labels-table value "spam"
    const junk = toEmailFolder(
      imapFolder({ name: "Junk", role: "junk", delimiter: "." })
    )
    expect(junk?.specialUse).toBe("spam")
    expect(junk?.id).toBe("SPAM")
    expect(junk?.name).toBe("Spam")
    expect(
      toEmailFolder(imapFolder({ name: "Archive", role: "archive" }))?.id
    ).toBe("ARCHIVE")
  })

  it("system folders keep the full server path, not the leaf", () => {
    const sent = toEmailFolder(
      imapFolder({ name: "Mail/Sent", delimiter: "/", role: "sent" })
    )
    expect(sent?.path).toBe("Mail/Sent")
    expect(sent?.name).toBe("Sent")
    expect(sent?.type).toBe("system")
  })
})

describe("toEmailFolder — user folders", () => {
  it("uses the leaf name and a path-derived deterministic id", () => {
    const folder = toEmailFolder(
      imapFolder({ name: "Projects/2024", delimiter: "/" })
    )
    expect(folder).toEqual({
      id: "folder-Projects/2024",
      name: "2024",
      path: "Projects/2024",
      type: "user",
      specialUse: null,
      delimiter: "/",
    })
  })

  it("handles dot-delimited and flat namespaces", () => {
    expect(
      toEmailFolder(imapFolder({ name: "INBOX.Newsletters", delimiter: "." }))
        ?.name
    ).toBe("Newsletters")
    expect(
      toEmailFolder(imapFolder({ name: "Misc", delimiter: "" }))?.name
    ).toBe("Misc")
  })

  it("trusts role=null — no TS-side name heuristics", () => {
    // "Sent Items" without a role stays a user folder: the well-known-name
    // fallback runs Rust-side (D14).
    const folder = toEmailFolder(imapFolder({ name: "Sent Items" }))
    expect(folder?.type).toBe("user")
    expect(folder?.specialUse).toBeNull()
  })
})

describe("labels-table helpers", () => {
  it("maps roles to labels-table special-use values", () => {
    expect(roleToSpecialUse("junk")).toBe("spam")
    expect(roleToSpecialUse("inbox")).toBe("inbox")
    expect(roleToSpecialUse("flagged")).toBe("flagged")
  })

  it("builds canonical system label identity for insertLabel", () => {
    expect(systemLabelForSpecialUse("spam")).toEqual({
      id: "SPAM",
      name: "Spam",
      type: "system",
    })
    expect(systemLabelForSpecialUse("all")).toEqual({
      id: "ALL_MAIL",
      name: "All Mail",
      type: "system",
    })
  })

  it("projects a folder into a labels-table row shape", () => {
    expect(
      toFolderLabelMapping(imapFolder({ name: "INBOX", role: "inbox" }))
    ).toEqual({
      labelId: "INBOX",
      labelName: "Inbox",
      type: "system",
      specialUse: "inbox",
      imapFolderName: "INBOX",
    })
    expect(
      toFolderLabelMapping(imapFolder({ name: "[Gmail]", selectable: false }))
    ).toBeNull()
    expect(
      toFolderLabelMapping(imapFolder({ name: "Work/ACME" }))
    ).toMatchObject({
      labelId: userFolderLabelId("Work/ACME"),
      labelName: "ACME",
      type: "user",
      specialUse: null,
    })
  })

  it("derives leaf names with an explicit helper", () => {
    expect(leafFolderName("a/b/c", "/")).toBe("c")
    // empty last segment falls back to the full path
    expect(leafFolderName("trailing/", "/")).toBe("trailing/")
    expect(leafFolderName("flat", "")).toBe("flat")
  })
})
