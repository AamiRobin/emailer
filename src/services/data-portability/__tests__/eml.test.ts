import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * EML export tests (task 19.1). No mail-parser package exists, so the
 * round trip is structural: the rebuilt message is (1) checked against
 * RFC 822 shape by hand (header block, boundary consistency, base64
 * part bodies) and (2) parsed back through the project's own MIME
 * reader — decomposeMimeMessage, the same reader the scheduled-send
 * edit flow trusts — which is the strongest parse available in-repo.
 * Attachment fidelity goes one step further: the attachment part's
 * base64 decodes to the exact seeded bytes.
 */

const executorHolder = vi.hoisted(() => ({
  current: null as unknown,
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}))

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => new Uint8Array()),
  remove: vi.fn(async () => undefined),
}))

vi.mock("@tauri-apps/api/path", () => ({
  join: vi.fn(async (...segments: string[]) => segments.join("/")),
}))

import { open as openFileDialogMock } from "@tauri-apps/plugin-dialog"
import { writeFile as fsWriteFileMock } from "@tauri-apps/plugin-fs"

import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { MessageInput } from "../../db/messages"
import { insertMessage } from "../../db/messages"
import { insertThread } from "../../db/threads"
import { decomposeMimeMessage, formatDate } from "../../email/mime-builder"
import {
  emlFilename,
  exportThreadAsEml,
  rebuildEml,
  sanitizeFileStem,
} from "../eml"

let executor: TestExecutor

/** A cache fs fake serving one seeded attachment's bytes. */
function cacheFsWith(cached: Record<string, Uint8Array>) {
  return {
    ensureCacheDir: async () => {},
    writeFile: async () => {},
    readFile: async (relPath: string) => {
      const bytes = cached[relPath]
      if (!bytes) throw new Error(`not cached: ${relPath}`)
      return bytes
    },
    removeFile: async () => {},
  }
}

const ACCOUNT = "acc-1"
const THREAD = "thread-1"

async function seedThread(): Promise<string> {
  await insertThread(executor, { id: THREAD, accountId: ACCOUNT })
  return THREAD
}

async function seedMessage(input: Partial<MessageInput> & { date: number }) {
  const id = `msg-${Math.random().toString(36).slice(2)}`
  await insertMessage(executor, {
    id,
    threadId: THREAD,
    accountId: ACCOUNT,
    ...input,
  })
  return id
}

const KNOWN_BYTES = new Uint8Array([0, 1, 2, 250, 251, 254, 255])

/** The classic seeded message: both bodies, real headers, one PDF with
 * its cached bytes on disk (local_path set — the cache-hit flow). */
async function seedFullMessage() {
  await seedThread()
  const id = await seedMessage({
    date: 1_700_000_000, // 2023-11-14T22:13:20Z
    subject: "Quarterly report",
    fromName: "Alice Sender",
    fromAddress: "alice@example.com",
    to: [{ email: "me@example.com" }],
    cc: [{ name: "Boss", email: "boss@example.com" }],
    messageIdHeader: "<orig-123@example.com>",
    inReplyTo: "<parent@example.com>",
    referencesHeader: "<root@example.com> <parent@example.com>",
    bodyText: "Plain body line.\nSecond line.\nFrom the beginning.",
    bodyHtml: "<p>HTML <b>body</b></p>",
    headers: JSON.stringify({
      "list-unsubscribe": "<https://example.com/unsub>",
    }),
    attachments: [
      {
        id: "att-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: KNOWN_BYTES.byteLength,
        providerPartId: "2",
      },
    ],
  })
  // insertMessage seeds metadata only; the cache columns are the fetch
  // flow's (cache.ts) — point local_path at the fake cache's file.
  await executor.execute(
    "UPDATE attachments SET local_path = $1 WHERE id = $2",
    ["attachment_cache/report.pdf", "att-1"]
  )
  return id
}

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [ACCOUNT, "gmail", `${ACCOUNT}@example.com`]
  )
})

afterEach(() => {
  executor.close()
  vi.clearAllMocks()
})

