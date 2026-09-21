/**
 * Profile color marker (parity-round-2 task 4.5, mailbox-ui spec "Profile
 * color markers"): a thin bar at the thread row's leading edge carrying
 * the sending account's effective color — profile color, per-account
 * override, or the individual/generated color. Rendered ONLY in the
 * cross-account scopes (the same scopeSpansAccounts predicate that gates
 * the account badge); single-account views stay clean.
 *
 * The marker is PURELY VISUAL: it is aria-hidden, unlabeled, unfocusable
 * and carries no text, so selection, keyboard navigation and screen-reader
 * labels are untouched (the account's name, when announced at all, still
 * comes from the account badge). Like the reference implementation's row
 * bar it is inset a few pixels from the card edge and trimmed vertically,
 * so it never collides with the card border or a bundle member's left
 * accent — and being absolutely positioned it cannot reflow the row.
 *
 * Lives beside account-badge/account-hue so the row's account-identity
 * treatments stay together; the color comes from the account store's
 * effectiveColors map (task 4.4), the data-derived-color exception
 * applying the same way as the badge and the label chips.
 */

export function ProfileColorMarker({ color }: { color: string }) {
  return (
    <span
      data-profile-marker
      aria-hidden
      className="absolute inset-y-2 left-1 w-[3px] rounded-full"
      // Data-derived color exception (mirrors the account badge and the
      // label chips): the color is user content from the DB rendered
      // as-is — not component styling, so the token rule does not apply.
      style={{ backgroundColor: color }}
    />
  )
}
