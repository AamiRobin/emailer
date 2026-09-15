import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"
import { createMessage, createThread } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import type { AttachmentInput, MessageRow } from "@/services/db/messages"
import { updateMessage } from "@/services/db/messages"
import type { EmailAccount } from "@/services/email/types"
import type { AttachmentDeps, FetchAttachmentFn } from "@/services/attachments"
import { MailDisplay } from "../mail-display"

/**
 * MailDisplay body tests (task 7.7): `cid:` refs in a message's html
 * resolve to the message's OWN inline attachment parts through the
 * attachment cache and render as data: URIs — including while remote
 * images stay blocked. The REAL ensureAttachmentCached runs with FAKE
 * deps injected through the attachmentDeps prop (no server, no disk);
 * the executor module is mocked to hand back the seeded node:sqlite
 * executor (same seam as the thread-view suite).
 */

const executorHolder = vi.hoisted(() => ({
  current: null as SqlExecutor | null,
}))

vi.mock("@/services/db/executor", () => ({
  getExecutor: () => {
    const executor = executorHolder.current
    if (!executor) throw new Error("test executor not set")
    return executor
  },
  placeholders: (count: number, firstIndex = 1): string =>
    Array.from({ length: count }, (_, index) => `$${index + firstIndex}`).join(
      ", "
    ),
}))

let executor: TestExecutor
let accountId: string

const account: EmailAccount = {
  id: "acc-1",
  type: "gmail",
  email: "me@example.com",
  status: "active",
  isActive: true,
  isPinned: false,
}

/** Fake cache seams: cache always misses, bytes come from the injected fn. */
function fakeDeps(fetchAttachment: FetchAttachmentFn): AttachmentDeps {
  return {
    fetchAttachment,
    fs: {
      ensureCacheDir: async () => {},
      writeFile: async () => {},
      readFile: async () => {
        throw new Error("not cached")
      },
      removeFile: async () => {},
    },
    hash: async (key: string) => `hash-${key.length}`,
  }
}

/** Fetch seam returning the classic 4 bytes, under a vi.fn for asserts. */
function fakeFetch(bytes: Uint8Array = new Uint8Array([1, 2, 3, 4])) {
  return vi.fn<FetchAttachmentFn>().mockResolvedValue(bytes)
}

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  cleanup()
  executorHolder.current = null
  executor.close()
})

/** Seed one expanded-ready message and return its full row. */
async function seedMessage(
  bodyHtml: string,
  attachments?: AttachmentInput[]
): Promise<MessageRow> {
  accountId = "acc-1"
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [accountId, "gmail", account.email]
  )
  const threadId = await createThread(executor, accountId, {
    subject: "With images",
  })
  const messageId = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000,
    fromName: "Ada Lovelace",
    fromAddress: "ada@example.com",
    isRead: false,
    hasAttachments: attachments !== undefined && attachments.length > 0,
    attachments,
  })
  if (bodyHtml) {
    await updateMessage(executor, messageId, { bodyHtml })
  }
  const rows = await executor.select<MessageRow>(
    "SELECT * FROM messages WHERE id = $1",
    [messageId]
  )
  if (!rows[0]) throw new Error("seeded message row missing")
  return rows[0]
}

function renderDisplay(
  message: MessageRow,
  deps?: AttachmentDeps,
  imagesAllowed = false
): ReturnType<typeof render> {
  return render(
    <MailDisplay
      message={message}
      threadSubject="With images"
      imagesAllowed={imagesAllowed}
      onAllowSender={vi.fn()}
      initiallyUnread={false}
      expanded={true}
      onToggleExpanded={vi.fn()}
      account={account}
      attachmentDeps={deps}
    />
  )
}

function frameSrcdoc(): string {
  const frame = document.querySelector("iframe")
  if (!frame) throw new Error("no email frame rendered")
  return frame.getAttribute("srcdoc") ?? ""
}

const INLINE_LOGO: AttachmentInput[] = [
  {
    id: "att-1",
    filename: "logo.png",
    mimeType: "image/png",
    size: 4,
    contentId: "image001@example.com",
    isInline: true,
    providerPartId: "1.2",
  },
]

