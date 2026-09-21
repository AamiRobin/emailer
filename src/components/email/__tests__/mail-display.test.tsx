import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}))
import { createMessage, createThread } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { listContactsByAccount, upsertContact } from "@/services/db/contacts"
import { insertLabel } from "@/services/db/labels"
import { setThreadFolder } from "@/services/db/threads"
import { setJunkFilterEnabledPreference } from "@/services/settings/preferences"
import type { AttachmentInput, MessageRow } from "@/services/db/messages"
import { updateMessage } from "@/services/db/messages"
import type { EmailAccount } from "@/services/email/types"
import type {
  AttachmentDeps,
  FetchAttachmentFn,
  FileActionDeps,
} from "@/services/attachments"
import {
  NO_SIGNATURE,
  PgpReceiveError,
  type PgpReceiveUiDeps,
} from "@/services/crypto/pgp-receive"
import { MailDisplay } from "../mail-display"
import { useComposerStore } from "@/stores/composer-store"
import { useUiStore } from "@/stores/ui-store"
import { useOnlineStore } from "@/stores/online-store"
import { toast } from "sonner"
import type {
  UnsubscribeDeps,
  UnsubscribePostFn,
} from "@/services/security/unsubscribe"

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

vi.mock("@/services/db/contacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/db/contacts")>()
  return {
    ...actual,
    // Spy wrapper: the contacts-memoization test counts queries; every
    // other test keeps the real behavior.
    listContactsByAccount: vi.fn(actual.listContactsByAccount),
  }
})

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
  attachments?: AttachmentInput[],
  from?: { name?: string | null; address?: string | null }
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
    fromName: from?.name ?? "Ada Lovelace",
    fromAddress: from?.address ?? "ada@example.com",
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
  deps?: FileActionDeps,
  imagesAllowed = false,
  pgpDeps?: PgpReceiveUiDeps
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
      pgpDeps={pgpDeps}
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

// ---------------------------------------------------------------------------
// Phishing warnings (task 18.1, design D12)
// ---------------------------------------------------------------------------

describe("task 18.1: phishing warnings", () => {
  /**
   * Seed the known contact the spoof fixtures impersonate, plus a message
   * with an attacker-chosen From header (seedMessage creates the account).
   */
  async function seedSpoofScenario(
    bodyHtml: string,
    from: { name?: string | null; address?: string | null }
  ): Promise<MessageRow> {
    const message = await seedMessage(bodyHtml, undefined, from)
    await upsertContact(executor, accountId, {
      name: "Ada Lovelace",
      email: "ada@example.com",
    })
    return message
  }

  it("renders the warning banner for a message with a finding", async () => {
    // A known contact's display name sent from an address that is NOT the
    // contact's — the classic spoof play — plus a mismatched link.
    const message = await seedSpoofScenario(
      '<p>Pay now: <a href="http://evil.ru/pay">https://ada.example.com</a></p>',
      { name: "Ada Lovelace", address: "ceo-paypal-xxx@spam.io" }
    )
    renderDisplay(message, fakeDeps(fakeFetch()))

    const banner = await waitFor(() =>
      expect(screen.getByTestId("phishing-banner")).not.toBeNull()
    )
    expect(banner).toBeDefined()
    expect(screen.getByTestId("phishing-banner").textContent).toContain(
      "ceo-paypal-xxx@spam.io"
    )
    expect(screen.getByTestId("phishing-banner").textContent).toContain(
      "evil.ru"
    )
    // The body still renders — advisory, never blocked (spec).
    await waitFor(() => expect(frameSrcdoc()).toContain("Pay now"))
  })

  it("renders no banner for a clean message", async () => {
    const message = await seedSpoofScenario(
      '<p>Here is the <a href="https://example.com/paper">paper</a>.</p>',
      { name: "Random Stranger", address: "random@stranger.io" }
    )
    renderDisplay(message, fakeDeps(fakeFetch()))

    await waitFor(() => expect(frameSrcdoc()).toContain("paper"))
    expect(screen.queryByTestId("phishing-banner")).toBeNull()
  })

  it("dismisses the banner on click", async () => {
    const message = await seedSpoofScenario("<p>Hello</p>", {
      name: "Ada Lovelace",
      address: "impostor@spam.io",
    })
    renderDisplay(message, fakeDeps(fakeFetch()))

    await waitFor(() =>
      expect(screen.getByTestId("phishing-banner")).not.toBeNull()
    )
    fireEvent.click(screen.getByTestId("dismiss-phishing"))
    expect(screen.queryByTestId("phishing-banner")).toBeNull()
    // The body was never blocked.
    await waitFor(() => expect(frameSrcdoc()).toContain("Hello"))
  })

  it("does not flag the real contact writing from their own address", async () => {
    const message = await seedSpoofScenario("<p>Lunch?</p>", {
      name: "Ada Lovelace",
      address: "ada@example.com",
    })
    renderDisplay(message, fakeDeps(fakeFetch()))

    await waitFor(() => expect(frameSrcdoc()).toContain("Lunch?"))
    expect(screen.queryByTestId("phishing-banner")).toBeNull()
  })

  it("renders the banner for a confusable sender domain", async () => {
    // A known paypal.com contact; the mail arrives from the leet
    // look-alike paypa1.com — fixture for the third detector class.
    const message = await seedMessage("<p>Verify your account</p>", undefined, {
      name: "PayPal Support",
      address: "support@paypa1.com",
    })
    await upsertContact(executor, accountId, {
      name: "PayPal",
      email: "service@paypal.com",
    })
    renderDisplay(message, fakeDeps(fakeFetch()))

    const banner = await waitFor(() =>
      expect(screen.getByTestId("phishing-banner")).not.toBeNull()
    )
    expect(banner).toBeDefined()
    expect(screen.getByTestId("phishing-banner").textContent).toContain(
      "paypa1.com"
    )
    // Advisory only — the body still renders.
    await waitFor(() => expect(frameSrcdoc()).toContain("Verify your account"))
  })
})

// ---------------------------------------------------------------------------
// PGP receive (task 18.6)
// ---------------------------------------------------------------------------

