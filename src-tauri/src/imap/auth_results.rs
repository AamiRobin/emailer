//! `Authentication-Results` parsing (task 2.1, design D10).
//!
//! Incoming mail may carry one or more `Authentication-Results` headers
//! (RFC 8601, formerly RFC 7601) in which the receiving server reports its
//! SPF, DKIM and DMARC evaluations, e.g.:
//!
//! ```text
//! Authentication-Results: mx.example.com;
//!     spf=pass smtp.mailfrom=sender.example.org;
//!     dkim=pass header.d=example.org;
//!     dmarc=pass header.from=example.org
//! ```
//!
//! The mail-security spec ("Email authentication display") wants a compact
//! per-message badge from those evaluations. Parsing is strictly local and
//! never influences delivery or sync — the verdict only feeds UI.
//!
//! Storage format (`messages.auth_results`, task 2.1): ONE compact string
//! consolidating every `Authentication-Results` header of the message:
//!
//! ```text
//! spf=pass;dkim=fail;dmarc=none
//! ```
//!
//! - only the three mechanisms, lowercase, in the fixed order
//!   spf → dkim → dmarc, separated by `;` with no spaces;
//! - a mechanism that no header evaluated is OMITTED entirely (so
//!   `dkim=pass` alone stores just `dkim=pass`);
//! - a message without any `Authentication-Results` header (or with only
//!   unparseable ones) stores NULL — the spec's "no headers → no badge".
//!
//! Consolidation rule across multiple headers — WORST OBSERVED VALUE WINS
//! per mechanism, severity-ranked fail > softfail/quasi (softfail, neutral,
//! temperror, permerror, policy) > pass > none (ties keep the first
//! observation). Rationale: a later hop overriding an earlier pass with a
//! fail must not be lost, and dropping the worst value would weaken the
//! exact signal the phishing badge (dmarc fail) keys on.

/// The three mechanisms this surface tracks, in storage order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mechanism {
    Spf,
    Dkim,
    Dmarc,
}

impl Mechanism {
    /// Header token for the mechanism (lowercase, RFC 8601 `method=result`).
    fn from_token(token: &str) -> Option<Self> {
        // Header tokens are case-insensitive (RFC 8601 §2.7.2) — servers
        // have shipped every casing imaginable ("SPF=Pass").
        match token.to_ascii_lowercase().as_str() {
            "spf" => Some(Mechanism::Spf),
            "dkim" => Some(Mechanism::Dkim),
            "dmarc" => Some(Mechanism::Dmarc),
            _ => None,
        }
    }

    /// Position in the fixed storage order spf → dkim → dmarc.
    fn slot(self) -> usize {
        match self {
            Mechanism::Spf => 0,
            Mechanism::Dkim => 1,
            Mechanism::Dmarc => 2,
        }
    }
}

/// One evaluated mechanism outcome: the canonical token to store plus its
/// consolidation severity (higher = worse).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Evaluation {
    pub mechanism: Mechanism,
    pub token: &'static str,
    pub severity: u8,
}

/// RFC 8601 result tokens → (stored token, severity). Verdicts are folded
/// into the compact vocabulary the badge understands: `pass`, `fail`, and
/// the quasi-fail/quasi-ok middle band (softfail/neutral/temperror/
/// permerror/policy — stored verbatim so the UI can shade a warning
/// without re-parsing comments). Unknown/extension tokens carry no
/// trustworthy verdict and are treated like `none` rather than fabricating
/// a state (spec: "no evaluation" must not render as a failure).
fn classify(result: &str) -> Option<(&'static str, u8)> {
    match result.to_ascii_lowercase().as_str() {
        "pass" => Some(("pass", 1)),
        "fail" => Some(("fail", 3)),
        "softfail" => Some(("softfail", 2)),
        "neutral" => Some(("neutral", 2)),
        "temperror" => Some(("temperror", 2)),
        "permerror" => Some(("permerror", 2)),
        // Legacy DKIM "policy" result (RFC 6008-era); quasi like the others.
        "policy" => Some(("policy", 2)),
        "none" => Some(("none", 0)),
        _ => Some(("none", 0)),
    }
}

