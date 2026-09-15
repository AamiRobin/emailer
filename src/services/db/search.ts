/**
 * Backwards-compatible entry point for thread search. The implementation
 * moved to src/services/search (operator-aware parser + SQL builder,
 * OpenSpec task 9.1); this re-export keeps the task 2.2 import path
 * (`services/db/search`) working. The delegate adds trash/spam exclusion —
 * search now covers the mailbox like Gmail, per the 9.1 spec — and parses
 * operators instead of treating the whole input as free text.
 */
export {
  searchThreadsQuery as searchThreads,
  type SearchThreadsOptions,
} from "../search"
