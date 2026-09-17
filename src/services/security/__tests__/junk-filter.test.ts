import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { countJunkTokens } from "../../db/junk-tokens"
import { setJunkFilterEnabledPreference } from "../../settings/preferences"
import {
  classifyJunkText,
  JUNK_AUTO_MOVE_THRESHOLD,
  JUNK_MIN_TRAINING_SPAM_EVENTS,
  junkFilterTrainingActive,
  loadJunkFilterConfig,
  shouldAutoMove,
  tokenizeJunkText,
  trainJunkDocument,
  trainJunkFromMessages,
} from "../junk-filter"

/**
 * Junk filter core (task 18.10, design D19): the deterministic tokenizer,
 * the naive-Bayes combination (formula pinned by exact single/dual-token
 * cases), the auto-move gate's two bounds, the counter-only training
 * round-trip and the IMAP-only guards (gmail never trains, never loads a
 * config). The confidence-behavior scenarios run against a seeded
 * training set through the REAL junk_tokens table (node:sqlite executor).
 */

const SPAM_TEXT = "buy cheap pills now winner"
const HAM_TEXT = "meeting notes from the project review"

describe("tokenizer", () => {
  it("lowercases, splits on non-alphanumerics and drops short tokens", () => {
    expect(tokenizeJunkText("Hello, World! Buy-CHEAP pills a1 ab abc")).toEqual(
      ["hello", "world", "buy", "cheap", "pills", "abc"]
    )
  })

  it("yields nothing for text without eligible tokens", () => {
    expect(tokenizeJunkText("!! ... a b 12")).toEqual([])
  })

  it("caps the document at 200 tokens in document order", () => {
    const tokens = tokenizeJunkText(
      Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ")
    )
    expect(tokens).toHaveLength(200)
    expect(tokens[0]).toBe("word0")
    expect(tokens[199]).toBe("word199")
  })
})

describe("classifier formula", () => {
  const config = {
    tokens: new Map([["foo", { spamCount: 3, hamCount: 1 }]]),
    spamDocuments: 10,
    hamDocuments: 10,
  }

  it("returns exactly 0.5 when no token is known (neutral prior)", () => {
    expect(classifyJunkText("unknown words only", null, config)).toBe(0.5)
  })

  it("with one known token the posterior equals its clamped spam share", () => {
    // p(foo) = 3/4; the single-token Graham combination reduces to p.
    expect(classifyJunkText("foo bar", null, config)).toBeCloseTo(0.75, 12)
  })

  it("combines tokens in log space (balanced votes → 0.5)", () => {
    const dual = {
      tokens: new Map([
        ["foo", { spamCount: 3, hamCount: 1 }], // p = 0.75
        ["baz", { spamCount: 1, hamCount: 3 }], // p = 0.25
      ]),
      spamDocuments: 10,
      hamDocuments: 10,
    }
    // Πp = 0.75·0.25 = Π(1−p) — the odds cancel exactly.
    expect(classifyJunkText("foo baz", null, dual)).toBeCloseTo(0.5, 12)
  })

  it("a token is one vote per document however often it repeats", () => {
    const repeated = classifyJunkText("foo foo foo foo", null, config)
    const once = classifyJunkText("foo", null, config)
    expect(repeated).toBeCloseTo(once, 12)
  })

  it("is deterministic for identical inputs", () => {
    const first = classifyJunkText("foo", "bar foo", config)
    const second = classifyJunkText("foo", "bar foo", config)
    expect(first).toBe(second)
  })
})