/// Parse ONE header value into its `(mechanism, outcome)` evaluations.
///
/// Tolerant by design: `method=result` tokens are recognized wherever they
/// appear between the `;`-separated properties, ignoring the authserv-id
/// prefix, the per-method `smtp.mailfrom=` / `header.d=` / `header.from=`
/// properties, comments ("(2048-bit key)") and any folding whitespace —
/// real-world headers from Gmail/Fastmail/etc. vary in all of these. A
/// value like `spf=fail (reason) smtp.mailfrom=x` must still yield
/// `spf=fail`. Splitting on every whitespace run AND `;` handles all of
/// that at once, since none of the ignored properties is named
/// spf/dkim/dmarc.
pub(crate) fn parse_header_value(value: &str) -> Vec<Evaluation> {
    let mut evaluations = Vec::new();
    for token in value.split(|c: char| c == ';' || c.is_ascii_whitespace()) {
        let Some((method, result)) = token.split_once('=') else {
            continue;
        };
        let Some(mechanism) = Mechanism::from_token(method) else {
            continue;
        };
        if let Some((stored, severity)) = classify(result) {
            evaluations.push(Evaluation {
                mechanism,
                token: stored,
                severity,
            })
        }
    }
    evaluations
}

/// Consolidate all `(header name, header value)` pairs of a message into
/// the compact `spf=pass;dkim=fail;dmarc=none` string (see the module doc
/// for the format and the worst-wins rule). `None` when no header evaluated
/// any of the three mechanisms.
pub(crate) fn parse_auth_results<'a, I>(headers: I) -> Option<String>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    // Per-mechanism worst-so-far, indexed by Mechanism::slot — the array
    // holds (stored token, severity) so the joined string can use the
    // canonical token of the worst observation.
    let mut worst: [Option<(&'static str, u8)>; 3] = [None, None, None];
    let mut saw_auth_header = false;

    for (name, value) in headers {
        // Header names are case-insensitive (RFC 5322 §2.2); mail-parser
        // preserves the sender's original casing for non-wellknown names.
        if !name.eq_ignore_ascii_case("Authentication-Results") {
            continue;
        }
        saw_auth_header = true;
        for evaluation in parse_header_value(value) {
            let slot = &mut worst[evaluation.mechanism.slot()];
            // Strictly-worse replaces; ties keep the first observation, so
            // the result is deterministic for a given header order.
            match *slot {
                Some((_, severity)) if severity >= evaluation.severity => {}
                _ => *slot = Some((evaluation.token, evaluation.severity)),
            }
        }
    }

    if !saw_auth_header {
        return None;
    }
    let parts: Vec<String> = worst
        .into_iter()
        .zip([Mechanism::Spf, Mechanism::Dkim, Mechanism::Dmarc])
        .filter_map(|(slot, mechanism)| {
            slot.map(|(token, _)| format!("{}={}", mechanism_key(mechanism), token))
        })
        .collect();
    if parts.is_empty() {
        return None;
    }
    Some(parts.join(";"))
}

/// Lowercase storage key for a mechanism (`spf`, `dkim`, `dmarc`).
fn mechanism_key(mechanism: Mechanism) -> &'static str {
    match mechanism {
        Mechanism::Spf => "spf",
        Mechanism::Dkim => "dkim",
        Mechanism::Dmarc => "dmarc",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: run the consolidator over (name, value) pairs.
    fn consolidate(pairs: &[(&str, &str)]) -> Option<String> {
        parse_auth_results(pairs.iter().copied())
    }

    #[test]
    fn single_header_all_pass() {
        let result = consolidate(&[(
            "Authentication-Results",
            "mx.example.com; spf=pass smtp.mailfrom=a@b.org; dkim=pass header.d=b.org; dmarc=pass header.from=b.org",
        )]);
        assert_eq!(result.as_deref(), Some("spf=pass;dkim=pass;dmarc=pass"));
    }

    #[test]
    fn multiple_conflicting_headers_worst_wins() {
        // A forwarding hop's later header downgrades SPF to fail while DKIM
        // stays pass; the fail must survive consolidation.
        let result = consolidate(&[
            (
                "Authentication-Results",
                "mx1.example.com; spf=pass; dkim=pass; dmarc=pass",
            ),
            (
                "Authentication-Results",
                "mx2.example.com; spf=fail; dkim=pass; dmarc=fail",
            ),
        ]);
        assert_eq!(result.as_deref(), Some("spf=fail;dkim=pass;dmarc=fail"));
    }

    #[test]
    fn later_pass_never_upgrades_earlier_fail() {
        let result = consolidate(&[
            ("Authentication-Results", "mx1; spf=fail"),
            ("Authentication-Results", "mx2; spf=pass"),
        ]);
        assert_eq!(result.as_deref(), Some("spf=fail"));
    }

    #[test]
    fn quasi_results_rank_below_fail_above_pass() {
        // softfail/temperror on separate headers consolidate to the worst
        // quasi value seen first (ties keep the first observation).
        let result = consolidate(&[
            ("Authentication-Results", "mx1; spf=softfail"),
            ("Authentication-Results", "mx2; spf=temperror"),
        ]);
        assert_eq!(result.as_deref(), Some("spf=softfail"));
        // ... and a quasi verdict still beats a pass from an earlier hop.
        let result = consolidate(&[
            ("Authentication-Results", "mx1; spf=pass"),
            ("Authentication-Results", "mx2; spf=neutral"),
        ]);
        assert_eq!(result.as_deref(), Some("spf=neutral"));
        // ... but never overrides a real fail.
        let result = consolidate(&[
            ("Authentication-Results", "mx1; spf=fail"),
            ("Authentication-Results", "mx2; spf=permerror"),
        ]);
        assert_eq!(result.as_deref(), Some("spf=fail"));
    }

    #[test]
    fn dkim_only_header_omits_other_mechanisms() {
        let result = consolidate(&[(
            "Authentication-Results",
            "mx.example.com; dkim=fail header.d=spoofed.example (bad signature)",
        )]);
        assert_eq!(result.as_deref(), Some("dkim=fail"));
    }

    #[test]
    fn absent_header_is_none() {
        assert_eq!(consolidate(&[("From", "a@b.example")]), None);
        assert_eq!(consolidate(&[]), None);
    }

    #[test]
    fn header_without_evaluations_is_none() {
        // Present but useless: only the authserv-id, no method results.
        let result = consolidate(&[("Authentication-Results", "mx.example.com")]);
        assert_eq!(result, None);
    }

    #[test]
    fn weird_casing_and_whitespace_parse() {
        // RFC 8601 writes `method=result` without inner spaces, but servers
        // ship every casing and folding layout imaginable.
        let result = consolidate(&[(
            "authentication-results",
            "  mx.example.com ;\r\n\t SPF=Pass \r\n smtp.mailfrom=a@b ;\r\n  DKIM=SOFTFAIL ;Dmarc=Fail  ",
        )]);
        assert_eq!(result.as_deref(), Some("spf=pass;dkim=softfail;dmarc=fail"));
    }

    #[test]
    fn folded_header_and_comments_parse() {
        // Folding whitespace and DKIM key comments must not break the
        // method token out (real Gmail headers look like this).
        let result = consolidate(&[(
            "Authentication-Results",
            "mx.google.com;\r\n dkim=pass (2048-bit key) header.i=@example.org header.s=2024;\r\n spf=pass (domain owner) smtp.mailfrom=example.org",
        )]);
        assert_eq!(result.as_deref(), Some("spf=pass;dkim=pass"));
    }

    #[test]
    fn unknown_result_tokens_treat_as_none() {
        // An extension token must not fabricate pass/fail — it stores none.
        let result = consolidate(&[("Authentication-Results", "mx; spf=fancyerror")]);
        assert_eq!(result.as_deref(), Some("spf=none"));
        // ... and none never beats a real evaluation from another header.
        let result = consolidate(&[
            ("Authentication-Results", "mx1; spf=pass"),
            ("Authentication-Results", "mx2; spf=fancyerror"),
        ]);
        assert_eq!(result.as_deref(), Some("spf=pass"));
    }

    #[test]
    fn non_auth_headers_are_ignored() {
        let result = consolidate(&[
            ("Received", "spf=fail; dkim=fail; dmarc=fail"),
            ("Authentication-Results", "mx; spf=pass"),
        ]);
        assert_eq!(result.as_deref(), Some("spf=pass"));
    }

    #[test]
    fn parse_header_value_isolates_mechanisms() {
        let evaluations = parse_header_value(
            "mx; spf=fail smtp.mailfrom=x; dkim=none; dmarc=temperror; dmarc=permerror",
        );
        assert_eq!(evaluations.len(), 4);
        assert_eq!(evaluations[0].mechanism, Mechanism::Spf);
        assert_eq!(evaluations[0].token, "fail");
        assert_eq!(evaluations[1].mechanism, Mechanism::Dkim);
        assert_eq!(evaluations[1].token, "none");
        assert_eq!(evaluations[2].token, "temperror");
        assert_eq!(evaluations[3].token, "permerror");
    }
}
