import { beforeEach, describe, expect, it } from "vitest"

import { usePaletteStore } from "../palette-store"

beforeEach(() => {
  usePaletteStore.setState({ open: false })
})

describe("palette store", () => {
  it("starts closed", () => {
    expect(usePaletteStore.getState().open).toBe(false)
  })

  it("setOpen toggles the dialog state", () => {
    usePaletteStore.getState().setOpen(true)
    expect(usePaletteStore.getState().open).toBe(true)
    usePaletteStore.getState().setOpen(false)
    expect(usePaletteStore.getState().open).toBe(false)
  })

  it("close only closes (never opens)", () => {
    usePaletteStore.getState().setOpen(true)
    usePaletteStore.getState().close()
    expect(usePaletteStore.getState().open).toBe(false)
    usePaletteStore.getState().close()
    expect(usePaletteStore.getState().open).toBe(false)
  })
})