describe("confidence behavior with a seeded training set", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "imap")
    // The probes read the store through the production config path, which
    // is opt-in — this describe studies confidence, not the gate.
    await setJunkFilterEnabledPreference(executor, accountId, true)
  })

  afterEach(() => {
    executor.close()
  })

  /** The unseen spammy probe's posterior against the account's REAL
   * trained store (loaded via the production config path). */
  async function probePosterior(): Promise<number> {
    const loaded = await loadJunkFilterConfig(executor, accountId)
    if (!loaded) throw new Error("config missing")
    return classifyJunkText(SPAM_TEXT, null, loaded)
  }

  /** Seed through the REAL training path: `hamCopies` ham documents that
   * share the "cheap" token keep the posterior from saturating, so the
   * spam accumulation is visible as a RISE. */
  async function seedCorpus(hamCopies: number, spamCopies: number) {
    for (let i = 0; i < hamCopies; i += 1) {
      await trainJunkDocument(
        executor,
        accountId,
        "cheap deal at the local store",
        false
      )
    }
    for (let i = 0; i < spamCopies; i += 1) {
      await trainJunkDocument(executor, accountId, SPAM_TEXT, true)
    }
  }

  it("repeated mark-spam raises the posterior of similar mail", async () => {
    await seedCorpus(5, 1)
    const afterOne = await probePosterior()
    await trainJunkDocument(executor, accountId, SPAM_TEXT, true)
    const afterTwo = await probePosterior()
    await trainJunkDocument(executor, accountId, SPAM_TEXT, true)
    const afterThree = await probePosterior()

    expect(afterOne).toBeGreaterThan(0.5)
    expect(afterTwo).toBeGreaterThan(afterOne)
    expect(afterThree).toBeGreaterThan(afterTwo)
  })

  it("not-spam retraining lowers the posterior of similar mail", async () => {
    await seedCorpus(0, 10)
    const before = await probePosterior()
    expect(before).toBeGreaterThan(0.5)

    // The markNotSpam correction trains the SAME text as ham (the spec's
    // "retrains so similar mail is less likely junk").
    await trainJunkDocument(executor, accountId, SPAM_TEXT, false)
    await trainJunkDocument(executor, accountId, SPAM_TEXT, false)
    const after = await probePosterior()
    expect(after).toBeLessThan(before)
  })

  it("untrained accounts classify neutral (below any auto-move gate)", async () => {
    expect(await probePosterior()).toBe(0.5)
  })

  it("training is counter-only: retraining accumulates, never resets", async () => {
    await trainJunkDocument(executor, accountId, "uniqueoffer", true)
    await trainJunkDocument(executor, accountId, "uniqueoffer", true)
    await trainJunkDocument(executor, accountId, "uniqueoffer", false)

    const loaded = await loadJunkFilterConfig(executor, accountId)
    expect(loaded?.tokens.get("uniqueoffer")).toEqual({
      spamCount: 2,
      hamCount: 1,
    })
    expect(loaded?.spamDocuments).toBe(2)
    expect(loaded?.hamDocuments).toBe(1)
    expect(await countJunkTokens(executor, accountId)).toBe(1)
  })

  it("trainJunkFromMessages trains one document per message", async () => {
    await trainJunkFromMessages(
      executor,
      accountId,
      [
        { subject: "Win a prize", body_text: SPAM_TEXT },
        { subject: null, body_text: HAM_TEXT },
      ],
      true
    )
    const loaded = await loadJunkFilterConfig(executor, accountId)
    expect(loaded?.spamDocuments).toBe(2)
    expect(loaded?.tokens.get("prize")).toEqual({ spamCount: 1, hamCount: 0 })
    expect(loaded?.tokens.get("meeting")).toEqual({
      spamCount: 1,
      hamCount: 0,
    })
  })
})

describe("auto-move gate", () => {
  it("requires BOTH the posterior bound and the training sample", () => {
    expect(
      shouldAutoMove(JUNK_AUTO_MOVE_THRESHOLD, JUNK_MIN_TRAINING_SPAM_EVENTS)
    ).toBe(true)
    // Just below the posterior bound → inbox even with ample training.
    expect(shouldAutoMove(JUNK_AUTO_MOVE_THRESHOLD - 0.0001, 500)).toBe(false)
    // Just below the training sample → inbox even at posterior 1.
    expect(shouldAutoMove(1, JUNK_MIN_TRAINING_SPAM_EVENTS - 1)).toBe(false)
    expect(shouldAutoMove(0.99, 49)).toBe(false)
    expect(shouldAutoMove(0.99, 50)).toBe(true)
  })

  it("accepts explicit thresholds (the dials stay testable)", () => {
    expect(
      shouldAutoMove(0.6, 5, { posteriorThreshold: 0.6, minSpamDocuments: 5 })
    ).toBe(true)
    expect(
      shouldAutoMove(0.6, 4, { posteriorThreshold: 0.6, minSpamDocuments: 5 })
    ).toBe(false)
  })
})

describe("guards (D19: IMAP-only, opt-in)", () => {
  let executor: TestExecutor
  let imapId: string
  let gmailId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    imapId = await createAccount(executor, "imap")
    gmailId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  it("config is null while the toggle is off (the default)", async () => {
    expect(await loadJunkFilterConfig(executor, imapId)).toBeNull()
    expect(await junkFilterTrainingActive(executor, imapId)).toBe(false)
  })

  it("config is null for gmail even with the toggle on (exemption)", async () => {
    await trainJunkDocument(executor, gmailId, SPAM_TEXT, true)
    await setJunkFilterEnabledPreference(executor, gmailId, true)
    expect(await loadJunkFilterConfig(executor, gmailId)).toBeNull()
    expect(await junkFilterTrainingActive(executor, gmailId)).toBe(false)
  })

  it("an enabled imap account gets a full config (tokens + doc counts)", async () => {
    await trainJunkDocument(executor, imapId, SPAM_TEXT, true)
    await setJunkFilterEnabledPreference(executor, imapId, true)

    const loaded = await loadJunkFilterConfig(executor, imapId)
    expect(loaded?.tokens.get("pills")).toEqual({ spamCount: 1, hamCount: 0 })
    expect(loaded?.spamDocuments).toBe(1)
    expect(await junkFilterTrainingActive(executor, imapId)).toBe(true)
  })

  it("config is null for a missing account", async () => {
    expect(await loadJunkFilterConfig(executor, "acc-ghost")).toBeNull()
    expect(await junkFilterTrainingActive(executor, "acc-ghost")).toBe(false)
  })
})
