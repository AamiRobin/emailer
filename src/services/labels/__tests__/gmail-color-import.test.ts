import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { listLabelsByAccount } from "../../db/labels"
import type {
  EmailFolder,
  EmailProvider,
  FetchMessagesResult,
} from "../../email/types"
import { syncGmailAccount } from "../../sync/gmail-sync"
import {
  fetchGmailLabelColorMap,
  gmailLabelColorImporter,
} from "../gmail-label-colors"

/**
 * Task 10.4 "Gmail label color import": the server's background color hex
 * lands on labels.color through the sync's label pass; locally chosen
 * colors survive when the server carries none.
 */

let executor: TestExecutor
let accountId: string

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor, "gmail")
})

afterEach(() => {
  executor.close()
  vi.restoreAllMocks()
})

function fakeGmailProvider(folders: EmailFolder[]): EmailProvider {
  return {
    accountId,
    type: "gmail",
    listFolders: vi.fn(async () => folders),
    deltaSync: vi.fn(async () => ({
      messages: [],
      nextCursor: "cursor-1",
      needsFullSync: true,
    })),
    fetchMessages: vi.fn(async (): Promise<FetchMessagesResult> => ({
      messages: [],
      folderStatus: { uidValidity: 1, uidNext: 0, exists: 0, unseen: 0 },
    })),
    fetchFlags: vi.fn(async () => []),
    storeFlags: vi.fn(async () => {}),
    markRead: vi.fn(async () => {}),
    markStarred: vi.fn(async () => {}),
    addLabels: vi.fn(async () => {}),
    removeLabels: vi.fn(async () => {}),
    archive: vi.fn(async () => {}),
    trash: vi.fn(async () => {}),
    moveToFolder: vi.fn(async () => {}),
    deleteForever: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => ({ messageId: "x" })),
    appendMessage: vi.fn(async () => {}),
    testConnection: vi.fn(async () => ({ success: true, message: "ok" })),
  }
}

function folder(name: string, id: string): EmailFolder {
  return {
    id,
    name,
    path: name,
    type: "user",
    specialUse: null,
    delimiter: "/",
  }
}

describe("ensureGmailLabels color persistence (via syncGmailAccount)", () => {
  it("persists the server background hex onto the label rows", async () => {
    const provider = fakeGmailProvider([folder("Work", "folder-Work")])

    await syncGmailAccount({
      executor,
      provider,
      accountId,
      listLabelColors: async () =>
        new Map([
          ["Work", "#fb4c2f"],
          ["Ghost", "#000000"], // no matching labels row — ignored
        ]),
    })

    const labels = await listLabelsByAccount(executor, accountId)
    const work = labels.find((label) => label.name === "Work")
    expect(work?.color).toBe("#fb4c2f")
  })

  it("keeps the local color when the server label has none", async () => {
    // Seed a row carrying a locally chosen color (as the create flow does).
    const provider = fakeGmailProvider([folder("Work", "folder-Work")])
    await syncGmailAccount({
      executor,
      provider,
      accountId,
      listLabelColors: async () => new Map([["Work", null]]),
    })
    const seeded = (await listLabelsByAccount(executor, accountId)).find(
      (label) => label.name === "Work"
    )
    expect(seeded).toBeTruthy()

    await executor.execute("UPDATE labels SET color = $1 WHERE id = $2", [
      "var(--chart-3)",
      seeded?.id ?? "",
    ])

    // Second sync, still no server color — the local choice must survive.
    await syncGmailAccount({
      executor,
      provider,
      accountId,
      listLabelColors: async () => new Map([["Work", null]]),
    })
    const after = (await listLabelsByAccount(executor, accountId)).find(
      (label) => label.name === "Work"
    )
    expect(after?.color).toBe("var(--chart-3)")
  })

  it("skips the color pass when the importer fails (best effort)", async () => {
    const provider = fakeGmailProvider([folder("Work", "folder-Work")])
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const summary = await syncGmailAccount({
      executor,
      provider,
      accountId,
      listLabelColors: async () => {
        throw new Error("offline")
      },
    })

    expect(summary.labelsSynced).toBe(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("label color import failed"),
      expect.anything()
    )
    const labels = await listLabelsByAccount(executor, accountId)
    expect(labels.find((label) => label.name === "Work")?.color).toBeNull()
  })
})

describe("fetchGmailLabelColorMap", () => {
  it("decodes the server colors through the provider's mappers", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("/labels")) {
        return new Response(
          JSON.stringify({
            labels: [
              {
                id: "Label_1",
                name: "Work",
                type: "user",
                color: { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
              },
              { id: "Label_2", name: "Plain", type: "user" },
            ],
          }),
          { status: 200 }
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const map = await fetchGmailLabelColorMap(
      {
        id: accountId,
        type: "gmail",
        email: "user@example.com",
        status: "active",
        isActive: true,
        isPinned: false,
        oauthClientId: "client-1",
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        // Pre-decrypted envelope with a fresh access token — no token
        // fetch and no key-store round trip on this path.
        tokenEnvelope: {
          refreshToken: "refresh-1",
          accessToken: "access-1",
          accessTokenExpiresAt: Date.now() + 3_600_000,
        },
      }
    )

    expect(map.get("Work")).toBe("#fb4c2f")
    expect(map.get("Plain")).toBeNull()
    // Only the labels listing ran (the envelope carried a fresh token).
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("throws when the account has no stored token envelope", async () => {
    await expect(
      gmailLabelColorImporter(executor, accountId)()
    ).rejects.toThrow(/no stored token envelope/)
  })
})