/** Split an EML into (headerBlock, rest) at the first blank line. */
function splitHeaders(eml: string): { headers: string[]; body: string } {
  const [block, ...rest] = eml.split("\r\n\r\n")
  return { headers: block.split("\r\n"), body: rest.join("\r\n\r\n") }
}

function headerValue(headers: string[], name: string): string | null {
  const prefix = `${name.toLowerCase()}:`
  const line = headers.find((header) => header.toLowerCase().startsWith(prefix))
  return line ? line.slice(line.indexOf(":") + 1).trim() : null
}

describe("rebuildEml structure", () => {
  it("emits the standard header block from the stored columns", async () => {
    const id = await seedFullMessage()
    const rebuilt = await rebuildEml(executor, id, {})
    expect(rebuilt).not.toBeNull()
    const { headers } = splitHeaders(rebuilt!.eml)

    expect(headerValue(headers, "from")).toBe(
      "Alice Sender <alice@example.com>"
    )
    expect(headerValue(headers, "to")).toBe("me@example.com")
    expect(headerValue(headers, "cc")).toBe("Boss <boss@example.com>")
    expect(headerValue(headers, "subject")).toBe("Quarterly report")
    expect(headerValue(headers, "message-id")).toBe("<orig-123@example.com>")
    expect(headerValue(headers, "in-reply-to")).toBe("<parent@example.com>")
    expect(headerValue(headers, "references")).toBe(
      "<root@example.com> <parent@example.com>"
    )
    // RFC 5322 date built from the stored unix seconds.
    expect(headerValue(headers, "date")).toBe(
      formatDate(new Date(1_700_000_000 * 1000))
    )
    expect(headerValue(headers, "mime-version")).toBe("1.0")
    // The stored headers JSON (D13) rides along.
    expect(headerValue(headers, "list-unsubscribe")).toBe(
      "<https://example.com/unsub>"
    )
  })

  it("wraps body + attachment in multipart/mixed with consistent boundaries", async () => {
    const id = await seedFullMessage()
    const rebuilt = await rebuildEml(executor, id, {})
    const eml = rebuilt!.eml
    const { headers, body } = splitHeaders(eml)

    const mixed = headerValue(headers, "content-type")
    expect(mixed).toMatch(/^multipart\/mixed; boundary="(.+)"$/)
    const boundary = mixed!.match(/boundary="(.+)"/)![1]
    // Nested alternative boundary is declared inside the body.
    const alternative = body.match(/boundary="(.+)"/)![1]
    expect(alternative).not.toBe(boundary)

    // Every boundary line in the message belongs to a declared boundary
    // and both close markers exist (Thunderbird/mailparse require this).
    const boundaryLines = eml
      .split("\r\n")
      .filter((line) => line.startsWith("--"))
    expect(boundaryLines).toContain(`--${boundary}--`)
    expect(boundaryLines).toContain(`--${alternative}--`)
    for (const line of boundaryLines) {
      expect(line).toMatch(new RegExp(`^--(${boundary}|${alternative})(--)?$`))
    }
    // Parts: alternative block, then the attachment, closed by the mixed
    // terminator at the very end.
    expect(body.startsWith(`--${boundary}\r\n`)).toBe(true)
    expect(eml.endsWith(`--${boundary}--\r\n`)).toBe(true)
  })

  it("base64-encodes part bodies (CRLF lines, decodable)", async () => {
    const id = await seedFullMessage()
    const rebuilt = await rebuildEml(executor, id, {})
    for (const line of splitHeaders(rebuilt!.eml).body.split("\r\n")) {
      // Only boundary lines and part headers are non-base64; every other
      // line must be wire-safe base64.
      if (line.startsWith("--") || line === "" || /^[A-Za-z-]+: /.test(line)) {
        continue
      }
      expect(line).toMatch(/^[A-Za-z0-9+/=]+$/)
    }
  })
})

