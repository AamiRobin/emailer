import { addDays, format, startOfDay } from "date-fns"

/**
 * Dynamic date tokens for stored queries (task 3.8, design D13): split
 * queries (and anything else that runs through the query-time pipeline)
 * MAY embed `__TODAY__` with day-offset arithmetic, resolved at QUERY
 * time — never at save time, and with NO stored state (D13) — so a saved
 * tab keeps itself current without editing.
 *
 * Grammar (case-insensitive; the token may sit inside an operator value,
 * e.g. `after:__TODAY-7D__`):
 * - `__TODAY__`      → today's local calendar date
 * - `__TODAY-7D__`   → today minus 7 days
 * - `__TODAY+1D__`   → today plus 1 day (offset sign optional in shape,
 *   non-negative integer days; the `D` suffix is part of the form)
 *
 * The replacement is the plain `yyyy-MM-dd` spelling of that date —
 * exactly what the parser's `before:`/`after:` values accept (see
 * parseUtcDate in parser.ts) — so a resolved token behaves identically
 * to the user typing the date by hand, including the UTC-midnight
 * boundary. "Today" is the LOCAL calendar day (startOfDay), matching the
 * app's other date grouping (dateGroupLabel et al.).
 *
 * Malformed variants (`__TODAY-__`, `__TODAY-7__`, `__TODAYXYZ__`) do not
 * match the pattern and pass through UNCHANGED — the query then treats
 * them as the free text they spell, the same degradation as any other
 * unrecognized operator value. An unmatched token is not resolved
 * silently: what the user stored is what the pipeline sees.
 *
 * Pure string → string (no I/O); `now` is injectable so tests pin the
 * clock (default: the real clock).
 */

/**
 * One date token. The offset part `([+-])(\d+)D` is optional (bare
 * `__TODAY__`); the `i` flag makes the whole form case-insensitive.
 */
const DATE_TOKEN_PATTERN = /__TODAY(?:([+-])(\d+)D)?__/gi

/** Resolve every date token in `query` to its concrete `yyyy-MM-dd` date
 * against `now` (default: the real clock). Every occurrence is replaced;
 * the day offset of each token is computed from the same `now`. */
export function resolveDateTokens(
  query: string,
  now: Date = new Date()
): string {
  const today = startOfDay(now)
  return query.replace(
    DATE_TOKEN_PATTERN,
    (_match, sign?: string, days?: string) => {
      const offset = days !== undefined ? Number(days) : 0
      const date =
        sign === "-" ? addDays(today, -offset) : addDays(today, offset)
      return format(date, "yyyy-MM-dd")
    }
  )
}
