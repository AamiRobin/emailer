import { installGmailFetchStub } from "./gmail-fetch"

/**
 * Mock harness bootstrap (mock dev mode only): every mock module calls
 * installMockHarness() on use. Idempotent — installs the Gmail REST
 * fetch stub and injects the "mock data" pill into the page once.
 */

let installed = false

export function installMockHarness(): void {
  if (installed) return
  installed = true
  installGmailFetchStub()
  injectMockPill()
  console.info(
    "[mock] mock harness active — database is in-memory fixture data"
  )
}

/**
 * Fixed amber pill, top-right: visible in both themes (amber-500 text on
 * translucent amber reads on light and dark), pointer-events-none so it
 * never intercepts clicks, maximal z-index to sit above any overlay.
 */
function injectMockPill(): void {
  const mount = (): void => {
    if (document.getElementById("mock-data-pill") !== null) return
    const pill = document.createElement("div")
    pill.id = "mock-data-pill"
    pill.setAttribute("aria-hidden", "true")
    pill.textContent = "MOCK DATA — not connected"
    pill.style.cssText = [
      "position: fixed",
      "top: 10px",
      "right: 12px",
      "z-index: 2147483647",
      "pointer-events: none",
      "padding: 3px 12px",
      "border-radius: 9999px",
      "font-family: ui-sans-serif, system-ui, sans-serif",
      "font-size: 11px",
      "font-weight: 500",
      "letter-spacing: 0.03em",
      "color: #f59e0b",
      "background: rgba(245, 158, 11, 0.1)",
      "border: 1px solid rgba(245, 158, 11, 0.28)",
    ].join(";")
    document.body.appendChild(pill)
  }
  if (document.body !== null) {
    mount()
  } else {
    document.addEventListener("DOMContentLoaded", mount, { once: true })
  }
}
