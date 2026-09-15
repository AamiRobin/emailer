/**
 * References-based thread grouping for IMAP accounts (design D9): walk
 * In-Reply-To/References chains with a normalized-subject fallback — a
 * pragmatic subset of JWZ (https://www.jwz.org/doc/threading.html)
 * sufficient for reply chains. Pure functions: no db, no provider, no
 * clock — the sync engine (imap-sync.ts) feeds batches in and persists
 * the groups out, so the algorithm is unit-testable in isolation.
 */

/** Minimal message shape threading needs (subset of NormalizedMessage). */
export interface ThreadableMessage {
  /** Local message id (the caller's key; echoed back in groups). */
  id: string
  /** RFC 5322 Message-ID header, bracketed ("<a@b>") or bare ("a@b"). */
  messageId?: string | null
  /** Message-ID of the message this one replies to. */
  inReplyTo?: string | null
  /** Space-separated ancestor chain, oldest first, as sent by the server. */
  references?: string | null
  subject?: string | null
  /** unix epoch seconds — only used for stable ordering, never the clock. */
  date: number
}

export interface ThreadGroup {
  /**
   * Deterministic thread key: the normalized Message-ID of the thread
   * root (which may be a phantom — a referenced-but-unseen Message-ID),
   * else "subject:<normalized subject>", else "local:<first message id>".
   * Stable across sync runs so delta batches land in the same thread.
   */
  key: string
  /** Member message ids, sorted by (date, id). */
  messageIds: string[]
}

export interface ThreadingOptions {
  /**
   * Merge unrelated root messages sharing a normalized subject into one
   * thread (default true). Disable to group strictly by references.
   */
  groupBySubject?: boolean
}

/**
 * Prefix for container keys of messages that carry no Message-ID header.
 * Uses characters that cannot appear in a Message-ID (whitespace split /
 * bracket stripping) so a synthetic key never collides with a real one.
 */
const LOCAL_KEY_PREFIX = "local:"

// ---------------------------------------------------------------------------
// Normalization helpers (shared with thread-lookup.ts and the sync engine)
// ---------------------------------------------------------------------------

/**
 * Normalize a Message-ID to its bare form: trim whitespace and strip one
 * pair of surrounding angle brackets. "<a@b>" and "a@b" collapse to the
 * same key; case is preserved (RFC 5322 msg-id is case-sensitive).
 */
export function normalizeMessageId(raw: string | null | undefined): string {
  if (!raw) return ""
  const trimmed = raw.trim()
  if (!trimmed) return ""
  return trimmed.replace(/^<+/, "").replace(/>+$/, "").trim()
}

/** Both header spellings of a Message-ID — for SQL lookups against rows
 * stored exactly as the server returned them. */
export function messageIdVariants(raw: string): string[] {
  const bare = normalizeMessageId(raw)
  if (!bare) return []
  return [bare, `<${bare}>`]
}

/**
 * Parse a References/In-Reply-To header into normalized ids, in order.
 * Bracketed ids take precedence; a header with no brackets (or a bare
 * In-Reply-To) falls back to whitespace/comma-separated tokens.
 */
export function parseReferences(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) return []
  const ids: string[] = []
  const bracketed = /<([^<>]+)>/g
  let match: RegExpExecArray | null
  while ((match = bracketed.exec(raw)) !== null) {
    const id = normalizeMessageId(match[1])
    if (id) ids.push(id)
  }
  if (ids.length === 0) {
    for (const token of raw.split(/[\s,]+/)) {
      const id = normalizeMessageId(token)
      if (id) ids.push(id)
    }
  }
  return [...new Set(ids)]
}

/**
 * Normalize a subject for fallback grouping: strip repeated Re:/Fwd:/Fw:
 * prefixes, trim, lowercase, collapse internal whitespace. "Re: Re: hello"
 * and "  HELLO  " compare equal; a subject that is only prefixes ("Re:")
 * normalizes to "".
 */
export function normalizeSubject(subject: string | null | undefined): string {
  if (!subject) return ""
  let current = subject.trim()
  let changed = true
  while (changed) {
    changed = false
    const prefix = /^(?:re|fwd|fw)\s*:\s*/i.exec(current)
    if (prefix) {
      current = current.slice(prefix[0].length)
      changed = true
    }
  }
  return current.replace(/\s+/g, " ").trim().toLowerCase()
}

// ---------------------------------------------------------------------------
// Container tree (JWZ step 1–3)
// ---------------------------------------------------------------------------

interface Container {
  /** Normalized Message-ID, or the synthetic local key. */
  key: string
  /** True when the key is synthetic (message had no Message-ID header). */
  synthetic: boolean
  /** All messages sharing this container (duplicate Message-IDs keep
   * every copy — the group must not lose them). */
  messages: ThreadableMessage[]
  parent: Container | null
  children: Container[]
}

function createContainer(key: string, synthetic: boolean): Container {
  return { key, synthetic, messages: [], parent: null, children: [] }
}

function isAncestor(container: Container, ancestor: Container): boolean {
  let current: Container | null = container
  while (current !== null) {
    if (current === ancestor) return true
    current = current.parent
  }
  return false
}

function unlinkFromParent(child: Container): void {
  if (!child.parent) return
  child.parent.children = child.parent.children.filter((c) => c !== child)
  child.parent = null
}

/**
 * Link parent←child, refusing cycles and redundant relinks: skip when
 * the child is already an ancestor of the parent (would point the
 * subtree at its own descendant) and when the parent is already an
 * ancestor of the child (nothing to do).
 */
function linkParentChild(parent: Container, child: Container): void {
  if (parent === child) return
  if (isAncestor(parent, child)) return
  if (isAncestor(child, parent)) return
  unlinkFromParent(child)
  child.parent = parent
  parent.children.push(child)
}