describe("rebuildEml round trip (decomposeMimeMessage parse-back)", () => {
  it("parses back to the seeded subject, participants and both bodies", async () => {
    const id = await seedFullMessage()
    const rebuilt = await rebuildEml(executor, id, {})
    const parsed = decomposeMimeMessage(rebuilt!.eml)

    expect(parsed.subject).toBe("Quarterly report")
    expect(parsed.from).toMatchObject({
      name: "Alice Sender",
      email: "alice@example.com",
    })
    expect(parsed.to).toEqual([{ email: "me@example.com" }])
    expect(parsed.textBody).toBe(
      "Plain body line.\nSecond line.\nFrom the beginning."
    )
    expect(parsed.htmlBody).toBe("<p>HTML <b>body</b></p>")
  })

  it("the attachment part decodes to the original cached bytes", async () => {
    const id = await seedFullMessage()
    const rebuilt = await rebuildEml(executor, id, {
      fs: cacheFsWith({ "attachment_cache/report.pdf": KNOWN_BYTES }),
    })
    const parsed = decomposeMimeMessage(rebuilt!.eml)

    expect(rebuilt!.unavailableAttachments).toEqual([])
    expect(parsed.attachments).toHaveLength(1)
    expect(parsed.attachments[0]).toMatchObject({
      filename: "report.pdf",
      mimeType: "application/pdf",
    })
    // bytesToBase64 → atob → bytes: exact byte fidelity.
    const binary = atob(parsed.attachments[0].contentBase64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    expect(Array.from(bytes)).toEqual(Array.from(KNOWN_BYTES))
  })

  it("reports cache-miss attachments and keeps the part", async () => {
    // The full-message flow without cached bytes: the miss is REPORTED,
    // never silent, and the MIME keeps the attachment slot (an empty
    // part) rather than dropping it. The in-repo parse-back skips empty
    // parts (decompose requires non-empty part bodies), so the slot is
    // asserted structurally here.
    const id = await seedFullMessage()
    await executor.execute(
      "UPDATE attachments SET local_path = NULL WHERE id = 'att-1'"
    )
    const rebuilt = await rebuildEml(executor, id, {})
    expect(rebuilt!.unavailableAttachments).toEqual(["report.pdf"])
    expect(rebuilt!.eml).toContain(
      'Content-Disposition: attachment; filename="report.pdf"'
    )
  })
})

/** Decode a base64 (possibly CRLF-wrapped) part body to text. */
function decodeBase64Body(wrapped: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(wrapped.replace(/\r\n/g, "")), (char) =>
      char.charCodeAt(0)
    )
  )
}

describe("rebuildEml body shapes", () => {
  it("html-only message: a single top-level text/html part", async () => {
    await seedThread()
    const id = await seedMessage({
      date: 1_700_000_000,
      subject: "Just html",
      fromAddress: "a@b.c",
      bodyHtml: "<p>only</p>",
    })
    const rebuilt = await rebuildEml(executor, id, {})
    const { headers, body } = splitHeaders(rebuilt!.eml)
    expect(headerValue(headers, "content-type")).toBe(
      "text/html; charset=UTF-8"
    )
    expect(headerValue(headers, "content-transfer-encoding")).toBe("base64")
    expect(body).not.toContain("boundary=")
    // The in-repo parse-back (decomposeMimeMessage) handles only the
    // builder's multipart shapes, so the decode is asserted directly.
    expect(decodeBase64Body(body)).toBe("<p>only</p>")
  })

  it("text-only message: a single top-level text/plain part", async () => {
    await seedThread()
    const id = await seedMessage({
      date: 1_700_000_000,
      subject: "Just text",
      fromAddress: "a@b.c",
      bodyText: "plain only",
    })
    const rebuilt = await rebuildEml(executor, id, {})
    const { headers, body } = splitHeaders(rebuilt!.eml)
    expect(headerValue(headers, "content-type")).toBe(
      "text/plain; charset=UTF-8"
    )
    expect(decodeBase64Body(body)).toBe("plain only")
  })

  it("a message with neither body nor attachments exports headers only", async () => {
    await seedThread()
    const id = await seedMessage({
      date: 1_700_000_000,
      subject: "Empty",
      fromAddress: "a@b.c",
    })
    const rebuilt = await rebuildEml(executor, id, {})
    const { headers, body } = splitHeaders(rebuilt!.eml)
    expect(headerValue(headers, "subject")).toBe("Empty")
    expect(headerValue(headers, "content-type")).toBeNull()
    expect(body).toBe("")
  })

  it("inline attachments keep Content-Disposition inline and Content-ID", async () => {
    await seedThread()
    const id = await seedMessage({
      date: 1_700_000_000,
      subject: "Inline image",
      fromAddress: "a@b.c",
      bodyHtml: '<p><img src="cid:logo"></p>',
      hasAttachments: true,
      attachments: [
        {
          id: "att-inline-1",
          filename: "logo.png",
          mimeType: "image/png",
          isInline: true,
          contentId: "logo",
        },
      ],
    })
    const rebuilt = await rebuildEml(executor, id, {})
    expect(rebuilt!.eml).toContain("Content-Disposition: inline; filename=")
    expect(rebuilt!.eml).toContain("Content-ID: <logo>")
  })
})