const ARMORED_ENCRYPTED =
  "-----BEGIN PGP MESSAGE-----\nfake encrypted body\n-----END PGP MESSAGE-----"

const ARMORED_SIGNED =
  "-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n-----BEGIN PGP SIGNATURE-----\nfake signature\n-----END PGP SIGNATURE-----"

/**
 * PGP receive tests (task 18.6): the crypto runs through the pgpDeps
 * seam with FAKES (canned results / typed PgpReceiveError rejections) so
 * the jsdom realm stays openpgp-free; what is under test is the
 * detection-driven UI flow — unlock affordance, passphrase dialog,
 * trust banners, and the failure paths that keep the original content
 * rendering. Decrypted content must surface INSIDE the sanitized frame.
 */
describe("task 18.6: PGP receive", () => {
  /** PgpReceiveUiDeps whose calls fail loudly unless overridden. */
  function fakePgpDeps(overrides: Partial<PgpReceiveUiDeps>): PgpReceiveUiDeps {
    return {
      decryptArmored: vi
        .fn()
        .mockRejectedValue(new Error("unexpected decrypt")),
      verifyClearSigned: vi
        .fn()
        .mockRejectedValue(new Error("unexpected verify")),
      ...overrides,
    }
  }

  /** Seed a plain-text body message (the inline PGP carrier). */
  async function seedTextMessage(bodyText: string): Promise<MessageRow> {
    const seeded = await seedMessage("")
    await updateMessage(executor, seeded.id, { bodyText })
    const rows = await executor.select<MessageRow>(
      "SELECT * FROM messages WHERE id = $1",
      [seeded.id]
    )
    if (!rows[0]) throw new Error("seeded message row missing")
    return rows[0]
  }

  function openDialog(): HTMLFormElement {
    const dialog = document.querySelector(
      '[data-testid="pgp-passphrase-dialog"]'
    )
    if (!dialog) throw new Error("passphrase dialog not open")
    const form = dialog.querySelector("form")
    if (!form) throw new Error("dialog form missing")
    return form
  }

  /** Open the dialog with the banner button and submit a passphrase. */
  function submitPassphrase(passphrase: string): void {
    fireEvent.change(screen.getByTestId("pgp-passphrase-input"), {
      target: { value: passphrase },
    })
    fireEvent.submit(openDialog())
  }

  it("decrypts inline armored blocks after the passphrase entry", async () => {
    const message = await seedTextMessage(`hello\n${ARMORED_ENCRYPTED}\nbye`)
    const decryptArmored = vi.fn().mockResolvedValue({
      html: null,
      text: "the secret plan",
      signature: NO_SIGNATURE,
    })
    renderDisplay(message, undefined, false, fakePgpDeps({ decryptArmored }))

    // Before unlocking: the ORIGINAL content renders, banner offers Decrypt.
    await waitFor(() => expect(frameSrcdoc()).toContain("BEGIN PGP MESSAGE"))
    expect(screen.queryByTestId("pgp-signature-banner")).toBeNull()
    fireEvent.click(screen.getByTestId("pgp-decrypt-button"))
    submitPassphrase("correct horse")

    // The decrypted text replaces the armor INSIDE the sanitized frame.
    const srcdoc = await waitFor(() => {
      const doc = frameSrcdoc()
      expect(doc).toContain("the secret plan")
      return doc
    })
    expect(srcdoc).not.toContain("BEGIN PGP MESSAGE")
    // The seam got the per-use passphrase and the exact armor — and a
    // successful decrypt closes the dialog.
    expect(decryptArmored).toHaveBeenCalledTimes(1)
    expect(decryptArmored.mock.calls[0][0]).toMatchObject({
      accountId: "acc-1",
      passphrase: "correct horse",
      armored: ARMORED_ENCRYPTED,
    })
    expect(screen.queryByTestId("pgp-passphrase-dialog")).toBeNull()
  })

  it("re-prompts inside the dialog on a wrong passphrase", async () => {
    const message = await seedTextMessage(ARMORED_ENCRYPTED)
    const decryptArmored = vi
      .fn()
      .mockRejectedValueOnce(
        new PgpReceiveError(
          "wrong-passphrase",
          "the passphrase does not unlock any of this account's private keys"
        )
      )
      .mockResolvedValueOnce({
        html: null,
        text: "second try worked",
        signature: NO_SIGNATURE,
      })
    renderDisplay(message, undefined, false, fakePgpDeps({ decryptArmored }))

    await waitFor(() => expect(frameSrcdoc()).toContain("BEGIN PGP MESSAGE"))
    fireEvent.click(screen.getByTestId("pgp-decrypt-button"))
    submitPassphrase("wrong")

    // The dialog stays open with the per-attempt error; the armor stays.
    const error = await waitFor(() =>
      expect(screen.getByTestId("pgp-passphrase-error").textContent).toContain(
        "does not unlock"
      )
    )
    expect(error).toBeDefined()
    expect(frameSrcdoc()).toContain("BEGIN PGP MESSAGE")

    submitPassphrase("correct horse")
    await waitFor(() => expect(frameSrcdoc()).toContain("second try worked"))
    expect(decryptArmored).toHaveBeenCalledTimes(2)
  })

  it("shows the original content with an error banner when decryption fails", async () => {
    const message = await seedTextMessage(`header\n${ARMORED_ENCRYPTED}`)
    const decryptArmored = vi
      .fn()
      .mockRejectedValue(
        new PgpReceiveError(
          "no-matching-key",
          "none of your unlocked private keys can decrypt this message"
        )
      )
    renderDisplay(message, undefined, false, fakePgpDeps({ decryptArmored }))

    await waitFor(() => expect(frameSrcdoc()).toContain("BEGIN PGP MESSAGE"))
    fireEvent.click(screen.getByTestId("pgp-decrypt-button"))
    submitPassphrase("whatever")

    const banner = await waitFor(() =>
      expect(screen.getByTestId("pgp-error-banner").textContent).toContain(
        "decrypt this message"
      )
    )
    expect(banner).toBeDefined()
    // Failure keeps the original encrypted content (the raw armor) and
    // the dialog is gone — the thread always opens.
    expect(frameSrcdoc()).toContain("BEGIN PGP MESSAGE")
    expect(screen.queryByTestId("pgp-passphrase-dialog")).toBeNull()
  })

  it("verifies inline clear-signed blocks without a passphrase", async () => {
    const message = await seedTextMessage(`look\n${ARMORED_SIGNED}\nend`)
    const verifyClearSigned = vi.fn().mockResolvedValue({
      content: "the signed body",
      signature: { trust: "valid", keyIds: ["ABCD1234"] },
    })
    renderDisplay(message, undefined, false, fakePgpDeps({ verifyClearSigned }))

    await waitFor(() =>
      expect(screen.getByTestId("pgp-signature-banner")).not.toBeNull()
    )
    const banner = screen.getByTestId("pgp-signature-banner")
    expect(banner.getAttribute("data-signature")).toBe("valid")
    await waitFor(() => expect(frameSrcdoc()).toContain("the signed body"))
    expect(frameSrcdoc()).not.toContain("BEGIN PGP SIGNATURE")
    // No passphrase was ever needed.
    expect(screen.queryByTestId("pgp-passphrase-dialog")).toBeNull()
    expect(verifyClearSigned.mock.calls[0][0].clearSigned).toBe(ARMORED_SIGNED)
  })

  it("shows unknown-signer for a signature whose key is not imported", async () => {
    const message = await seedTextMessage(ARMORED_SIGNED)
    const verifyClearSigned = vi.fn().mockResolvedValue({
      content: "unknown signer body",
      signature: { trust: "unknown-signer", keyIds: ["DEADBEEF"] },
    })
    renderDisplay(message, undefined, false, fakePgpDeps({ verifyClearSigned }))

    await waitFor(() =>
      expect(screen.getByTestId("pgp-signature-banner")).not.toBeNull()
    )
    const banner = screen.getByTestId("pgp-signature-banner")
    expect(banner.getAttribute("data-signature")).toBe("unknown-signer")
    // The content still renders — trust is advisory.
    await waitFor(() => expect(frameSrcdoc()).toContain("unknown signer body"))
  })

  it("shows signature-invalid for a tampered signed block", async () => {
    const message = await seedTextMessage(ARMORED_SIGNED)
    const verifyClearSigned = vi.fn().mockResolvedValue({
      content: "tampered body",
      signature: { trust: "invalid", keyIds: ["ABCD1234"] },
    })
    renderDisplay(message, undefined, false, fakePgpDeps({ verifyClearSigned }))

    await waitFor(() =>
      expect(screen.getByTestId("pgp-signature-banner")).not.toBeNull()
    )
    const banner = screen.getByTestId("pgp-signature-banner")
    expect(banner.getAttribute("data-signature")).toBe("invalid")
    expect(banner.textContent).toContain("FAILED")
  })

  it("keeps the raw block and shows an error when verification fails", async () => {
    const message = await seedTextMessage(ARMORED_SIGNED)
    const verifyClearSigned = vi
      .fn()
      .mockRejectedValue(
        new PgpReceiveError(
          "bad-armor",
          "the signed block is not a readable OpenPGP clear-signed message"
        )
      )
    renderDisplay(message, undefined, false, fakePgpDeps({ verifyClearSigned }))

    const banner = await waitFor(() =>
      expect(screen.getByTestId("pgp-error-banner").textContent).toContain(
        "not a readable"
      )
    )
    expect(banner).toBeDefined()
    // The original armored text is retained (failure shows raw content).
    expect(frameSrcdoc()).toContain("BEGIN PGP SIGNATURE")
    expect(screen.queryByTestId("pgp-signature-banner")).toBeNull()
  })

  it("decrypts a PGP/MIME payload fetched through the attachment cache", async () => {
    const message = await seedMessage("", [
      {
        id: "att-enc",
        filename: "encrypted.asc",
        mimeType: "application/octet-stream",
        size: 32,
        isInline: false,
      },
    ])
    const decryptArmored = vi.fn().mockResolvedValue({
      html: "<p>mime secret</p>",
      text: null,
      signature: { trust: "valid", keyIds: ["KEY1"] },
    })
    const payloadText = "Version: 1\n" + ARMORED_ENCRYPTED
    renderDisplay(
      message,
      fakeDeps(fakeFetch(new TextEncoder().encode(payloadText))),
      false,
      fakePgpDeps({ decryptArmored })
    )

    // No stored body: the banner + (no content) before unlocking.
    const banner = await waitFor(() =>
      expect(screen.getByTestId("pgp-encrypted-banner")).not.toBeNull()
    )
    expect(banner).toBeDefined()
    fireEvent.click(screen.getByTestId("pgp-decrypt-button"))
    submitPassphrase("mime passphrase")

    await waitFor(() => expect(frameSrcdoc()).toContain("mime secret"))
    expect(decryptArmored.mock.calls[0][0].armored).toBe(ARMORED_ENCRYPTED)
    await waitFor(() =>
      expect(screen.getByTestId("pgp-signature-banner")).not.toBeNull()
    )
    const banner2 = screen.getByTestId("pgp-signature-banner")
    expect(banner2.getAttribute("data-signature")).toBe("valid")
  })

  it("keeps showing the encrypted banner and error when the PGP/MIME payload cannot be opened", async () => {
    const message = await seedMessage("", [
      {
        id: "att-enc",
        filename: "encrypted.asc",
        mimeType: "application/octet-stream",
        size: 32,
        isInline: false,
      },
    ])
    const decryptArmored = vi
      .fn()
      .mockRejectedValue(
        new PgpReceiveError(
          "no-private-key",
          "this account has no private PGP key; generate or import one in settings to decrypt this message"
        )
      )
    renderDisplay(
      message,
      fakeDeps(fakeFetch(new TextEncoder().encode(ARMORED_ENCRYPTED))),
      false,
      fakePgpDeps({ decryptArmored })
    )

    await waitFor(() =>
      expect(screen.getByTestId("pgp-encrypted-banner")).not.toBeNull()
    )
    fireEvent.click(screen.getByTestId("pgp-decrypt-button"))
    submitPassphrase("any")

    const banner = await waitFor(() =>
      expect(screen.getByTestId("pgp-error-banner").textContent).toContain(
        "no private PGP key"
      )
    )
    expect(banner).toBeDefined()
    // The thread still renders the message (no crash, no blocked body).
    expect(screen.getByTestId("message-expanded")).not.toBeNull()
  })

  it("flags a standalone PGP/MIME-signed message without verification claims", async () => {
    const message = await seedMessage("<p>the signed content</p>", [
      {
        id: "att-sig",
        filename: "signature.asc",
        mimeType: "application/pgp-signature",
        size: 32,
        isInline: false,
      },
    ])
    renderDisplay(message, fakeDeps(fakeFetch()), false, fakePgpDeps({}))

    await waitFor(() =>
      expect(screen.getByTestId("pgp-mime-signed-banner")).not.toBeNull()
    )
    const banner = screen.getByTestId("pgp-mime-signed-banner")
    expect(banner.textContent).toContain("cannot be verified")
    // The body renders normally; no trust is claimed.
    await waitFor(() => expect(frameSrcdoc()).toContain("the signed content"))
    expect(screen.queryByTestId("pgp-signature-banner")).toBeNull()
  })

  it("serves the decrypted result from the per-message memo on remount", async () => {
    const message = await seedTextMessage(ARMORED_ENCRYPTED)
    const decryptArmored = vi.fn().mockResolvedValue({
      html: null,
      text: "memoized secret",
      signature: NO_SIGNATURE,
    })
    const deps = fakePgpDeps({ decryptArmored })
    const first = renderDisplay(message, undefined, false, deps)

    await waitFor(() => expect(frameSrcdoc()).toContain("BEGIN PGP MESSAGE"))
    fireEvent.click(screen.getByTestId("pgp-decrypt-button"))
    submitPassphrase("correct horse")
    await waitFor(() => expect(frameSrcdoc()).toContain("memoized secret"))
    first.unmount()

    // Remount (collapse/expand): no second prompt, no second decrypt.
    renderDisplay(message, undefined, false, deps)
    await waitFor(() => expect(frameSrcdoc()).toContain("memoized secret"))
    expect(decryptArmored).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("pgp-passphrase-dialog")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Attachment security (tasks 18.8/18.9, designs D17/D18)
// ---------------------------------------------------------------------------

describe("tasks 18.8/18.9: dangerous attachment warnings + malware lookup", () => {
  /** Unique ids PER TEST: the file-actions first-open memory (D17) is a
   * module-level Set that lives for this whole file's run, so two tests
   * sharing an attachment id would leak a confirmation between them. */
  function dangerousAttachments(idSuffix: string): AttachmentInput[] {
    return [
      {
        id: `att-exe-${idSuffix}`,
        filename: "invoice.exe",
        mimeType: "application/x-msdownload",
        size: 16,
        isInline: false,
        providerPartId: "2",
      },
      {
        id: `att-docm-${idSuffix}`,
        filename: "budget.xlsm",
        mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
        size: 16,
        isInline: false,
        providerPartId: "3",
      },
      {
        id: `att-pdf-${idSuffix}`,
        filename: "scan.pdf",
        mimeType: "application/pdf",
        size: 16,
        isInline: false,
        providerPartId: "4",
      },
    ]
  }

  async function seedDangerous(): Promise<MessageRow> {
    const suffix = Math.random().toString(36).slice(2, 8)
    return seedMessage("<p>hi</p>", dangerousAttachments(suffix))
  }

  /** File-action deps over the fake cache, malware lookup OFF unless
   * overridden (so the static D17 gate is under test by default). */
  function openDeps(overrides: Partial<FileActionDeps> = {}): FileActionDeps {
    return {
      ...fakeDeps(fakeFetch()),
      malwareScan: { settings: async () => ({ enabled: false, apiKey: "" }) },
      openPath: vi.fn(async () => undefined),
      resolveAppPath: async (relPath) => `/appdata/${relPath}`,
      ...overrides,
    }
  }

  function openButtonOf(item: HTMLElement): HTMLElement {
    return within(item).getByTestId("attachment-open")
  }

  it("renders tier warning chips on the attachment rows (pdf unchipped)", async () => {
    const message = await seedDangerous()
    renderDisplay(message)

    await waitFor(() =>
      expect(screen.getAllByTestId("attachment-item")).toHaveLength(3)
    )
    const [exe, docm, pdf] = screen.getAllByTestId("attachment-item")

    const exeChip = within(exe!).getByTestId("attachment-risk-chip")
    expect(exeChip.textContent).toBe("Dangerous")
    const docmChip = within(docm!).getByTestId("attachment-risk-chip")
    expect(docmChip.textContent).toBe("Macros")
    expect(within(pdf!).queryByTestId("attachment-risk-chip")).toBeNull()
    // No verdict chip until a scan has actually happened.
    expect(screen.queryByTestId("attachment-verdict-chip")).toBeNull()
  })

  it("confirms before the first open of a dangerous file, then opens", async () => {
    const message = await seedDangerous()
    const confirm = vi.fn(async () => true)
    const openPath = vi.fn(async () => undefined)
    renderDisplay(message, openDeps({ confirm, openPath }))

    const exe = (await screen.findAllByTestId("attachment-item"))[0]!
    fireEvent.click(openButtonOf(exe))

    await waitFor(() => expect(openPath).toHaveBeenCalledTimes(1))
    expect(confirm).toHaveBeenCalledWith({
      kind: "block",
      filename: "invoice.exe",
    })
    // No chip says "Malicious" — the lookup stayed off.
    expect(screen.queryByTestId("attachment-verdict-chip")).toBeNull()
  })

  it("declining the warning opens nothing and shows no error", async () => {
    const message = await seedDangerous()
    const confirm = vi.fn(async () => false)
    const openPath = vi.fn(async () => undefined)
    renderDisplay(message, openDeps({ confirm, openPath }))

    const exe = (await screen.findAllByTestId("attachment-item"))[0]!
    fireEvent.click(openButtonOf(exe))

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(openPath).not.toHaveBeenCalled()
    expect(screen.queryByText("Could not open this file.")).toBeNull()
    expect(screen.queryByTestId("attachment-verdict-chip")).toBeNull()
  })

  it("blocks a malicious verdict with a report chip until overridden", async () => {
    const message = await seedDangerous()
    const confirm = vi.fn(async () => false)
    const openPath = vi.fn(async () => undefined)
    renderDisplay(
      message,
      openDeps({
        confirm,
        openPath,
        malwareScan: {
          settings: async () => ({ enabled: true, apiKey: "vt-key" }),
          lookup: async () => ({
            verdict: "malicious",
            maliciousCount: 12,
            totalEngines: 70,
          }),
        },
      })
    )

    // The safe-tier pdf isolates the malware gate: no static warning
    // runs, so the ONLY dialog is the malicious block.
    const pdf = (await screen.findAllByTestId("attachment-item"))[2]!
    fireEvent.click(openButtonOf(pdf))

    // Blocked: the verdict chip appears, the OS never opens the file.
    await waitFor(() =>
      expect(screen.getByTestId("attachment-verdict-chip").textContent).toBe(
        "Malicious"
      )
    )
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "malicious",
        filename: "scan.pdf",
        maliciousCount: 12,
        totalEngines: 70,
      })
    )
    expect(openPath).not.toHaveBeenCalled()
    expect(screen.queryByText("Could not open this file.")).toBeNull()

    // Explicit override: the confirmation dialog is the block's escape.
    ;(confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    fireEvent.click(openButtonOf(pdf))
    await waitFor(() => expect(openPath).toHaveBeenCalledTimes(1))
  })

  it("opens a clean-verdict pdf with no dialogs at all", async () => {
    const message = await seedDangerous()
    const confirm = vi.fn(async () => true)
    const openPath = vi.fn(async () => undefined)
    renderDisplay(
      message,
      openDeps({
        confirm,
        openPath,
        malwareScan: {
          settings: async () => ({ enabled: true, apiKey: "vt-key" }),
          lookup: async () => ({
            verdict: "clean",
            maliciousCount: 0,
            totalEngines: 70,
          }),
        },
      })
    )

    const pdf = (await screen.findAllByTestId("attachment-item"))[2]!
    fireEvent.click(openButtonOf(pdf))

    await waitFor(() => expect(openPath).toHaveBeenCalledTimes(1))
    expect(confirm).not.toHaveBeenCalled()
    expect(screen.queryByTestId("attachment-verdict-chip")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Junk filter banner (task 18.10, design D19): a spam-placed thread in an
// IMAP account with the junk filter ON shows the classification banner
// whose "Not spam" button runs the SAME markNotSpam flow as the context
// menu (thread back to the inbox) — the one-click retraining affordance.
// ---------------------------------------------------------------------------

describe("task 18.10: junk classification banner", () => {
  let executor: TestExecutor

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

  /** An expanded IMAP message whose thread sits in the Junk folder
   * (is_spam = 1 via the folder cache), with the toggle state passed in. */
  async function seedJunkedImapMessage(
    options: { toggleOn?: boolean; accountType?: "imap" | "gmail" } = {}
  ): Promise<MessageRow> {
    const accountId = "acc-junk"
    const accountType = options.accountType ?? "imap"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, accountType, "junk@example.com"]
    )
    const inboxId = accountId + ":INBOX"
    const junkId = accountId + ":Junk"
    await insertLabel(executor, {
      id: inboxId,
      accountId,
      name: "INBOX",
      imapFolderName: "INBOX",
      specialUse: "inbox",
      type: "system",
    })
    await insertLabel(executor, {
      id: junkId,
      accountId,
      name: "Junk",
      imapFolderName: "Junk",
      specialUse: "spam",
      type: "system",
    })
    const threadId = await createThread(executor, accountId, {
      subject: "Junked",
    })
    await setThreadFolder(executor, threadId, junkId)
    const messageId = await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromAddress: "winner@lottery.example",
      subject: "Junked",
      bodyText: "buy cheap pills",
      imapFolder: "Junk",
      imapUid: 9,
    })
    await updateMessage(executor, messageId, { bodyHtml: "<p>buy</p>" })
    if (options.toggleOn) {
      await setJunkFilterEnabledPreference(executor, accountId, true)
    }
    const rows = await executor.select<MessageRow>(
      "SELECT * FROM messages WHERE id = $1",
      [messageId]
    )
    if (!rows[0]) throw new Error("seeded message row missing")
    return rows[0]
  }

  function renderForAccount(message: MessageRow, type: "imap" | "gmail") {
    return render(
      <MailDisplay
        message={message}
        threadSubject="Junked"
        imagesAllowed={false}
        onAllowSender={vi.fn()}
        initiallyUnread={false}
        expanded={true}
        onToggleExpanded={vi.fn()}
        account={{
          id: message.account_id,
          type,
          email: "junk@example.com",
          status: "active",
          isActive: true,
          isPinned: false,
        }}
      />
    )
  }

  it("shows the banner on a junked thread when the filter is on", async () => {
    const message = await seedJunkedImapMessage({ toggleOn: true })
    renderForAccount(message, "imap")

    expect(await screen.findByTestId("junk-banner")).toBeDefined()
    expect(screen.getByTestId("junk-not-spam")).toBeDefined()
  })

  it("shows no banner with the filter off (the default)", async () => {
    const message = await seedJunkedImapMessage({ toggleOn: false })
    renderForAccount(message, "imap")

    await waitFor(() => {
      expect(screen.queryByTestId("junk-banner")).toBeNull()
    })
  })

  it("shows no banner for gmail accounts (exempt)", async () => {
    const message = await seedJunkedImapMessage({
      toggleOn: true,
      accountType: "gmail",
    })
    renderForAccount(message, "gmail")

    await waitFor(() => {
      expect(screen.queryByTestId("junk-banner")).toBeNull()
    })
  })

  it("Not spam returns the thread to the inbox and clears the banner", async () => {
    const message = await seedJunkedImapMessage({ toggleOn: true })
    renderForAccount(message, "imap")
    await screen.findByTestId("junk-banner")

    fireEvent.click(screen.getByTestId("junk-not-spam"))

    // The SAME inbox-restore flow the context menu runs: the messages are
    // back in INBOX, the move op is queued, the banner stands down. (The
    // banner hides optimistically on click; the move settles async.)
    await waitFor(() => {
      expect(screen.queryByTestId("junk-banner")).toBeNull()
    })
    await waitFor(async () => {
      const rows = await executor.select<{ imap_folder: string }>(
        "SELECT imap_folder FROM messages WHERE id = $1",
        [message.id]
      )
      expect(rows[0]?.imap_folder).toBe("INBOX")
    })
    const ops = await executor.select<{
      op_type: string
      payload_json: string
    }>(
      "SELECT op_type, payload_json FROM pending_operations WHERE account_id = $1",
      [message.account_id]
    )
    expect(ops.map((op) => op.op_type)).toEqual(["move"])
    expect(JSON.parse(ops[0]?.payload_json ?? "{}")).toMatchObject({
      destinationFolder: "INBOX",
    })
  })
})

// ---------------------------------------------------------------------------
// Unsubscribe (task 18.3, design D13): a message whose stored headers JSON
// carries a parseable List-Unsubscribe shows the banner; the one-click path
// confirms the exact URL, POSTs through the injected seam (or queues the
// unsubscribe_post op while offline) and offers auto-archive as a rule; the
// mailto path opens the composer pre-addressed through the real stores.
// ---------------------------------------------------------------------------

describe("task 18.3: unsubscribe affordance", () => {
  const ONE_CLICK_URL = "https://lists.example.com/u/123"

  const ONE_CLICK_HEADERS = JSON.stringify({
    "list-unsubscribe": `<${ONE_CLICK_URL}>, <mailto:leave@lists.example.com>`,
    "list-unsubscribe-post": "List-Unsubscribe=One-Click",
  })
  const MAILTO_HEADERS = JSON.stringify({
    "list-unsubscribe": "<mailto:leave@lists.example.com?subject=Bye>",
  })

  function unsubDeps(post: UnsubscribeDeps["post"]): UnsubscribeDeps {
    return { post }
  }

  function renderDisplayWithDeps(
    message: MessageRow,
    deps?: UnsubscribeDeps
  ): ReturnType<typeof render> {
    return render(
      <MailDisplay
        message={message}
        threadSubject="Newsletter"
        imagesAllowed={false}
        onAllowSender={vi.fn()}
        initiallyUnread={false}
        expanded={true}
        onToggleExpanded={vi.fn()}
        account={account}
        unsubscribeDeps={deps}
      />
    )
  }

  /** Seed a message row carrying (or lacking) stored headers JSON.
   * seedMessage's account insert is once-per-test, so this tolerates the
   * row already existing (two renders in one test). */
  async function seedWithHeaders(headers: string | null): Promise<MessageRow> {
    await executor
      .execute(
        "INSERT OR IGNORE INTO accounts (id, type, email) VALUES ($1, $2, $3)",
        [accountId, "gmail", account.email]
      )
      .catch(() => {})
    const threadId = await createThread(executor, accountId, {
      subject: "Newsletter",
    })
    const messageId = await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromName: "Lists",
      fromAddress: "news@lists.example.com",
      isRead: false,
    })
    await updateMessage(executor, messageId, {
      bodyHtml: "<p>newsletter body</p>",
    })
    if (headers !== null) {
      await updateMessage(executor, messageId, { headers })
    }
    const rows = await executor.select<MessageRow>(
      "SELECT * FROM messages WHERE id = $1",
      [messageId]
    )
    return rows[0]!
  }

  afterEach(() => {
    useComposerStore.getState().reset()
    useUiStore.getState().setComposerOpen(false)
    useOnlineStore.getState().setOnline(true)
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.error).mockClear()
  })

  it("shows the banner for a message with a parseable List-Unsubscribe", async () => {
    const message = await seedWithHeaders(ONE_CLICK_HEADERS)
    renderDisplayWithDeps(message, unsubDeps(vi.fn()))

    expect(await screen.findByTestId("unsubscribe-banner")).toBeDefined()
    expect(screen.getByTestId("unsubscribe-button")).toBeDefined()
  })

  it("renders no banner without headers or with non-actionable headers", async () => {
    const plain = await seedWithHeaders(null)
    const { unmount } = renderDisplayWithDeps(plain)
    await waitFor(() => expect(frameSrcdoc()).toContain("newsletter body"))
    expect(screen.queryByTestId("unsubscribe-banner")).toBeNull()
    unmount()

    // An http-only header without the -Post advertisement offers neither
    // one-click (https-only, RFC 8058) nor a mailto → no affordance.
    const httpOnly = await seedWithHeaders(
      JSON.stringify({
        "list-unsubscribe": "<http://lists.example.com/u>",
      })
    )
    renderDisplayWithDeps(httpOnly)
    await waitFor(() => expect(frameSrcdoc()).toContain("newsletter body"))
    expect(screen.queryByTestId("unsubscribe-banner")).toBeNull()
  })

  it("one-click: confirms the exact URL, then posts and toasts success", async () => {
    const message = await seedWithHeaders(ONE_CLICK_HEADERS)
    const post = vi.fn<UnsubscribePostFn>(
      async () => ({ ok: true, status: 200 }) as Response
    )
    renderDisplayWithDeps(message, unsubDeps(post))

    fireEvent.click(await screen.findByTestId("unsubscribe-button"))

    // The confirm state names the target BEFORE anything is sent.
    const banner = screen.getByTestId("unsubscribe-banner")
    expect(banner.textContent).toContain(ONE_CLICK_URL)
    expect(post).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("unsubscribe-confirm"))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0][0]).toBe(ONE_CLICK_URL)
    expect(post.mock.calls[0][1]).toEqual({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    })
    expect(vi.mocked(toast.success)).toHaveBeenCalled()

    // The offer appears after the unsubscribe went through.
    expect(await screen.findByTestId("unsubscribe-auto-archive")).toBeDefined()
  })

  it("one-click offline: queues the unsubscribe_post op instead of posting", async () => {
    const message = await seedWithHeaders(ONE_CLICK_HEADERS)
    const post = vi.fn<UnsubscribePostFn>(
      async () => ({ ok: true, status: 200 }) as Response
    )
    useOnlineStore.getState().setOnline(false)
    renderDisplayWithDeps(message, unsubDeps(post))

    fireEvent.click(await screen.findByTestId("unsubscribe-button"))
    fireEvent.click(screen.getByTestId("unsubscribe-confirm"))

    await waitFor(() => {
      expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toContain("queued")
    })
    expect(post).not.toHaveBeenCalled()
    const ops = await executor.select<{
      op_type: string
      payload_json: string
    }>("SELECT op_type, payload_json FROM pending_operations")
    expect(ops.map((op) => op.op_type)).toEqual(["unsubscribe_post"])
    expect(JSON.parse(ops[0]?.payload_json ?? "{}")).toEqual({
      url: ONE_CLICK_URL,
    })
  })

  it("one-click failure: toasts the error and offers the action again", async () => {
    const message = await seedWithHeaders(ONE_CLICK_HEADERS)
    const post = vi.fn(async () => ({ ok: false, status: 503 }) as Response)
    renderDisplayWithDeps(message, unsubDeps(post))

    fireEvent.click(await screen.findByTestId("unsubscribe-button"))
    fireEvent.click(screen.getByTestId("unsubscribe-confirm"))

    await waitFor(() => {
      expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toContain("503")
    })
    // Back to the idle banner — the user can retry.
    expect(screen.getByTestId("unsubscribe-button")).toBeDefined()
  })

  it("mailto fallback opens the composer pre-addressed (with the list subject)", async () => {
    const message = await seedWithHeaders(MAILTO_HEADERS)
    const post = vi.fn<UnsubscribePostFn>(
      async () => ({ ok: true, status: 200 }) as Response
    )
    renderDisplayWithDeps(message, unsubDeps(post))

    fireEvent.click(await screen.findByTestId("unsubscribe-button"))

    // The SAME compose-to-contact bridge: composer store first, ui-store's
    // flag after — addressed to the mailto target, its ?subject= prefilled.
    const composer = useComposerStore.getState()
    expect(composer.open).toBe(true)
    expect(composer.activeAccountId).toBe(account.id)
    expect(composer.to).toEqual([{ email: "leave@lists.example.com" }])
    expect(composer.subject).toBe("Bye")
    expect(useUiStore.getState().composerOpen).toBe(true)
    expect(post).not.toHaveBeenCalled()
  })

  it("mailto fallback without a subject parameter uses the standard subject", async () => {
    const message = await seedWithHeaders(
      JSON.stringify({
        "list-unsubscribe": "<mailto:leave@lists.example.com>",
      })
    )
    renderDisplayWithDeps(message, unsubDeps(vi.fn()))

    fireEvent.click(await screen.findByTestId("unsubscribe-button"))

    expect(useComposerStore.getState().subject).toBe("Unsubscribe")
  })

  it("auto-archive offer creates a from:sender archive rule", async () => {
    const message = await seedWithHeaders(ONE_CLICK_HEADERS)
    renderDisplayWithDeps(
      message,
      unsubDeps(vi.fn(async () => ({ ok: true, status: 200 }) as Response))
    )

    fireEvent.click(await screen.findByTestId("unsubscribe-button"))
    fireEvent.click(screen.getByTestId("unsubscribe-confirm"))
    fireEvent.click(await screen.findByTestId("unsubscribe-auto-archive"))

    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalled()
    })
    const rules = await executor.select<{
      name: string
      criteria_json: string
      actions_json: string
      enabled: number
    }>("SELECT name, criteria_json, actions_json, enabled FROM rules")
    expect(rules).toHaveLength(1)
    expect(rules[0]?.criteria_json).toBe(
      JSON.stringify({ query: "from:news@lists.example.com" })
    )
    expect(JSON.parse(rules[0]?.actions_json ?? "[]")).toEqual([
      { type: "archive" },
    ])
    expect(rules[0]?.enabled).toBe(1)
    // The offer's settled state names the outcome.
    expect(screen.getByTestId("unsubscribe-banner").textContent).toContain(
      "archived"
    )
  })
})