describe("task 7.7: cid: inline image resolution", () => {
  it("resolves cid: refs to data URIs via the attachment cache", async () => {
    const message = await seedMessage(
      '<p>Hi <img src="cid:image001@example.com" alt="logo"></p>',
      INLINE_LOGO
    )
    const fetchAttachment = fakeFetch()
    renderDisplay(message, fakeDeps(fetchAttachment))

    const srcdoc = await waitFor(() => {
      const doc = frameSrcdoc()
      expect(doc).toContain('src="data:image/png;base64,AQIDBA=="')
      return doc
    })
    expect(srcdoc).toContain("Hi")
    expect(srcdoc).not.toContain("cid:")
    // One cache-miss fetch through the injected deps for the matched row.
    expect(fetchAttachment).toHaveBeenCalledTimes(1)
    expect(fetchAttachment.mock.calls[0][2]).toMatchObject({ id: "att-1" })
  })

  it("matches content ids case-insensitively, with or without angle brackets", async () => {
    const message = await seedMessage(
      '<p><img src="cid:IMAGE001@Example.COM"></p>',
      [
        {
          id: "att-2",
          filename: "pic.png",
          mimeType: "image/png",
          size: 4,
          contentId: "<image001@example.com>",
          isInline: true,
        },
      ]
    )
    renderDisplay(message, fakeDeps(fakeFetch()))

    await waitFor(() =>
      expect(frameSrcdoc()).toContain('src="data:image/png;base64,AQIDBA=="')
    )
  })

  it("leaves unmatched cid: refs untouched and fetches nothing", async () => {
    const message = await seedMessage(
      '<p><img src="cid:missing@example.com"></p>',
      INLINE_LOGO
    )
    const fetchAttachment = fakeFetch()
    renderDisplay(message, fakeDeps(fetchAttachment))

    await waitFor(() =>
      expect(frameSrcdoc()).toContain('src="cid:missing@example.com"')
    )
    expect(frameSrcdoc()).not.toContain("data:image/png")
    expect(fetchAttachment).not.toHaveBeenCalled()
  })

  it("renders a cid: body without any attachments without blocking", async () => {
    const message = await seedMessage('<p><img src="cid:solo@example.com"></p>')
    renderDisplay(message, fakeDeps(fakeFetch()))

    await waitFor(() =>
      expect(frameSrcdoc()).toContain('src="cid:solo@example.com"')
    )
  })

  it("renders cid: refs as-is without an account (no loading state)", async () => {
    const message = await seedMessage(
      '<p><img src="cid:image001@example.com"></p>',
      INLINE_LOGO
    )
    render(
      <MailDisplay
        message={message}
        threadSubject="With images"
        imagesAllowed={false}
        onAllowSender={vi.fn()}
        initiallyUnread={false}
        expanded={true}
        onToggleExpanded={vi.fn()}
        account={null}
        attachmentDeps={fakeDeps(fakeFetch())}
      />
    )
    // Without the account identity the fetch cannot run: the body renders
    // directly with the refs untouched — never stuck loading.
    expect(screen.queryByTestId("email-body-loading")).toBeNull()
    await waitFor(() =>
      expect(frameSrcdoc()).toContain('src="cid:image001@example.com"')
    )
  })

  it("keeps remote images blocked while cid: images resolve", async () => {
    const message = await seedMessage(
      '<p><img src="https://track.example.com/pixel.png">' +
        '<img src="cid:image001@example.com"></p>',
      INLINE_LOGO
    )
    renderDisplay(message, fakeDeps(fakeFetch()), false)

    const srcdoc = await waitFor(() => {
      const doc = frameSrcdoc()
      expect(doc).toContain('src="data:image/png;base64,AQIDBA=="')
      return doc
    })
    // The remote image stays blocked behind the placeholder, with the
    // original URL parked in data-original-src only.
    expect(srcdoc).toContain("data-original-src")
    expect(srcdoc).toContain('src="data:image/gif;base64,')
    expect(srcdoc).not.toMatch(/\ssrc="https:/)
    expect(screen.getByTestId("images-banner")).not.toBeNull()
  })

  it("shows a loading body until resolution settles", async () => {
    const message = await seedMessage(
      '<p><img src="cid:image001@example.com"></p>',
      INLINE_LOGO
    )
    let release!: (bytes: Uint8Array) => void
    const gate = new Promise<Uint8Array>((resolve) => {
      release = resolve
    })
    const fetchAttachment = vi.fn<FetchAttachmentFn>().mockReturnValue(gate)
    renderDisplay(message, fakeDeps(fetchAttachment))

    // Still resolving: the loading body state, no frame yet.
    expect(screen.getByTestId("email-body-loading")).not.toBeNull()
    expect(document.querySelector("iframe")).toBeNull()

    release(new Uint8Array([1, 2, 3, 4]))
    await waitFor(() =>
      expect(frameSrcdoc()).toContain('src="data:image/png;base64,AQIDBA=="')
    )
  })

  it("memoizes resolution per message id across remounts", async () => {
    const message = await seedMessage(
      '<p><img src="cid:image001@example.com"></p>',
      INLINE_LOGO
    )
    const fetchAttachment = fakeFetch()
    const deps = fakeDeps(fetchAttachment)

    const { unmount } = renderDisplay(message, deps)
    await waitFor(() =>
      expect(frameSrcdoc()).toContain('src="data:image/png;base64,AQIDBA=="')
    )
    expect(fetchAttachment).toHaveBeenCalledTimes(1)
    unmount()

    // Remount (collapse/expand): served from the per-message memo.
    renderDisplay(message, deps)
    await waitFor(() =>
      expect(frameSrcdoc()).toContain('src="data:image/png;base64,AQIDBA=="')
    )
    expect(fetchAttachment).toHaveBeenCalledTimes(1)
  })

  it("degrades to the unresolved body when resolution fails", async () => {
    const message = await seedMessage(
      '<p><img src="cid:image001@example.com"></p>',
      INLINE_LOGO
    )
    const failing = vi
      .fn<FetchAttachmentFn>()
      .mockRejectedValue(new Error("server unreachable"))
    renderDisplay(message, fakeDeps(failing))

    await waitFor(() =>
      expect(frameSrcdoc()).toContain('src="cid:image001@example.com"')
    )
    expect(screen.queryByTestId("email-body-loading")).toBeNull()
  })
})