describe("rebuildEml header-injection hardening", () => {
  it("CRLF in stored header fields cannot start a new header line", async () => {
    await seedThread()
    const id = await seedMessage({
      date: 1_700_000_000,
      // Injected headers via the parsed columns…
      subject: "Hi\r\nBcc: victim@evil.example",
      fromName: "Evil\r\nX-Injected: yes",
      fromAddress: "evil@example.com",
      bodyText: "body",
      // …and via the stored headers JSON.
      headers: JSON.stringify({
        "list-unsubscribe": "<https://x.example>\r\nBcc: victim@evil.example",
      }),
    })
    const rebuilt = await rebuildEml(executor, id, {})
    const lines = rebuilt!.eml.split("\r\n")
    // The unfolded values stay on ONE line each — no line starts with a
    // smuggled header name.
    expect(lines).not.toContain("Bcc: victim@evil.example")
    expect(lines.some((line) => line.startsWith("X-Injected:"))).toBe(false)
    const { headers } = splitHeaders(rebuilt!.eml)
    expect(headerValue(headers, "subject")).toBe("Hi Bcc: victim@evil.example")
  })
})

describe("emlFilename / sanitizeFileStem", () => {
  it("builds <subject>-<date>.eml with unsafe characters blanked", () => {
    expect(emlFilename('Re: plan/for "Q3"?', 1_700_000_000)).toBe(
      "Re plan for Q3-2023-11-14.eml"
    )
    expect(emlFilename(null, 1_700_000_000)).toBe("export-2023-11-14.eml")
    expect(emlFilename("   ", 1_700_000_000)).toBe("export-2023-11-14.eml")
  })

  it("caps the stem length without splitting a code point", () => {
    const long = "é".repeat(100)
    expect(Array.from(sanitizeFileStem(long))).toHaveLength(64)
  })
})

/** Recording writeFile stand-in (plain function — no mock typing noise). */
function recordingWriteFile() {
  const calls: Array<{ path: string; data: Uint8Array }> = []
  return {
    calls,
    async writeFile(path: string, data: Uint8Array) {
      calls.push({ path, data })
    },
  }
}

