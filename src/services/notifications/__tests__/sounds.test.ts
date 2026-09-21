import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Notification sounds tests (task 1.5, settings spec, design D12). The
 * executor module is mocked to hand the service the shared node:sqlite
 * executor, so the toggle persistence runs against the REAL preferences
 * accessors; the WebAudio side runs against a minimal fake AudioContext
 * (jsdom ships none) that records the struck chime partials.
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
}))

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  getNewMailSoundEnabled,
  getSentSoundEnabled,
  setNewMailSoundPreference,
  setSentSoundPreference,
} from "@/services/settings/preferences"
import {
  playNewMailSound,
  playSentSound,
  resetSoundsForTests,
} from "../sounds"

// ---- Minimal WebAudio fake -------------------------------------------------

const createdFrequencies: number[][] = []

class FakeOscillator {
  type = "sine"
  frequency = {
    setValueAtTime: (value: number) => {
      createdFrequencies[createdFrequencies.length - 1].push(value)
    },
  }
  connect(): void {}
  start(): void {}
  stop(): void {}
}

class FakeGain {
  connect(): void {}
  gain = {
    setValueAtTime: () => {},
    linearRampToValueAtTime: () => {},
    exponentialRampToValueAtTime: () => {},
  }
}

class FakeAudioContext {
  state = "running"
  destination = {}
  resume = vi.fn(async () => {})
  createOscillator(): FakeOscillator {
    createdFrequencies.push([])
    return new FakeOscillator()
  }
  createGain(): FakeGain {
    return new FakeGain()
  }
}

function useFakeContext(
  overrides?: Partial<FakeAudioContext>
): FakeAudioContext {
  const context = Object.assign(new FakeAudioContext(), overrides)
  // A real `function` constructor: `new AudioContext()` must work (an
  // arrow function would throw under `new` — which sounds.ts swallows).
  const Ctor = function AudioContextStub() {
    return context
  } as unknown as new () => FakeAudioContext
  vi.stubGlobal("AudioContext", Ctor)
  return context
}

beforeEach(() => {
  createdFrequencies.length = 0
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---- Tests -----------------------------------------------------------------

describe("notification sounds (task 1.5)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
    executorHolder.current = executor
  })

  afterEach(() => {
    executorHolder.current = null
    executor.close()
    resetSoundsForTests()
  })

  it("defaults new-mail sound on and sent sound off", async () => {
    expect(await getNewMailSoundEnabled(executor)).toBe(true)
    expect(await getSentSoundEnabled(executor)).toBe(false)
  })

  it("persists both sound toggles", async () => {
    await setNewMailSoundPreference(executor, false)
    await setSentSoundPreference(executor, true)
    expect(await getNewMailSoundEnabled(executor)).toBe(false)
    expect(await getSentSoundEnabled(executor)).toBe(true)

    await setNewMailSoundPreference(executor, true)
    await setSentSoundPreference(executor, false)
    expect(await getNewMailSoundEnabled(executor)).toBe(true)
    expect(await getSentSoundEnabled(executor)).toBe(false)
  })

  it("reads corrupt rows as the defaults", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["notifications.soundNewMail", JSON.stringify("yes")]
    )
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["notifications.soundSent", JSON.stringify(1)]
    )
    expect(await getNewMailSoundEnabled(executor)).toBe(true)
    expect(await getSentSoundEnabled(executor)).toBe(false)
  })

  it("plays the new-mail chime when the toggle is on", async () => {
    useFakeContext()
    await playNewMailSound()
    // Two struck partials: the rising chime (A5 → D6).
    expect(createdFrequencies).toEqual([[880], [1174.66]])
  })

  it("plays no new-mail chime when the toggle is off", async () => {
    useFakeContext()
    await setNewMailSoundPreference(executor, false)

    await playNewMailSound()

    expect(createdFrequencies).toEqual([])
  })

  it("plays no sent chime by default and one when enabled", async () => {
    useFakeContext()

    await playSentSound()
    expect(createdFrequencies).toEqual([])

    await setSentSoundPreference(executor, true)
    await playSentSound()
    // Two struck partials: the falling pair (B5 → E5).
    expect(createdFrequencies).toEqual([[987.77], [659.25]])
  })

  it("attempts to resume a suspended context without throwing", async () => {
    // Suspended context (autoplay policy) whose resume the webview
    // refuses: the play still must not throw into the notification path.
    const context = useFakeContext()
    const resumeSpy = vi.fn(async () => {
      throw new Error("not allowed")
    })
    Object.assign(context, { state: "suspended", resume: resumeSpy })

    await expect(playNewMailSound()).resolves.toBeUndefined()
    expect(resumeSpy).toHaveBeenCalledTimes(1)
    // The chime is still struck (whether it is audible is the
    // webview's call) — and nothing propagated.
    expect(createdFrequencies).toEqual([[880], [1174.66]])
  })

  it("stays silent without any AudioContext (no WebAudio runtime)", async () => {
    // jsdom default: no AudioContext global at all.
    await expect(playNewMailSound()).resolves.toBeUndefined()
    await expect(playSentSound()).resolves.toBeUndefined()
    expect(createdFrequencies).toEqual([])
  })

  it("swallows a failed settings read (play never throws)", async () => {
    executorHolder.current = null
    useFakeContext()

    await expect(playNewMailSound()).resolves.toBeUndefined()
    await expect(playSentSound()).resolves.toBeUndefined()
    expect(createdFrequencies).toEqual([])
  })
})