// ---------------------------------------------------------------------------
// Authentication badge + DMARC phishing treatment (task 2.2, design D10):
// the header badge reads the messages.auth_results column (task 2.1) and
// renders one chip per stored mechanism — NOTHING when the column is null
// (spec: no headers → no badge, never a failure). A stored DMARC failure
// additionally surfaces the SAME phishing-warning banner as an analysis
// finding, via a synthetic "dmarc-fail" finding.
// ---------------------------------------------------------------------------

describe("task 2.2: authentication badge", () => {
  /** Seed a body-carrying message with (or without) the stored compact
   * auth verdicts, returning the full row (updateMessage's patch path is
   * the same one the sync flows write the column through). */
  async function seedAuthMessage(
    authResults: string | null
  ): Promise<MessageRow> {
    const message = await seedMessage("<p>auth body</p>")
    if (authResults !== null) {
      await updateMessage(executor, message.id, { authResults })
    }
    const rows = await executor.select<MessageRow>(
      "SELECT * FROM messages WHERE id = $1",
      [message.id]
    )
    if (!rows[0]) throw new Error("seeded message row missing")
    return rows[0]
  }

  it("renders the all-pass badge and no phishing banner", async () => {
    const message = await seedAuthMessage("spf=pass;dkim=pass;dmarc=pass")
    renderDisplay(message)

    await waitFor(() => expect(frameSrcdoc()).toContain("auth body"))
    expect(screen.getByTestId("auth-badge")).not.toBeNull()
    expect(screen.getByTestId("auth-spf").getAttribute("data-result")).toBe(
      "pass"
    )
    expect(screen.getByTestId("auth-dkim").getAttribute("data-result")).toBe(
      "pass"
    )
    expect(screen.getByTestId("auth-dmarc").getAttribute("data-result")).toBe(
      "pass"
    )
    // All mechanisms passed: the phishing treatment stays off.
    expect(screen.queryByTestId("phishing-banner")).toBeNull()
  })

  it("a DMARC fail shows the badge failure AND the phishing banner", async () => {
    const message = await seedAuthMessage("spf=pass;dkim=pass;dmarc=fail")
    renderDisplay(message)

    await waitFor(() => expect(frameSrcdoc()).toContain("auth body"))
    expect(screen.getByTestId("auth-dmarc").getAttribute("data-result")).toBe(
      "fail"
    )
    // The banner appears from the auth verdict ALONE (no spoof findings):
    // the synthetic dmarc-fail finding rides the existing banner path.
    const banner = screen.getByTestId("phishing-banner")
    expect(banner).not.toBeNull()
    expect(banner.textContent).toContain("DMARC")
    // The body still renders — advisory, never blocked (spec).
    expect(frameSrcdoc()).toContain("auth body")
  })

  it("renders no badge at all when auth_results is null", async () => {
    const message = await seedAuthMessage(null)
    renderDisplay(message)

    await waitFor(() => expect(frameSrcdoc()).toContain("auth body"))
    expect(screen.queryByTestId("auth-badge")).toBeNull()
    expect(screen.queryByTestId("auth-spf")).toBeNull()
    expect(screen.queryByTestId("auth-dmarc")).toBeNull()
  })

  it("renders only the mechanisms present for partial data", async () => {
    const message = await seedAuthMessage("dkim=pass")
    renderDisplay(message)

    await waitFor(() => expect(frameSrcdoc()).toContain("auth body"))
    expect(screen.getByTestId("auth-badge")).not.toBeNull()
    expect(screen.getByTestId("auth-dkim").getAttribute("data-result")).toBe(
      "pass"
    )
    expect(screen.queryByTestId("auth-spf")).toBeNull()
    expect(screen.queryByTestId("auth-dmarc")).toBeNull()
    // One passing mechanism alone never triggers the phishing treatment.
    expect(screen.queryByTestId("phishing-banner")).toBeNull()
  })

  it("maps quasi-fail tokens (softfail) to the neutral display state", async () => {
    const message = await seedAuthMessage("spf=softfail;dkim=pass")
    renderDisplay(message)

    await waitFor(() => expect(frameSrcdoc()).toContain("auth body"))
    expect(screen.getByTestId("auth-spf").getAttribute("data-result")).toBe(
      "none"
    )
    expect(screen.getByTestId("auth-dkim").getAttribute("data-result")).toBe(
      "pass"
    )
  })
})