describe("exportThreadAsEml", () => {
  it("writes one .eml per message (chronological) into the picked directory", async () => {
    const threadId = await seedThread()
    await seedMessage({
      date: 1_700_000_100,
      subject: "First: note",
      fromAddress: "a@b.c",
      bodyText: "one",
    })
    await seedMessage({
      date: 1_700_000_200,
      subject: "Second: note",
      fromAddress: "a@b.c",
      bodyText: "two",
    })

    const writeFile = recordingWriteFile()
    const result = await exportThreadAsEml(executor, threadId, {
      pickDirectory: async () => "/picked/dir",
      writeFile: writeFile.writeFile,
      joinPath: async (dir, name) => `${dir}/${name}`,
    })

    expect(result).not.toBeNull()
    expect(result!.files).toEqual([
      "/picked/dir/First note-2023-11-14.eml",
      "/picked/dir/Second note-2023-11-14.eml",
    ])
    expect(writeFile.calls).toHaveLength(2)
    const first = new TextDecoder().decode(writeFile.calls[0].data)
    expect(first).toContain("Subject: First: note")
    expect(first).toContain("From: a@b.c")
  })

  it("suffixes colliding filenames (case-insensitively)", async () => {
    const threadId = await seedThread()
    await seedMessage({
      date: 1_700_000_100,
      subject: "Report",
      fromAddress: "a@b.c",
      bodyText: "one",
    })
    // Same stem, same day, different case — still a collision on
    // case-preserving and case-insensitive filesystems alike.
    await seedMessage({
      date: 1_700_000_200,
      subject: "report",
      fromAddress: "a@b.c",
      bodyText: "two",
    })

    const writeFile = recordingWriteFile()
    const result = await exportThreadAsEml(executor, threadId, {
      pickDirectory: async () => "/picked",
      writeFile: writeFile.writeFile,
      joinPath: async (dir, name) => `${dir}/${name}`,
    })

    expect(result!.files).toEqual([
      "/picked/Report-2023-11-14.eml",
      "/picked/report-2023-11-14-2.eml",
    ])
  })

  it("resolves null on dialog cancel and never writes", async () => {
    const threadId = await seedThread()
    await seedMessage({ date: 1_700_000_100, bodyText: "one" })
    const writeFile = vi.fn(async () => undefined)

    const result = await exportThreadAsEml(executor, threadId, {
      pickDirectory: async () => null,
      writeFile,
    })

    expect(result).toBeNull()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("a thread without messages never opens the dialog", async () => {
    const threadId = await seedThread()
    const result = await exportThreadAsEml(executor, threadId, {
      pickDirectory: async () => "/picked",
      writeFile: async () => {},
    })
    expect(result).toBeNull()
    expect(openFileDialogMock).not.toHaveBeenCalled()
  })

  it("export is read-only: message rows are untouched", async () => {
    const threadId = await seedThread()
    const id = await seedMessage({
      date: 1_700_000_100,
      subject: "Do not touch",
      bodyText: "one",
      isRead: false,
      isFlagged: true,
    })
    const before = await executor.select(
      "SELECT * FROM messages WHERE id = $1",
      [id]
    )
    await exportThreadAsEml(executor, threadId, {
      pickDirectory: async () => "/picked",
      writeFile: async () => {},
      joinPath: async (dir, name) => `${dir}/${name}`,
    })
    const after = await executor.select(
      "SELECT * FROM messages WHERE id = $1",
      [id]
    )
    expect(after).toEqual(before)
  })

  it("surfaces cache-miss attachments through the export result", async () => {
    const threadId = await seedThread()
    await seedMessage({
      date: 1_700_000_100,
      subject: "With file",
      fromAddress: "a@b.c",
      bodyText: "one",
      hasAttachments: true,
      attachments: [
        {
          id: "att-miss-1",
          filename: "missing.bin",
          mimeType: "application/octet-stream",
        },
      ],
    })
    const result = await exportThreadAsEml(executor, threadId, {
      pickDirectory: async () => "/picked",
      writeFile: async () => {},
      joinPath: async (dir, name) => `${dir}/${name}`,
      fs: cacheFsWith({}),
    })
    expect(result!.unavailableAttachments).toEqual(["missing.bin"])
  })

  it("falls back to the plugin writeFile/join when no seam is injected", async () => {
    const threadId = await seedThread()
    await seedMessage({ date: 1_700_000_100, subject: "Plugin", bodyText: "x" })
    ;(openFileDialogMock as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      "/plugin/dir"
    )

    await exportThreadAsEml(executor, threadId, {
      fs: cacheFsWith({}),
    })

    expect(fsWriteFileMock).toHaveBeenCalledTimes(1)
    const [path, data] = vi.mocked(fsWriteFileMock).mock.calls[0]
    expect(path).toBe("/plugin/dir/Plugin-2023-11-14.eml")
    // Cross-realm note: the bytes come from jsdom's TextEncoder, so an
    // `instanceof` check against the node realm fails — decode instead.
    const bytes = data as Uint8Array
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(new TextDecoder().decode(bytes)).toContain("Subject: Plugin")
  })
})
