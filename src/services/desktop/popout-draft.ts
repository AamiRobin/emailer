/**
 * Pop-out draft guard decision (task 1.9, spec "Pop-out thread windows"):
 * a close with a draft in progress must prompt. Kept out of the
 * component file so both PopoutApp and the tests share the exact rule.
 *
 * The check is recipient/subject based on the composer's raw input: a
 * signature-only body is not a draft, and a closed composer is never
 * dirty.
 */
export function popoutDraftIsDirty(state: {
  open: boolean
  to: { email: string }[]
  cc: { email: string }[]
  bcc: { email: string }[]
  subject: string
}): boolean {
  if (!state.open) return false
  return (
    state.to.length > 0 ||
    state.cc.length > 0 ||
    state.bcc.length > 0 ||
    state.subject.trim() !== ""
  )
}
