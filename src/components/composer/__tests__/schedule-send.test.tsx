import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import type { Editor } from "@tiptap/react"
import { toast } from "sonner"
import { addDays, format, setMinutes } from "date-fns"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Composer "Schedule send" (tasks 10.1 + 10.3). Same executor-injection
 * harness as composer.test.tsx, but the send module is NOT mocked — the
 * schedule flow runs the real validate → buildSendEmailInput →
 * buildMimeMessage pipeline, so the stored payload is byte-identical to
 * what a Send would transmit. The round-trip test drives the real
 * editScheduledSend flow (decompose → composer restore → row cancelled).
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

const toastMock = vi.mocked(toast)

import { createAccount } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { getAccount } from "@/services/db/accounts"
import { getAttachmentBytes } from "../attachment-bytes"
import {
  createScheduledSend,
  listScheduledSends,
} from "@/services/db/scheduled-sends"
import { buildSendEmailInput } from "@/services/composer/send"
import {
  buildMimeMessage,
  generateMessageId,
} from "@/services/email/mime-builder"
import {
  editScheduledSend,
  getScheduleSendPresets,
  scheduleComposerSend,
} from "@/components/layout/use-scheduled-sends"
import { formatSnoozedUntil } from "@/components/layout/use-snoozed-threads"
import { getComposerPayload, useComposerStore } from "@/stores/composer-store"
import { Composer } from "../composer"

let executor: TestExecutor
let accountId: string

function openComposer(): void {
  useComposerStore.getState().openNew(accountId)
}

function typeInto(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } })
}

function pressKey(input: HTMLElement, key: string): void {
  fireEvent.keyDown(input, { key })
}

function getMountedEditor(): Editor {
  const element = document.querySelector(".tiptap") as
    (HTMLElement & { editor?: Editor }) | null
  if (!element?.editor) throw new Error("TipTap editor did not mount")
  return element.editor
}

/** Fill the composer into a sendable state and return its draft key. */
function renderSendable(): string {
  openComposer()
  render(<Composer />)
  const toInput = screen.getByLabelText("To")
  typeInto(toInput, "ada@example.com")
  pressKey(toInput, "Enter")
  typeInto(screen.getByLabelText("Subject"), "Quarterly report")
  getMountedEditor().commands.setContent("<p>Scheduled body</p>")
  return useComposerStore.getState().draftKey ?? ""
}

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  accountId = await createAccount(executor)
})

afterEach(async () => {
  cleanup()
  useComposerStore.getState().cancelUndoSend()
  useComposerStore.getState().reset()
  await act(async () => {})
  executorHolder.current = null
  executor.close()
  vi.clearAllMocks()
})

