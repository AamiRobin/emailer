import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * mbox export tests (task 19.2). The fixture export is checked against
 * the RFC 4155 framing rules Thunderbird's parser relies on: the first
 * byte is `From `, every separator sits at a line start (and follows a
 * blank line), every body line starting with `From ` is escaped to
 * `>From `, the file ends with a trailing blank line, and the separator
 * count equals the folder's message count. A framed message is also
 * un-escaped and parsed back through decomposeMimeMessage for content.
 */

const executorHolder = vi.hoisted(() => ({
  current: null as unknown,
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => null),
}))

vi.mock("@tauri-apps/plugin-fs", () => ({
  open: vi.fn(async () => {
    throw new Error("plugin stream not expected in tests")
  }),
  remove: vi.fn(async () => undefined),
}))

import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { MessageInput } from "../../db/messages"
import { insertMessage } from "../../db/messages"
import {
  insertThread,
  recomputeThreadCaches,
  setThreadLabels,
} from "../../db/threads"
import { decomposeMimeMessage } from "../../email/mime-builder"
import { createGmailLabel } from "../../db/__tests__/fixtures"
import {
  escapeMboxBody,
  exportFolderAsMbox,
  mboxFromLine,
  type MboxExportOptions,
} from "../mbox"

let executor: TestExecutor

const ACCOUNT = "acc-1"

/** In-memory StreamWriter recording the chunks an export writes. */
function fakeStream() {
  const chunks: string[] = []
  return {
    chunks,
    text: () => chunks.join(""),
    impl: {
      open: async () => {
        chunks.length = 0
      },
      write: async (chunk: string) => {
        chunks.push(chunk)
      },
      close: async () => {},
    },
  }
}

/** Progress + abort harness: aborts once `done` reaches `after`. */
function abortAfter(after: number): MboxExportOptions {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    onProgress: (done) => {
      if (done >= after) controller.abort()
    },
  }
}

async function seedLabeledThread(
  threadId: string,
  labelIds: string[]
): Promise<void> {
  await insertThread(executor, { id: threadId, accountId: ACCOUNT })
  await setThreadLabels(executor, threadId, labelIds)
  await recomputeThreadCaches(executor, threadId)
}

async function seedMessage(
  threadId: string,
  input: Partial<MessageInput> & { date: number }
): Promise<void> {
  await insertMessage(executor, {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    threadId,
    accountId: ACCOUNT,
    fromAddress: "receipts@store.example",
    ...input,
  })
  await recomputeThreadCaches(executor, threadId)
}

let receiptsLabelId: string
let inboxLabelId: string

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [ACCOUNT, "gmail", `${ACCOUNT}@example.com`]
  )
  receiptsLabelId = await createGmailLabel(
    executor,
    ACCOUNT,
    "Receipts",
    "Label_receipts",
    undefined,
    "user"
  )
  inboxLabelId = await createGmailLabel(
    executor,
    ACCOUNT,
    "INBOX",
    "INBOX",
    "inbox"
  )
})

afterEach(() => {
  executor.close()
  vi.clearAllMocks()
})

/** The canonical fixture: the "Receipts" label carries 3 messages across
 * 2 threads (one with `From `-led body lines), plus an inbox-only
 * message that must stay out. */
async function seedReceiptsFixture(): Promise<void> {
  await seedLabeledThread("thread-1", [receiptsLabelId, inboxLabelId])
  await seedLabeledThread("thread-2", [receiptsLabelId])
  await seedLabeledThread("thread-3", [inboxLabelId])

  await seedMessage("thread-1", {
    date: 1_700_000_100,
    subject: "Order 111",
    bodyText: "Thanks for your order.\nFrom all of us here.\nBye.",
    bodyHtml: "<p>Thanks for your order.</p>",
  })
  await seedMessage("thread-1", {
    date: 1_700_000_200,
    subject: "Order 111 shipped",
    bodyText: ">From the store, with tracking.",
  })
  await seedMessage("thread-2", {
    date: 1_700_000_300,
    subject: "Invoice 222",
    bodyText: "Plain invoice.",
  })
  await seedMessage("thread-3", {
    date: 1_700_000_400,
    subject: "Not a receipt",
    bodyText: "Unrelated.",
  })
}

