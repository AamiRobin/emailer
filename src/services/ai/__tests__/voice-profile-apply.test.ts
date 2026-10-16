import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The provider transport is the seam under mock: the REAL client module
// stays loaded (gating, tier resolution and cache identity run for real)
// with aiChat replaced — assertions target the ASSEMBLED system prompts
// (snapshot-tested per the task) and the cache identity behavior.
const aiChatMock = vi.hoisted(() => vi.fn())

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>()
  return { ...actual, aiChat: aiChatMock }
})

import { generateDraftFromPrompt, generateReplyForThread } from "../compose-generate"
import { transformDraftText } from "../compose-transform"
import {
  loadVoiceProfileApplication,
  saveVoiceProfile,
  WRITING_VOICE_NOTICE,
  type VoiceProfile,
} from "../voice-profile"
import { saveWritingStyleProfile } from "../writing-style"
import { addProvider, setActiveProvider, setAiEnabled } from "../settings"
import {
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"

/**
 * Writing-voice profile APPLICATION tests (parity-round-3 task 7.4, spec
 * scenario "Apply to drafts"): when a stored profile exists, the DRAFT
 * (prompt + reply generation), PROOFREAD (compose transforms) and
 * SMART-REPLY system prompts append the fenced WRITING VOICE block;
 * absence changes NOTHING — the assembled prompts are snapshot-locked in
 * both states. Also here: the profile's learnedAt folds into the caching
 * surfaces' ai_cache identity (a learned/refreshed profile invalidates),
 * absence keeps the identity byte-identical, and the account style
 * profile of smart replies coexists with the global voice one.
 */

let executor: TestExecutor
let accountId: string
let threadId: string

const SAMPLE_PROFILE: VoiceProfile = {
  version: 1,
  tone: "warm, direct",
  formality: "business-casual",
  length: "short — a few sentences",
  vocabulary: "plain words, little jargon",
  quirks: ["opens with a quick acknowledgment", "uses dashes for asides"],
  greetingStyle: "Hi {name},",
  signoffStyle: "Best,",
}

/** A fixed descriptor learned at a fixed time — snapshot-stable. */
async function seedVoiceProfile(learnedAt = 1_700_000_500): Promise<void> {
  await saveVoiceProfile(
    executor,
    JSON.stringify(SAMPLE_PROFILE),
    5,
    () => learnedAt
  )
}

function systemPromptOf(callIndex: number): string {
  const args = aiChatMock.mock.calls[callIndex][0] as { system: string }
  return args.system
}

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor)
  aiChatMock.mockReset()
  aiChatMock.mockResolvedValue("Generated answer.")
  await setAiEnabled(executor, true)
  const created = await addProvider(executor, {
    kind: "anthropic",
    label: "Work",
    model: "claude-sonnet-4-5",
  })
  await setActiveProvider(executor, created.id)
  // A reply/forward target thread with one message.
  threadId = await createThread(executor, accountId, { subject: "Plan" })
  const labelId = await createGmailLabel(
    executor,
    accountId,
    "Sent",
    "SENT",
    "sent"
  )
  void labelId
  await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000,
    subject: "Plan",
    fromAddress: "peer@example.com",
    bodyText: "When do we launch?",
  })
})

afterEach(() => {
  executor.close()
})

describe("draft generation applies the profile (task 7.4)", () => {
  it("absence leaves the prompt byte-identical to the pre-feature shape", async () => {
    await generateDraftFromPrompt({
      prompt: "Write a birthday invite",
      accountId,
      executor,
    })
    expect(systemPromptOf(0)).toMatchSnapshot(
      "draft system prompt without a voice profile"
    )
  })

  it("a stored profile appends the fenced block", async () => {
    await seedVoiceProfile()
    await generateDraftFromPrompt({
      prompt: "Write a birthday invite",
      accountId,
      executor,
    })
    const system = systemPromptOf(0)
    expect(system).toContain(WRITING_VOICE_NOTICE)
    expect(system).toContain("=== BEGIN WRITING VOICE ===")
    expect(system).toContain('"greetingStyle": "Hi {name},"')
    // The base instructions still lead; the block appends.
    expect(system.indexOf("email writing assistant")).toBeLessThan(
      system.indexOf("=== BEGIN WRITING VOICE ===")
    )
    expect(system).toMatchSnapshot(
      "draft system prompt with a voice profile"
    )
  })

  it("learning or refreshing the profile invalidates the draft cache; absence keeps the identity", async () => {
    await generateDraftFromPrompt({
      prompt: "Write a birthday invite",
      accountId,
      executor,
    })
    // Same inputs again: served from ai_cache, no new provider call.
    await generateDraftFromPrompt({
      prompt: "Write a birthday invite",
      accountId,
      executor,
    })
    expect(aiChatMock).toHaveBeenCalledTimes(1)

    // A profile now exists: the identity changes, so the next call is a
    // live request carrying the block.
    await seedVoiceProfile()
    const withProfile = await generateDraftFromPrompt({
      prompt: "Write a birthday invite",
      accountId,
      executor,
    })
    expect(withProfile.cached).toBe(false)
    expect(aiChatMock).toHaveBeenCalledTimes(2)

    // REFRESH (new learnedAt): invalidates again, and the prompt carries
    // the refreshed voice, not the cached one.
    await seedVoiceProfile(1_700_100_000)
    const refreshed = await generateDraftFromPrompt({
      prompt: "Write a birthday invite",
      accountId,
      executor,
    })
    expect(refreshed.cached).toBe(false)
    expect(aiChatMock).toHaveBeenCalledTimes(3)
  })
})