describe("Composer schedule send (task 10.1)", () => {
  it("the picker sits beside Send and is enabled exactly when Send is", () => {
    openComposer()
    render(<Composer />)

    const schedule = screen.getByRole("button", {
      name: "Schedule send",
    }) as HTMLButtonElement
    expect(schedule.disabled).toBe(true)

    const toInput = screen.getByLabelText("To")
    typeInto(toInput, "ada@example.com")
    pressKey(toInput, "Enter")
    typeInto(screen.getByLabelText("Subject"), "Hello")
    expect(schedule.disabled).toBe(false)
    expect(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it("a preset pick stores the built MIME with the due time and closes the composer", async () => {
    const draftKey = renderSendable()
    const { presets } = getScheduleSendPresets()
    const tomorrow = presets[0]!

    fireEvent.click(screen.getByRole("button", { name: "Schedule send" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: tomorrow.label })
    )

    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    expect(toastMock.success).toHaveBeenCalledWith(
      `Scheduled for ${formatSnoozedUntil(tomorrow.dueAt)}`
    )

    // The stored row carries the built payload, recipients, subject and
    // due time — exactly one, still 'scheduled'.
    const rows = await listScheduledSends(executor)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      account_id: accountId,
      status: "scheduled",
      subject: "Quarterly report",
      due_at: tomorrow.dueAt,
    })
    expect(row.mime_payload).toContain("To: ada@example.com")
    expect(row.mime_payload).toContain("Subject: Quarterly report")
    expect(row.mime_payload).toContain("Content-Transfer-Encoding: base64")
    expect(parseRecipients(row.recipients_json)).toEqual([
      { email: "ada@example.com" },
    ])

    // The draft row is gone (scheduling captures it, like sending).
    expect(
      await executor.select("SELECT id FROM local_drafts WHERE id = $1", [
        draftKey,
      ])
    ).toHaveLength(0)
    // And the composer store is fully reset.
    expect(useComposerStore.getState().to).toEqual([])
    expect(useComposerStore.getState().subject).toBe("")
  })

  it("a custom date/time pick stores that exact due time", async () => {
    renderSendable()

    fireEvent.click(screen.getByRole("button", { name: "Schedule send" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Pick date & time…" })
    )
    const picker = await screen.findByTestId("schedule-custom-picker")
    const value = format(
      setMinutes(addDays(new Date(), 2), 37),
      "yyyy-MM-dd'T'HH:mm"
    )
    fireEvent.change(within(picker).getByLabelText("Schedule for"), {
      target: { value },
    })
    fireEvent.click(within(picker).getByRole("button", { name: "Schedule" }))

    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    const rows = await listScheduledSends(executor)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.due_at).toBe(Math.floor(new Date(value).getTime() / 1000))
  })

  it("a past custom date/time cannot be confirmed", async () => {
    renderSendable()
    fireEvent.click(screen.getByRole("button", { name: "Schedule send" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Pick date & time…" })
    )
    const picker = await screen.findByTestId("schedule-custom-picker")
    fireEvent.change(within(picker).getByLabelText("Schedule for"), {
      target: { value: "2020-01-01T08:00" },
    })
    const confirm = within(picker).getByRole("button", { name: "Schedule" })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
  })

  it("an empty draft cannot be scheduled (button disabled, no rows)", () => {
    openComposer()
    render(<Composer />)
    const schedule = screen.getByRole("button", { name: "Schedule send" })
    expect((schedule as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(schedule)
    expect(screen.queryByTestId("schedule-send-menu")).toBeNull()
  })

  it("the service-level gate rejects an unsendable payload without storing", async () => {
    const result = await scheduleComposerSend({
      accountId,
      payload: {
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        htmlBody: "",
        textBody: "",
      },
      mode: { kind: "new" },
      dueAt: 1_900_000_000,
    })
    expect(result.status).toBe("failed")
    expect(await listScheduledSends(executor)).toHaveLength(0)
  })

  it("stores the From-picker alias into the built MIME (task 16.2, design D10)", async () => {
    // The composer passes only its payload to scheduleComposerSend — the
    // From-picker selection comes from the store, exactly like the real
    // schedule click (reset() runs only after the schedule succeeded).
    useComposerStore.getState().openNew(accountId)
    useComposerStore.getState().setFromAlias({
      email: "work@example.com",
      name: "User Work",
    })

    const result = await scheduleComposerSend({
      accountId,
      payload: {
        to: [{ email: "ada@example.com" }],
        cc: [],
        bcc: [],
        subject: "Later",
        htmlBody: "<p>Hi</p>",
        textBody: "",
      },
      mode: { kind: "new" },
      dueAt: 1_900_000_000,
    })
    expect(result.status).toBe("scheduled")

    const rows = await listScheduledSends(executor)
    expect(rows).toHaveLength(1)
    // The alias is the From HEADER of the stored MIME — the 10.2 runner
    // transmits these bytes verbatim, so the header is where the alias
    // must live. (The envelope stays the account on every path: gmail raw
    // sends as the authenticated user; imap pins MAIL FROM via
    // envelopeFrom in the provider.)
    expect(rows[0]!.mime_payload).toContain(
      "From: User Work <work@example.com>"
    )
  })
})

describe("Scheduled-send edit round-trip (task 10.3)", () => {
  it("edit restores to/cc/subject/body into the composer and cancels the row", async () => {
    renderSendable()
    // Add an attachment so the round-trip proves the MIME parts restore.
    const section = document.querySelector("section")
    if (!section) throw new Error("composer section did not mount")
    fireEvent.drop(section, {
      dataTransfer: {
        files: [new File([new Uint8Array([9, 8, 7])], "notes.txt")],
      },
    })
    await screen.findByText("notes.txt")
    // A cc recipient too — the header split must survive.
    fireEvent.click(screen.getByRole("button", { name: "Cc" }))
    const ccInput = screen.getByLabelText("Cc")
    typeInto(ccInput, "bob@example.com")
    pressKey(ccInput, "Enter")

    const { presets } = getScheduleSendPresets()
    fireEvent.click(screen.getByRole("button", { name: "Schedule send" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: presets[0]!.label })
    )
    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    const rows = await listScheduledSends(executor)
    expect(rows).toHaveLength(1)
    const row = rows[0]!

    // The dialog's Edit action: decompose → composer restore → cancel.
    expect(await editScheduledSend(row)).toBe(true)

    const state = useComposerStore.getState()
    expect(state.open).toBe(true)
    expect(state.activeAccountId).toBe(accountId)
    expect(state.to).toEqual([{ email: "ada@example.com" }])
    expect(state.cc).toEqual([{ email: "bob@example.com" }])
    expect(state.subject).toBe("Quarterly report")
    expect(state.html).toBe("<p>Scheduled body</p>")
    // The attachment came back from the MIME part, bytes included.
    expect(state.attachments).toEqual([
      {
        id: expect.any(String),
        name: "notes.txt",
        size: 3,
        mimeType: "text/plain",
      },
    ])
    expect(getComposerPayload().attachments).toEqual([
      {
        filename: "notes.txt",
        mimeType: "text/plain",
        contentBase64: btoa(String.fromCharCode(9, 8, 7)),
      },
    ])
    expect(getAttachmentBytes(state.attachments[0]!.id)).toBeDefined()

    // The original row is cancelled (audit-kept, unlisted)…
    expect(
      (
        await executor.select<{ status: string }>(
          "SELECT status FROM scheduled_sends WHERE id = $1",
          [row.id]
        )
      )[0]!.status
    ).toBe("cancelled")
    expect(await listScheduledSends(executor)).toHaveLength(0)

    // …and re-scheduling creates a NEW row (schedule cancelled until
    // re-sent), while the cancelled one stays out of the lists.
    fireEvent.click(screen.getByRole("button", { name: "Schedule send" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: presets[0]!.label })
    )
    await waitFor(() => {
      expect(useComposerStore.getState().open).toBe(false)
    })
    const after = await listScheduledSends(executor)
    expect(after).toHaveLength(1)
    expect(after[0]!.id).not.toBe(row.id)
  })

  it("edit aborts without cancelling when nothing usable can be restored", async () => {
    await createScheduledSend(executor, {
      accountId,
      mimePayload: "garbage",
      recipients: [],
      dueAt: 1_900_000_000,
    })
    const rows = await listScheduledSends(executor)
    expect(await editScheduledSend(rows[0]!)).toBe(false)
    // The schedule stays in place — nothing was cancelled.
    expect(
      (
        await executor.select<{ status: string }>(
          "SELECT status FROM scheduled_sends WHERE id = $1",
          [rows[0]!.id]
        )
      )[0]!.status
    ).toBe("scheduled")
  })

  it("edit restores the From alias the message was scheduled with (task 16.2)", async () => {
    const account = await getAccount(executor, accountId)
    if (!account) throw new Error("account missing")
    const payload: Parameters<typeof buildSendEmailInput>[1] = {
      to: [{ email: "ada@example.com" }],
      cc: [],
      bcc: [],
      subject: "From the alias",
      htmlBody: "<p>Alias body</p>",
      textBody: "Alias body",
    }

    // Row 1: scheduled from an alias — the stored From header carries it.
    await createScheduledSend(executor, {
      accountId,
      mimePayload: buildMimeMessage(
        buildSendEmailInput(
          account,
          payload,
          undefined,
          generateMessageId(account.email),
          { email: "alias@example.com", name: "Alias Name" }
        )
      ).mime,
      recipients: [{ email: "ada@example.com" }],
      subject: "From the alias",
      dueAt: 1_900_000_000,
    })

    // Row 2: scheduled from the bare account identity.
    await createScheduledSend(executor, {
      accountId,
      mimePayload: buildMimeMessage(
        buildSendEmailInput(
          account,
          payload,
          undefined,
          generateMessageId(account.email),
          null
        )
      ).mime,
      recipients: [{ email: "ada@example.com" }],
      subject: "From the account",
      dueAt: 1_900_000_000,
    })

    // Edit the alias row: the composer's From picker preselects the alias
    // so the re-send keeps the sender identity.
    const rows = await listScheduledSends(executor)
    const aliasRow = rows.find((row) => row.subject === "From the alias")
    if (!aliasRow) throw new Error("alias row missing")
    expect(await editScheduledSend(aliasRow)).toBe(true)
    expect(useComposerStore.getState().fromAlias).toEqual({
      email: "alias@example.com",
      name: "Alias Name",
    })

    // Edit the bare-identity row: the From picker falls back to the bare
    // account identity (openNew's default, asserted explicitly).
    useComposerStore.getState().reset()
    const remaining = await listScheduledSends(executor)
    const bareRow = remaining.find((row) => row.subject === "From the account")
    if (!bareRow) throw new Error("bare row missing")
    expect(await editScheduledSend(bareRow)).toBe(true)
    expect(useComposerStore.getState().fromAlias).toBeNull()
  })

  it("edit aborts when the row cannot be cancelled (no composer, row untouched)", async () => {
    const account = await getAccount(executor, accountId)
    if (!account) throw new Error("account missing")
    // A fully decomposable payload: the abort must come from the cancel
    // gate, not from an unusable payload.
    await createScheduledSend(executor, {
      accountId,
      mimePayload: buildMimeMessage(
        buildSendEmailInput(
          account,
          {
            to: [{ email: "ada@example.com" }],
            cc: [],
            bcc: [],
            subject: "Cancellable",
            htmlBody: "<p>Body</p>",
            textBody: "Body",
          },
          undefined,
          generateMessageId(account.email),
          null
        )
      ).mime,
      recipients: [{ email: "ada@example.com" }],
      subject: "Cancellable",
      dueAt: 1_900_000_000,
    })
    const rows = await listScheduledSends(executor)
    const row = rows[0]!

    // The row stops being cancellable (already cancelled): the service
    // reports applied = false and the edit must abort BEFORE the composer
    // opens — a copy left editable beside a live schedule is a double-send.
    const { cancelScheduledSend } =
      await import("@/services/db/scheduled-sends")
    expect(await cancelScheduledSend(executor, row.id)).toBe(true)
    expect(await editScheduledSend(row)).toBe(false)
    // The composer never opened over the (now cancelled) row.
    expect(useComposerStore.getState().open).toBe(false)
  })
})

/** Parse a row's recipients_json (same rule the view uses). */
function parseRecipients(recipientsJson: string): {
  name?: string
  email: string
}[] {
  return JSON.parse(recipientsJson)
}