// ---------------------------------------------------------------------------
// Contacts loading for the phishing analysis (task 18.1): memoized per
// account for the render session's executor, so N expanded messages of
// one thread run ONE listContactsByAccount query.
// ---------------------------------------------------------------------------

describe("contacts memoization (phishing analysis)", () => {
  /** Two messages of one thread/account (seedMessage seeds its own
   * account row, so this seeds both messages in one go). */
  async function seedTwoMessages(): Promise<[MessageRow, MessageRow]> {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", account.email]
    )
    const threadId = await createThread(executor, accountId, {
      subject: "Contacts memo",
    })
    const rows: MessageRow[] = []
    for (const body of ["<p>first body</p>", "<p>second body</p>"]) {
      const messageId = await createMessage(executor, {
        threadId,
        accountId,
        date: 1_700_000_000,
        fromName: "Ada Lovelace",
        fromAddress: "ada@example.com",
        isRead: false,
      })
      await updateMessage(executor, messageId, { bodyHtml: body })
      const selected = await executor.select<MessageRow>(
        "SELECT * FROM messages WHERE id = $1",
        [messageId]
      )
      if (!selected[0]) throw new Error("seeded message row missing")
      rows.push(selected[0])
    }
    return [rows[0] as MessageRow, rows[1] as MessageRow]
  }

  it("a second expanded message of the same account does not re-query contacts", async () => {
    const [first, second] = await seedTwoMessages()
    vi.mocked(listContactsByAccount).mockClear()

    const firstRender = renderDisplay(first)
    await waitFor(() => expect(frameSrcdoc()).toContain("first body"))
    firstRender.unmount()

    // Same account, fresh message id: the phishing analysis runs again,
    // but the contacts query must be served from the per-account memo.
    renderDisplay(second)
    await waitFor(() => expect(frameSrcdoc()).toContain("second body"))

    expect(listContactsByAccount).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Raw message source (task 1.2): the View source entry on an expanded
// message opens the inert source dialog through the injected seam.
// ---------------------------------------------------------------------------

describe("task 1.2: view source entry", () => {
  it("opens the dialog, fetches through sourceDeps once and renders inert", async () => {
    const message = await seedMessage("<p>Body</p>")
    const source = "From: ada <ada@example.com>\r\n\r\n<p>raw body</p>"
    const fetchSource = vi.fn(async () => source)

    render(
      <MailDisplay
        message={message}
        threadSubject="With images"
        imagesAllowed={false}
        onAllowSender={vi.fn()}
        initiallyUnread={false}
        expanded={true}
        onToggleExpanded={vi.fn()}
        account={account}
        sourceDeps={{ fetchSource }}
      />
    )

    fireEvent.click(screen.getByTestId("view-source"))

    // The dialog fetches exactly once through the injected seam and shows
    // the source ESCAPED inside the sandboxed frame (no live elements).
    // The DIALOG's frame is the last iframe — the message body frame
    // renders one first.
    const dialogSrcdoc = () => {
      const frames = document.querySelectorAll("iframe")
      return frames[frames.length - 1]?.getAttribute("srcdoc") ?? ""
    }
    await waitFor(() => expect(dialogSrcdoc()).toContain("&lt;p&gt;"))
    expect(fetchSource).toHaveBeenCalledTimes(1)
    const srcdoc = dialogSrcdoc()
    expect(srcdoc).toContain("&lt;p&gt;raw body&lt;/p&gt;")
    expect(srcdoc).not.toContain("<p>raw body</p>")
    expect(screen.getByTestId("source-view-copy")).not.toBeNull()
  })
})
