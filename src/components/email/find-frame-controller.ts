import {
  EMAILER_FIND_ACTIVE_ATTR,
  EMAILER_FIND_COMMAND_TYPE,
  EMAILER_FIND_ESCAPE_TYPE,
  EMAILER_FIND_MARK_ATTR,
  EMAILER_FIND_OPEN_TYPE,
  EMAILER_FIND_STATE_TYPE,
  MAX_FIND_MATCHES,
} from "./find-session"

/**
 * The frame-side find controller (task 1.1, design D5) — the code that
 * runs INSIDE the sandboxed email frame. safe-email-frame.tsx serializes
 * it into the frame document with Function.prototype.toString, so it MUST
 * stay self-contained: no references beyond its own scope and its `params`
 * argument (a bundled identifier would be renamed out from under the
 * serialized string in production builds). Tests call the function
 * directly against a nested jsdom frame — the exact code the frame runs.
 *
 * Protocol (see find-session.ts for the shell side):
 * - command { seq, action: "search", term } → wrap every case-insensitive
 *   occurrence in <mark> elements (capped; script/style/textarea/marked
 *   subtrees are skipped, the controller's own script included) and report
 *   the count. Frames never self-activate on search.
 * - command { seq, action: "activate", index } → style the index-th mark
 *   as active and scroll it into view (-1 clears the active styling).
 * - command { seq, action: "clear" } → unwrap every mark, restoring the
 *   exact original text nodes (normalized).
 * - Ctrl/Cmd+F and Escape inside the frame are forwarded to the shell —
 *   keydowns in a cross-origin frame never reach the shell's listener.
 */
export function emailFindController(params: {
  commandType: string
  stateType: string
  openType: string
  escapeType: string
  markAttr: string
  activeAttr: string
  maxMatches: number
}): void {
  let seqSeen = -1
  let activeIndex = -1
  let marks: HTMLElement[] = []

  window.addEventListener("message", function (event) {
    // Only the shell may command this frame — the direct parent's identity
    // mirrors the shell-side `event.source === contentWindow` discipline
    // against a hostile window spoofing the payload.
    if (event.source !== window.parent) return
    const data = event.data
    if (typeof data !== "object" || data === null) return
    if (data.type !== params.commandType) return
    if (typeof data.seq !== "number" || !isFinite(data.seq)) return
    if (data.seq < seqSeen) return // stale search round
    seqSeen = data.seq
    if (data.action === "search") {
      clearMarks()
      const term = typeof data.term === "string" ? data.term : ""
      const count = term === "" ? 0 : highlight(term)
      setActive(-1)
      report(count, -1)
    } else if (data.action === "activate") {
      setActive(typeof data.index === "number" ? data.index : -1)
      report(marks.length, activeIndex)
    } else if (data.action === "clear") {
      clearMarks()
      setActive(-1)
      report(0, -1)
    }
  })

  window.addEventListener("keydown", function (event) {
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      typeof event.key === "string" &&
      event.key.toLowerCase() === "f"
    ) {
      event.preventDefault()
      post({ type: params.openType })
      return
    }
    // Forwarded unconditionally: cross-origin frames don't propagate
    // keydowns, so a conditioned forward would swallow Escape while the
    // bar shows "0 matches" (the shell's Esc path is idempotent).
    if (event.key === "Escape") {
      post({ type: params.escapeType })
    }
  })

  function post(message: unknown): void {
    if (window.parent !== window) {
      window.parent.postMessage(message, "*")
    }
  }

  function report(count: number, active: number): void {
    post({ type: params.stateType, seq: seqSeen, count: count, active: active })
  }

  /** Wrap every occurrence in document order. Text nodes are collected
   * first — wrapping replaces nodes, which would confuse a live walker. */
  function highlight(term: string): number {
    const lowerTerm = term.toLowerCase()
    if (lowerTerm === "" || !document.body) return 0
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node: Node) {
          const value = node.nodeValue
          if (!value || value.toLowerCase().indexOf(lowerTerm) === -1) {
            return NodeFilter.FILTER_REJECT
          }
          let parent = node.parentNode
          while (parent && parent !== document.body) {
            const name = parent.nodeName
            if (
              name === "SCRIPT" ||
              name === "STYLE" ||
              name === "NOSCRIPT" ||
              name === "TEXTAREA" ||
              name === "MARK"
            ) {
              return NodeFilter.FILTER_REJECT
            }
            parent = parent.parentNode
          }
          return NodeFilter.FILTER_ACCEPT
        },
      }
    )
    const nodes: Text[] = []
    while (walker.nextNode()) {
      nodes.push(walker.currentNode as Text)
      if (nodes.length >= params.maxMatches) break
    }
    for (let i = 0; i < nodes.length; i++) {
      if (marks.length >= params.maxMatches) break
      highlightTextNode(nodes[i], lowerTerm)
    }
    return marks.length
  }

  function highlightTextNode(node: Text, lowerTerm: string): void {
    const text = node.nodeValue ?? ""
    const lower = text.toLowerCase()
    const fragment = document.createDocumentFragment()
    let pos = 0
    let index = lower.indexOf(lowerTerm)
    while (index !== -1 && marks.length < params.maxMatches) {
      if (index > pos) {
        fragment.appendChild(document.createTextNode(text.slice(pos, index)))
      }
      const mark = document.createElement("mark")
      mark.setAttribute(params.markAttr, "")
      mark.appendChild(
        document.createTextNode(text.slice(index, index + lowerTerm.length))
      )
      fragment.appendChild(mark)
      marks.push(mark)
      pos = index + lowerTerm.length
      index = lower.indexOf(lowerTerm, pos)
    }
    if (pos === 0) return
    if (pos < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(pos)))
    }
    if (node.parentNode) {
      node.parentNode.replaceChild(fragment, node)
    }
  }

  /** Unwrap every mark: the text nodes go back verbatim, then normalize()
   * merges the neighbors back into the original nodes. */
  function clearMarks(): void {
    for (let i = marks.length - 1; i >= 0; i--) {
      const mark = marks[i]
      const parent = mark.parentNode
      if (!parent) continue
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark)
      }
      parent.removeChild(mark)
      parent.normalize()
    }
    marks = []
  }

  function setActive(index: number): void {
    if (activeIndex >= 0 && activeIndex < marks.length) {
      const previous = marks[activeIndex]
      if (previous) previous.removeAttribute(params.activeAttr)
    }
    activeIndex = -1
    if (index < 0 || index >= marks.length) return
    const mark = marks[index]
    if (!mark) return
    mark.setAttribute(params.activeAttr, "")
    activeIndex = index
    if (typeof mark.scrollIntoView === "function") {
      mark.scrollIntoView({ block: "center" })
    }
  }
}

/** Parameters passed to the controller serialized into the frame document. */
export function findControllerParams(): Record<string, string | number> {
  return {
    commandType: EMAILER_FIND_COMMAND_TYPE,
    stateType: EMAILER_FIND_STATE_TYPE,
    openType: EMAILER_FIND_OPEN_TYPE,
    escapeType: EMAILER_FIND_ESCAPE_TYPE,
    markAttr: EMAILER_FIND_MARK_ATTR,
    activeAttr: EMAILER_FIND_ACTIVE_ATTR,
    maxMatches: MAX_FIND_MATCHES,
  }
}