/** First non-empty subject on a container or, for phantoms, its children. */
function subjectForContainer(container: Container): string | null {
  for (const message of container.messages) {
    if (message.subject) return message.subject
  }
  for (const child of container.children) {
    const subject = subjectForContainer(child)
    if (subject) return subject
  }
  return null
}

/** Sort key for messages inside a group: date first, id as tiebreak. */
function byDateThenId(a: ThreadableMessage, b: ThreadableMessage): number {
  if (a.date !== b.date) return a.date - b.date
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Deterministic thread key for a root container. Synthetic roots (a
 * message without a Message-ID header) fall back to the normalized
 * subject — only when subject grouping is on, otherwise distinct
 * subject-less roots would still share one key — and to the first
 * member id as a last resort. */
function rootKeyFor(root: Container, allowSubjectKey: boolean): string {
  if (!root.synthetic) return root.key
  if (allowSubjectKey) {
    const subject = normalizeSubject(subjectForContainer(root))
    if (subject) return `subject:${subject}`
  }
  const first = [...root.messages].sort(byDateThenId)[0]
  return `${LOCAL_KEY_PREFIX}${first ? first.id : root.key}`
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Group messages into threads. Walks References + In-Reply-To chains
 * (JWZ steps 1–3), optionally merges same-subject roots (step 4), and
 * returns one group per thread with members sorted by (date, id) and
 * groups sorted by key — deterministic and stable for identical input.
 *
 * `existingGroups` (optional): groups returned by a previous call whose
 * members may partially overlap `messages`. Groups recompute from the
 * given messages and merge with these by key (union of member ids), so
 * an incremental batch can extend previously returned threads.
 */
export function groupIntoThreads(
  messages: ThreadableMessage[],
  existingGroups: ThreadGroup[] = [],
  options: ThreadingOptions = {}
): ThreadGroup[] {
  const groupBySubject = options.groupBySubject ?? true

  // Step 1: ID table — one container per normalized Message-ID.
  const idTable = new Map<string, Container>()
  function getOrCreate(key: string, synthetic = false): Container {
    let container = idTable.get(key)
    if (!container) {
      container = createContainer(key, synthetic)
      idTable.set(key, container)
    }
    return container
  }

  // Step 2: register messages and link parent→child along the combined
  // References + In-Reply-To chain.
  for (const message of messages) {
    const ownId = normalizeMessageId(message.messageId)
    const key = ownId || `${LOCAL_KEY_PREFIX}${message.id}`
    const container = getOrCreate(key, ownId === "")
    container.messages.push(message)

    const refIds = parseReferences(message.references)
    for (const inReplyTo of parseReferences(message.inReplyTo)) {
      if (!refIds.includes(inReplyTo)) refIds.push(inReplyTo)
    }

    let prev: Container | null = null
    for (const refId of refIds) {
      if (refId === key) continue
      const refContainer = getOrCreate(refId)
      if (prev !== null && refContainer.parent === null) {
        linkParentChild(prev, refContainer)
      }
      prev = refContainer
    }
    if (prev !== null) {
      linkParentChild(prev, container)
    }
  }

  // Step 3: root set — containers without a parent.
  let roots = [...idTable.values()].filter((c) => c.parent === null)

  // Step 4 (optional): merge roots sharing a normalized subject. The
  // surviving root is the phantom with the oldest date (missing date
  // sorts first), so re-running on later batches keeps one stable root.
  if (groupBySubject) {
    const bySubject = new Map<string, Container[]>()
    for (const root of roots) {
      const subject = normalizeSubject(subjectForContainer(root))
      if (!subject) continue
      const bucket = bySubject.get(subject)
      if (bucket) bucket.push(root)
      else bySubject.set(subject, [root])
    }
    for (const bucket of bySubject.values()) {
      if (bucket.length < 2) continue
      const ordered = bucket.sort((a, b) => {
        const dateA = a.messages.length
          ? Math.min(...a.messages.map((m) => m.date))
          : Number.NEGATIVE_INFINITY
        const dateB = b.messages.length
          ? Math.min(...b.messages.map((m) => m.date))
          : Number.NEGATIVE_INFINITY
        if (dateA !== dateB) return dateA - dateB
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
      })
      const survivor = ordered[0]
      for (const other of ordered.slice(1)) {
        linkParentChild(survivor, other)
      }
    }
    roots = roots.filter((c) => c.parent === null)
  }

  // Step 5: collect groups depth-first, every message exactly once.
  const computed: ThreadGroup[] = []
  const visited = new Set<Container>()
  for (const root of roots) {
    const collected: ThreadableMessage[] = []
    const stack = [root]
    while (stack.length > 0) {
      const container = stack.pop()
      if (!container || visited.has(container)) continue
      visited.add(container)
      collected.push(...container.messages)
      stack.push(...container.children)
    }
    if (collected.length === 0) continue
    collected.sort(byDateThenId)
    computed.push({
      key: rootKeyFor(root, groupBySubject),
      messageIds: collected.map((m) => m.id),
    })
  }

  // Merge with pre-existing groups by key (union, order-preserving) and
  // return groups sorted by key for deterministic output.
  const merged = new Map<string, string[]>()
  for (const group of existingGroups) {
    merged.set(group.key, [...group.messageIds])
  }
  for (const group of computed) {
    const previous = merged.get(group.key)
    if (!previous) {
      merged.set(group.key, group.messageIds)
      continue
    }
    const union = [...previous]
    for (const id of group.messageIds) {
      if (!union.includes(id)) union.push(id)
    }
    merged.set(group.key, union)
  }
  return [...merged.entries()]
    .map(([key, messageIds]) => ({ key, messageIds }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
