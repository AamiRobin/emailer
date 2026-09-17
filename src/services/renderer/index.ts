/**
 * Safe email body rendering pipeline (task 7.2, design D7):
 *
 *   raw HTML        → sanitizeEmailHtml()  (DOMPurify allowlist, remote-image
 *                                            blocking, target=_blank links)
 *   plain text      → renderPlainTextAsHtml() → (optionally sanitizeEmailHtml)
 *   sanitized HTML  → SafeEmailFrame       (sandboxed iframe, postMessage
 *                                            auto-resize)
 *
 * Feature code should import from "services/renderer" rather than reaching
 * into the individual modules. Task 7.3 layers the remote-image policy
 * (per-message "show images", per-sender allowlist) on top of
 * sanitizeEmailHtml's `blockRemoteImages` flag; task 7.4 wires link clicks
 * to the OS browser via the opener plugin; task 7.7 resolves cid: images;
 * task 18.1 (design D12) adds the phishing detectors run beside the
 * sanitize walk.
 */
export * from "./plain-text"
export * from "./phishing"
export * from "./sanitize"
