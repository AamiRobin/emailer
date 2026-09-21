import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * The thread context menu's category overrides (task 3.5, design D4,
 * mail-organization spec "Automatic categorization"): while categorization
 * is enabled the menu gains "Move to category" (five categories; the
 * thread's current one checked/disabled — NULL renders as Primary) and
 * "Always categorize <sender> as" (the newest-message sender from the
 * participants cache, resolved like Block sender). Both emit the clicked
 * category with the CLICKED thread's id — the overrides are per-thread
 * storage, not selection bulk ops. Pure display+intents: no executor
 * needed (the service executions are covered by the overrides suite).
 */

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

import { ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  ThreadContextMenu,
  type ThreadMenuHandlers,
} from "../thread-context-menu"
import type { Category } from "@/services/categorization/classify"

interface MenuOptions {
  category?: string | null
  participants?: string | null
  categoriesEnabled?: boolean
  onMoveToCategory?: (threadId: string, category: Category) => void
  onAlwaysFromSender?: (threadId: string, category: Category) => void
}

function makeThreadRow(options: {
  category?: string | null
  participants?: string | null
}): Parameters<typeof ThreadContextMenu>[0]["thread"] {
  return {
    id: "thread-1",
    account_id: "acc-1",
    subject: "Hello",
    snippet: null,
    first_message_at: 100,
    last_message_at: 100,
    message_count: 1,
    unread_count: 0,
    has_attachments: 0,
    is_starred: 0,
    participants: options.participants ?? null,
    category: options.category ?? null,
    gmail_thread_id: null,
    folder_label_id: null,
    is_archived: 0,
    is_trashed: 0,
    is_spam: 0,
    created_at: 100,
  }
}

const noopHandlers = {
  onOpen: vi.fn(),
  onReply: vi.fn(),
  onAction: vi.fn(),
  onToggleLabel: vi.fn(),
  onSnooze: vi.fn(),
  onThreadState: vi.fn(),
  onBlockSender: vi.fn(),
} as unknown as ThreadMenuHandlers

function renderMenu(options: MenuOptions) {
  const handlers: ThreadMenuHandlers = {
    ...noopHandlers,
    ...(options.onMoveToCategory
      ? { onMoveToCategory: options.onMoveToCategory }
      : {}),
    ...(options.onAlwaysFromSender
      ? { onAlwaysFromSender: options.onAlwaysFromSender }
      : {}),
  }
  return render(
    <ThreadContextMenu
      thread={makeThreadRow(options)}
      targetIds={["thread-1", "thread-2"]}
      userLabels={[]}
      categoriesEnabled={options.categoriesEnabled}
      memberLabelIds={[]}
      handlers={handlers}
    >
      <ContextMenuTrigger render={<button data-testid="row-trigger" />}>
        row
      </ContextMenuTrigger>
    </ThreadContextMenu>
  )
}

async function openMenu(): Promise<void> {
  fireEvent.contextMenu(screen.getByTestId("row-trigger"), {
    clientX: 8,
    clientY: 8,
  })
  await waitFor(() =>
    expect(screen.queryByRole("menu", { hidden: true })).not.toBeNull()
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe("thread context menu category overrides (task 3.5)", () => {
  it("renders no category entries while categorization is disabled", async () => {
    renderMenu({ categoriesEnabled: false, onMoveToCategory: vi.fn() })
    await openMenu()
    expect(
      screen.queryByRole("menuitem", { name: "Move to category" })
    ).toBeNull()
  })

  it("Move to category lists the five categories and emits the clicked one for the clicked thread", async () => {
    const onMoveToCategory = vi.fn()
    renderMenu({
      categoriesEnabled: true,
      participants: '[{"name":"Ada","email":"ada@x.com"},{"email":"me@x.com"}]',
      onMoveToCategory,
    })
    await openMenu()

    fireEvent.click(screen.getByRole("menuitem", { name: "Move to category" }))
    await screen.findByTestId("move-to-category-submenu")

    fireEvent.click(screen.getByTestId("move-to-category-updates"))
    expect(onMoveToCategory).toHaveBeenCalledTimes(1)
    // The clicked thread alone — never the targetIds selection.
    expect(onMoveToCategory).toHaveBeenCalledWith("thread-1", "updates")
  })

  it("the thread's current category is checked and inert; NULL reads as Primary", async () => {
    const onMoveToCategory = vi.fn()
    renderMenu({
      categoriesEnabled: true,
      category: "promotions",
      onMoveToCategory,
    })
    await openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to category" }))
    const promotions = await screen.findByTestId("move-to-category-promotions")
    expect(promotions.getAttribute("aria-checked")).toBe("true")
    // The current category's entry is disabled: clicking it never fires.
    fireEvent.click(promotions)
    expect(onMoveToCategory).not.toHaveBeenCalled()

    // A not-yet-categorized thread (NULL) renders Primary as its current.
    cleanup()
    renderMenu({ categoriesEnabled: true, onMoveToCategory: vi.fn() })
    await openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to category" }))
    const primary = await screen.findByTestId("move-to-category-primary")
    expect(primary.getAttribute("aria-checked")).toBe("true")
  })

  it("Always categorize <sender> as emits the per-sender override for the clicked thread", async () => {
    const onAlwaysFromSender = vi.fn()
    renderMenu({
      categoriesEnabled: true,
      participants: '[{"name":"Ada","email":"ada@x.com"},{"email":"me@x.com"}]',
      onAlwaysFromSender,
    })
    await openMenu()

    fireEvent.click(
      screen.getByRole("menuitem", { name: /Always categorize ada@x\.com as/ })
    )
    await screen.findByTestId("always-from-sender-submenu")
    fireEvent.click(screen.getByTestId("always-from-sender-promotions"))
    expect(onAlwaysFromSender).toHaveBeenCalledTimes(1)
    expect(onAlwaysFromSender).toHaveBeenCalledWith("thread-1", "promotions")
  })

  it("no Always submenu without a usable cached sender", async () => {
    renderMenu({ categoriesEnabled: true, onAlwaysFromSender: vi.fn() })
    await openMenu()
    expect(screen.queryByTestId("always-from-sender-submenu")).toBeNull()
    expect(
      screen.queryByRole("menuitem", { name: /^Always categorize/ })
    ).toBeNull()
  })
})
