import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import * as React from "react"

/**
 * Popover anchoring regression: in @base-ui/react (1.8) `anchor` is a
 * Popover.Positioner prop (shared anchor-positioning parameter), NOT a
 * Popover.Root prop — a Root-level `anchor` is a TS error and is dropped
 * at runtime, leaving the trigger-less pickers (snooze / schedule-send
 * custom date-time) unanchored. The wrapper must forward it to the
 * Positioner.
 *
 * jsdom does no layout, so floating-ui cannot prove visual placement;
 * instead these tests intercept the Positioner and assert it RECEIVES
 * the caller's anchor element (prop forwarding end-to-end: call site →
 * PopoverContent → Positioner), while the real Positioner still renders.
 */

const positionerCapture = vi.hoisted(() => ({
  last: null as Record<string, unknown> | null,
}))

vi.mock("@base-ui/react/popover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@base-ui/react/popover")>()
  const OriginalPositioner = actual.Popover.Positioner
  function CapturingPositioner(props: Record<string, unknown>) {
    positionerCapture.last = props
    const Original = OriginalPositioner as unknown as React.FC<
      Record<string, unknown>
    >
    return <Original {...props} />
  }
  return {
    ...actual,
    Popover: {
      ...actual.Popover,
      Positioner: CapturingPositioner,
    },
  }
})

import { Popover, PopoverContent } from "../popover"
import { SnoozeCustomPicker } from "@/components/email/snooze-menu"
import { ScheduleSendCustomPicker } from "@/components/composer/schedule-send-menu"

beforeEach(() => {
  positionerCapture.last = null
  // jsdom has no ResizeObserver; floating-ui's autoUpdate probes for one.
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", StubResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function anchoredElement(): HTMLElement {
  const anchor = document.createElement("button")
  document.body.appendChild(anchor)
  return anchor
}

describe("PopoverContent anchor forwarding (base-ui Positioner)", () => {
  it("forwards anchor to the base-ui Positioner, not the Root", () => {
    const anchor = anchoredElement()
    render(
      <Popover open>
        <PopoverContent anchor={anchor}>positioned body</PopoverContent>
      </Popover>
    )
    // The popup still renders normally…
    expect(screen.getByText("positioned body")).not.toBeNull()
    // …and the anchor reaches the Positioner (where base-ui actually
    // reads it).
    expect(positionerCapture.last).not.toBeNull()
    expect(positionerCapture.last?.anchor).toBe(anchor)
  })

  it("stays backward compatible: no anchor → Positioner gets none", () => {
    render(
      <Popover open>
        <PopoverContent>plain body</PopoverContent>
      </Popover>
    )
    expect(screen.getByText("plain body")).not.toBeNull()
    expect(positionerCapture.last).not.toBeNull()
    expect(positionerCapture.last?.anchor).toBeUndefined()
  })

  it("SnoozeCustomPicker anchors its open picker at the invoking element", () => {
    const anchor = anchoredElement()
    render(
      <SnoozeCustomPicker
        open
        onOpenChange={() => {}}
        anchor={anchor}
        onConfirm={() => {}}
      />
    )
    expect(screen.getByTestId("snooze-custom-picker")).not.toBeNull()
    expect(positionerCapture.last?.anchor).toBe(anchor)
  })

  it("ScheduleSendCustomPicker anchors its open picker at the invoking element", () => {
    const anchor = anchoredElement()
    render(
      <ScheduleSendCustomPicker
        open
        onOpenChange={() => {}}
        anchor={anchor}
        onConfirm={() => {}}
      />
    )
    expect(screen.getByTestId("schedule-custom-picker")).not.toBeNull()
    expect(positionerCapture.last?.anchor).toBe(anchor)
  })
})
