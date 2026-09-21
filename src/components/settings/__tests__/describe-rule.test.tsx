import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Natural-language rule creation flow tests (parity-round-2 task 2.5,
 * ai-assistance spec "Natural-language rule creation"). The translation
 * service is mocked at its module seam (its contract is covered by the
 * service suite); the flow runs through the REAL RulesSection, describe
 * dialog and rule editor against a seeded node:sqlite database:
 *
 * - the "Describe a rule…" affordance follows the AI hide posture (absent
 *   when AI is unconfigured or the ruleAssist surface is off);
 * - a valid candidate NEVER creates anything by itself — it renders as a
 *   prefilled PREVIEW in the existing rule editor, and the rule is
 *   created only when the user clicks the editor's explicit
 *   "Create Rule" (spec scenario "Confirm before create");
 * - an unmappable description is reported ("no rule could be derived")
 *   and nothing is written (spec scenario "Not mappable").
 */

const deriveRuleFromDescriptionMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/ai/rule-assist", () => ({
  deriveRuleFromDescription: deriveRuleFromDescriptionMock,
}))

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

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  addProvider,
  setActiveProvider,
  setAiEnabled,
  setSurfaceEnabled,
} from "@/services/ai/settings"
import { listRules } from "@/services/rules"
import { useAccountStore } from "@/stores/account-store"
import { RulesSection } from "../rules-section"

let executor: TestExecutor
let accountId: string

function seedActiveAccount(): void {
  useAccountStore.setState({
    accounts: [
      {
        id: accountId,
        type: "gmail",
        email: `${accountId}@example.com`,
        displayName: null,
        status: "active",
        unreadCount: 0,
        lastSyncAt: null,
      },
    ],
    activeAccountId: accountId,
    loaded: true,
  })
}

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  // Same account insert the rules-section suite uses (id "acc-1" so the
  // account store seed below matches).
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    ["acc-1", "gmail", "me@example.com"]
  )
  accountId = "acc-1"
  seedActiveAccount()
  deriveRuleFromDescriptionMock.mockReset()
})

afterEach(() => {
  cleanup()
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: true,
  })
  executorHolder.current = null
  executor.close()
  vi.clearAllMocks()
})

/** Enable AI with an active key-less provider so the describe affordance
 * passes its availability probe. */
async function seedAi(on: boolean): Promise<void> {
  await setAiEnabled(executor, true)
  const created = await addProvider(executor, {
    kind: "anthropic",
    label: "Work",
    model: "claude-sonnet-4-5",
  })
  await setActiveProvider(executor, created.id)
  await setSurfaceEnabled(executor, "ruleAssist", on)
}

const CANDIDATE = {
  ok: true as const,
  candidate: {
    name: "Shopping receipts",
    criteriaQuery: "from:shop.example.com subject:receipt",
    actions: [
      { type: "add_labels" as const, labels: ["Receipts"] },
      { type: "archive" as const },
    ],
  },
}

describe("DescribeRuleDialog availability", () => {
  it("hides the describe affordance when AI is unconfigured", async () => {
    render(<RulesSection />)

    expect(await screen.findByText(/No rules yet/)).toBeTruthy()
    expect(screen.queryByTestId("describe-rule-open")).toBeNull()
    expect(screen.getByRole("button", { name: "Add Rule" })).toBeTruthy()
  })

  it("hides the describe affordance when the ruleAssist surface is off", async () => {
    await seedAi(false)

    render(<RulesSection />)

    expect(await screen.findByText(/No rules yet/)).toBeTruthy()
    expect(screen.queryByTestId("describe-rule-open")).toBeNull()
  })

  it("shows the describe affordance next to Add Rule when AI serves it", async () => {
    await seedAi(true)

    render(<RulesSection />)

    expect(await screen.findByTestId("describe-rule-open")).toBeTruthy()
  })
})

describe("describe → preview → confirm flow", () => {
  it("previews the candidate in the rule editor and creates ONLY on confirm", async () => {
    await seedAi(true)
    deriveRuleFromDescriptionMock.mockResolvedValue(CANDIDATE)
    render(<RulesSection />)

    fireEvent.click(await screen.findByTestId("describe-rule-open"))
    const dialog = await screen.findByTestId("describe-rule-dialog")
    expect(dialog.textContent).toContain("Only your description is sent")

    fireEvent.change(screen.getByTestId("describe-rule-input"), {
      target: { value: "File everything from shopping sites into Receipts" },
    })
    fireEvent.click(screen.getByTestId("describe-rule-translate"))

    // The service got exactly the typed description.
    expect(deriveRuleFromDescriptionMock).toHaveBeenCalledWith(
      executor,
      "File everything from shopping sites into Receipts"
    )

    // The EXISTING editor opens, prefilled with the translated rule.
    expect(await screen.findByLabelText("Name")).toHaveProperty(
      "value",
      "Shopping receipts"
    )
    expect(screen.getByLabelText("From")).toHaveProperty(
      "value",
      "shop.example.com"
    )
    expect(screen.getByLabelText("Action 1 labels")).toHaveProperty(
      "value",
      "Receipts"
    )

    // NOTHING has been created yet — the preview is not a write.
    expect(await listRules(executor, accountId)).toHaveLength(0)

    // The explicit confirm: the editor's own Create Rule.
    fireEvent.click(screen.getByRole("button", { name: "Create Rule" }))

    await screen.findByTestId("settings-rule-row")
    const rows = await listRules(executor, accountId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: "Shopping receipts" })
    expect(JSON.parse(rows[0]!.criteria_json)).toEqual({
      query: "from:shop.example.com subject:receipt",
    })
    expect(JSON.parse(rows[0]!.actions_json)).toEqual([
      { type: "add_labels", labels: ["Receipts"] },
      { type: "archive" },
    ])
  })

  it("writes nothing when the user cancels the preview", async () => {
    await seedAi(true)
    deriveRuleFromDescriptionMock.mockResolvedValue(CANDIDATE)
    render(<RulesSection />)

    fireEvent.click(await screen.findByTestId("describe-rule-open"))
    await screen.findByTestId("describe-rule-dialog")
    fireEvent.change(screen.getByTestId("describe-rule-input"), {
      target: { value: "Archive the shops" },
    })
    fireEvent.click(screen.getByTestId("describe-rule-translate"))
    await screen.findByLabelText("Name")

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })
    expect(await listRules(executor, accountId)).toHaveLength(0)
  })

  it("reports an unmappable description and writes nothing", async () => {
    await seedAi(true)
    deriveRuleFromDescriptionMock.mockResolvedValue({
      ok: false,
      reason: "not-mappable",
    })
    render(<RulesSection />)

    fireEvent.click(await screen.findByTestId("describe-rule-open"))
    await screen.findByTestId("describe-rule-dialog")
    fireEvent.change(screen.getByTestId("describe-rule-input"), {
      target: { value: "Forward everything to my printer" },
    })
    fireEvent.click(screen.getByTestId("describe-rule-translate"))

    // The "no rule could be derived" state, with no editor and no write.
    const status = await screen.findByTestId("describe-rule-not-mappable")
    expect(status.textContent).toContain(
      "No rule could be derived from that description."
    )
    expect(screen.queryByText("Add Rule")).toBeTruthy()
    expect(screen.queryByLabelText("Name")).toBeNull()
    expect(await listRules(executor, accountId)).toHaveLength(0)
  })
})