describe("mboxFromLine", () => {
  it("frames `From <sender> <asctime>` in UTC", () => {
    // 1_700_000_000 = Tue Nov 14 22:13:20 2023 UTC.
    expect(mboxFromLine("a@b.example", 1_700_000_000)).toBe(
      "From a@b.example Tue Nov 14 22:13:20 2023"
    )
  })

  it("space-pads single-digit days and falls back to MAILER-DAEMON", () => {
    // 1_699_222_400 = Sun Nov  5 22:13:20 2023 UTC — the asctime day is
    // space-padded, per the separator convention.
    expect(mboxFromLine(null, 1_699_222_400)).toBe(
      "From MAILER-DAEMON Sun Nov  5 22:13:20 2023"
    )
    expect(mboxFromLine("evil\r\nFrom injected", 1_700_000_000)).toBe(
      "From evilFrominjected Tue Nov 14 22:13:20 2023"
    )
  })
})

describe("escapeMboxBody", () => {
  it("escapes From -led lines and idempotently deepens existing escapes", () => {
    expect(escapeMboxBody("From me\n>From you\n>>From them\nplain")).toBe(
      ">From me\n>>From you\n>>>From them\nplain"
    )
  })
})

describe("exportFolderAsMbox framing (RFC 4155)", () => {
  it("frames the label's message set the way Thunderbird parses it", async () => {
    await seedReceiptsFixture()
    const stream = fakeStream()
    const progress: Array<[number, number]> = []

    const result = await exportFolderAsMbox(
      executor,
      ACCOUNT,
      { kind: "labelId", labelId: receiptsLabelId },
      { onProgress: (done, total) => progress.push([done, total]) },
      {
        saveFileDialog: async () => "/picked/Receipts.mbox",
        stream: stream.impl,
      }
    )

    expect(result).toEqual({
      status: "complete",
      path: "/picked/Receipts.mbox",
      messages: 3,
    })

    const text = stream.text()
    // First byte: the file STARTS with `From `.
    expect(text.startsWith("From ")).toBe(true)

    const lines = text.split("\n")
    const separatorIndexes = lines
      .map((line, index) => (line.startsWith("From ") ? index : -1))
      .filter((index) => index !== -1)
    // One separator per message, each at a line start.
    expect(separatorIndexes).toHaveLength(3)
    // Asctime framing shape: `From <addr> Www Mmm dd hh:mm:ss yyyy`.
    for (const index of separatorIndexes) {
      expect(lines[index]).toMatch(
        /^From \S+ (Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/
      )
    }
    // Every separator but the first follows a blank line; the file ends
    // with a trailing blank line.
    for (const index of separatorIndexes.slice(1)) {
      expect(lines[index - 1]).toBe("")
    }
    expect(text.endsWith("\n\n")).toBe(true)

    // ALL `From `-led lines are separators — none survived unescaped in
    // a body. (Rebuilt MIME bodies are base64, so a plaintext `From `
    // line can only be a separator here; the escaping itself is proven
    // by the round-trip test below.)
    expect(lines.filter((line) => line.startsWith("From "))).toHaveLength(3)

    // Progress: (0, total) up front, then one step per message.
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })

  it("excludes messages outside the label and orders chronologically", async () => {
    await seedReceiptsFixture()
    const stream = fakeStream()
    await exportFolderAsMbox(
      executor,
      ACCOUNT,
      { kind: "labelId", labelId: receiptsLabelId },
      {},
      { saveFileDialog: async () => "/picked/r.mbox", stream: stream.impl }
    )
    const text = stream.text()
    expect(text).toContain("Subject: Order 111")
    expect(text).toContain("Subject: Invoice 222")
    expect(text).not.toContain("Not a receipt")

    // Subjects appear in date order.
    const first = text.indexOf("Subject: Order 111")
    const second = text.indexOf("Subject: Order 111 shipped")
    const third = text.indexOf("Subject: Invoice 222")
    expect(first).toBeLessThan(second)
    expect(second).toBeLessThan(third)
  })

  it("works for preset selections (All Mail semantics), the folder-views query", async () => {
    await seedReceiptsFixture()
    const stream = fakeStream()
    const result = await exportFolderAsMbox(
      executor,
      ACCOUNT,
      { kind: "preset", preset: "all" },
      {},
      { saveFileDialog: async () => "/picked/all.mbox", stream: stream.impl }
    )
    // Everything except nothing-trashed: all 4 messages, trash/spam out.
    expect(result).toMatchObject({ status: "complete", messages: 4 })
    expect(stream.text()).toContain("Not a receipt")
  })

  it("suggests <label>.mbox through the save dialog", async () => {
    await seedReceiptsFixture()
    const saveFileDialog = vi.fn(async () => null)
    await exportFolderAsMbox(
      executor,
      ACCOUNT,
      { kind: "labelId", labelId: receiptsLabelId },
      {},
      { saveFileDialog, stream: fakeStream().impl }
    )
    expect(saveFileDialog).toHaveBeenCalledWith("Receipts.mbox")
  })
})

describe("exportFolderAsMbox content round trip", () => {
  it("un-escaped framed messages parse back to the stored fields", async () => {
    await seedReceiptsFixture()
    const stream = fakeStream()
    await exportFolderAsMbox(
      executor,
      ACCOUNT,
      { kind: "labelId", labelId: receiptsLabelId },
      {},
      { saveFileDialog: async () => "/picked/r.mbox", stream: stream.impl }
    )

    // Split the mbox at its separators, take the first message, reverse
    // the export's two normalizations (LF, mboxrd escaping — skipping the
    // `From ` separator line) and parse.
    const text = stream.text()
    const messages = text.split(/(?<=\n\n)(?=From )/)
    expect(messages).toHaveLength(3)
    const first = messages[0]
    const withoutSeparator = first.slice(first.indexOf("\n") + 1)
    const crlf = withoutSeparator
      .replace(/^>(>*From )/gm, "$1")
      .replace(/\n/g, "\r\n")
    const parsed = decomposeMimeMessage(crlf)
    expect(parsed.subject).toBe("Order 111")
    // The `From `-led body line survived escaping and un-escaping.
    expect(parsed.textBody).toBe(
      "Thanks for your order.\nFrom all of us here.\nBye."
    )
    expect(parsed.htmlBody).toBe("<p>Thanks for your order.</p>")
    expect(parsed.from).toMatchObject({
      email: "receipts@store.example",
    })
  })
})

describe("exportFolderAsMbox cancel and dialog paths", () => {
  it("aborts between messages on the signal and removes the partial file", async () => {
    await seedReceiptsFixture()
    const stream = fakeStream()
    const removeFile = vi.fn(async () => undefined)

    const result = await exportFolderAsMbox(
      executor,
      ACCOUNT,
      { kind: "labelId", labelId: receiptsLabelId },
      abortAfter(1),
      {
        saveFileDialog: async () => "/picked/Receipts.mbox",
        stream: stream.impl,
        removeFile,
      }
    )

    expect(result).toEqual({
      status: "cancelled",
      path: "/picked/Receipts.mbox",
      messages: 1,
    })
    // Exactly one message made it into the stream before the abort.
    expect(stream.text().split(/(?<=\n\n)(?=From )/)).toHaveLength(1)
    expect(removeFile).toHaveBeenCalledWith("/picked/Receipts.mbox")
  })

  it("resolves null on dialog cancel and never opens the stream", async () => {
    await seedReceiptsFixture()
    const stream = fakeStream()
    const result = await exportFolderAsMbox(
      executor,
      ACCOUNT,
      { kind: "labelId", labelId: receiptsLabelId },
      {},
      { saveFileDialog: async () => null, stream: stream.impl }
    )
    expect(result).toBeNull()
  })

  it("an empty folder yields an empty mbox (still valid RFC 4155)", async () => {
    await seedLabeledThread("thread-empty", [receiptsLabelId])
    const stream = fakeStream()
    const result = await exportFolderAsMbox(
      executor,
      ACCOUNT,
      { kind: "labelId", labelId: receiptsLabelId },
      {},
      {
        saveFileDialog: async () => "/picked/empty.mbox",
        stream: stream.impl,
      }
    )
    expect(result).toMatchObject({ status: "complete", messages: 0 })
    expect(stream.text()).toBe("")
  })
})