describe("generated replies apply the profile (task 7.4)", () => {
  it("absence leaves the prompt untouched; a stored profile appends the fenced block", async () => {
    await generateReplyForThread({ accountId, threadId, executor })
    expect(systemPromptOf(0)).toMatchSnapshot(
      "reply system prompt without a voice profile"
    )

    await seedVoiceProfile()
    await generateReplyForThread({ accountId, threadId, executor })
    const withProfile = systemPromptOf(1)
    expect(withProfile).toContain(WRITING_VOICE_NOTICE)
    expect(withProfile).toContain("=== END WRITING VOICE ===")
    expect(withProfile).toMatchSnapshot(
      "reply system prompt with a voice profile"
    )
  })

  it("the voice learnedAt folds the reply cache identity (refresh regenerates)", async () => {
    await seedVoiceProfile(1_700_000_500)
    await generateReplyForThread({ accountId, threadId, executor })
    await generateReplyForThread({ accountId, threadId, executor })
    expect(aiChatMock).toHaveBeenCalledTimes(1) // cached

    await seedVoiceProfile(1_700_200_000)
    const refreshed = await generateReplyForThread({
      accountId,
      threadId,
      executor,
    })
    expect(refreshed.cached).toBe(false)
    expect(aiChatMock).toHaveBeenCalledTimes(2)
  })
})

describe("compose transforms (proofread) apply the profile (task 7.4)", () => {
  it("absence leaves the per-mode prompt untouched; a stored profile appends the fenced block", async () => {
    await transformDraftText({
      text: "pls review this draft text",
      mode: "improve",
      executor,
    })
    expect(systemPromptOf(0)).toMatchSnapshot(
      "transform system prompt without a voice profile"
    )

    await seedVoiceProfile()
    await transformDraftText({
      text: "pls review this draft text",
      mode: "improve",
      executor,
    })
    const withProfile = systemPromptOf(1)
    expect(withProfile).toContain(WRITING_VOICE_NOTICE)
    expect(withProfile).toContain("=== BEGIN WRITING VOICE ===")
    expect(withProfile).toMatchSnapshot(
      "transform system prompt with a voice profile"
    )
  })
})

describe("smart replies apply the profile alongside the account style (task 7.4)", () => {
  it("absence changes nothing; presence appends the fenced block AFTER the account profile", async () => {
    // The per-account style profile (the earlier round's artifact) is
    // stored: smart replies keep their existing behavior…
    await saveWritingStyleProfile(
      executor,
      accountId,
      JSON.stringify({
        version: 1,
        tone: "warm",
        formality: "casual",
        typicalLength: "short",
        greetings: ["Hi NAME"],
        signOffs: ["Thanks,"],
        phrasing: [],
      }),
      2
    )
    const { generateSmartReply: generate } = await import("../smart-replies")
    const first = await generate(executor, accountId, threadId)
    expect(first).toMatchObject({ ok: true })
    expect(systemPromptOf(0)).toMatchSnapshot(
      "smart-reply system prompt without a voice profile"
    )

    // …the GLOBAL voice profile appends after it (both describe the same
    // writer; the voice block is the newer, cross-account statement).
    await seedVoiceProfile()
    const second = await generate(executor, accountId, threadId)
    expect(second).toMatchObject({ ok: true, cached: false })
    const withProfile = systemPromptOf(1)
    expect(withProfile).toContain("STYLE PROFILE:")
    expect(withProfile).toContain(WRITING_VOICE_NOTICE)
    expect(
      withProfile.indexOf("STYLE PROFILE:")
    ).toBeLessThan(withProfile.indexOf("=== BEGIN WRITING VOICE ==="))
    expect(withProfile).toMatchSnapshot(
      "smart-reply system prompt with a voice profile"
    )
  })

  it("the voice learnedAt folds the smart-reply cache identity", async () => {
    await saveWritingStyleProfile(
      executor,
      accountId,
      JSON.stringify({
        version: 1,
        tone: "warm",
        formality: "casual",
        typicalLength: "short",
        greetings: [],
        signOffs: [],
        phrasing: [],
      }),
      1
    )
    const { generateSmartReply: generate } = await import("../smart-replies")
    await generate(executor, accountId, threadId)
    await generate(executor, accountId, threadId)
    expect(aiChatMock).toHaveBeenCalledTimes(1) // cached

    await seedVoiceProfile(1_700_300_000)
    const withVoice = await generate(executor, accountId, threadId)
    expect(withVoice).toMatchObject({ ok: true, cached: false })
    expect(aiChatMock).toHaveBeenCalledTimes(2)
  })
})

describe("loadVoiceProfileApplication", () => {
  it("absent profile → both components null; present → notice + fenced block + identity", async () => {
    expect(await loadVoiceProfileApplication(executor)).toEqual({
      prompt: null,
      cacheComponent: null,
    })
    await seedVoiceProfile(1_700_400_000)
    const applied = await loadVoiceProfileApplication(executor)
    expect(applied.cacheComponent).toBe("voice:1700400000")
    expect(applied.prompt).toContain(WRITING_VOICE_NOTICE)
    expect(applied.prompt).toContain("=== BEGIN WRITING VOICE ===")
  })
})
