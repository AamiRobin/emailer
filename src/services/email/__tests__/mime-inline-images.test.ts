import { describe, expect, it, vi } from "vitest"

import {
  buildMimeMessage,
  buildMimeMessagePgp,
  decomposeMimeMessage,
  extractInlineImages,
  hasInlineImages,
  type BuiltMime,
} from "../mime-builder"
import type { SendEmailInput } from "../types"

// The PGP transforms are mocked (same discipline as mime-builder.test.ts —
// openpgp cannot initialize under jsdom): the PGP+inline test pins that
// the related structure is INSIDE what the transform wraps.
vi.mock("../../crypto/pgp-transform", () => ({
  signMime: vi.fn(async ({ built }: { built: BuiltMime }) => ({
    mime: `SIGNED:${built.mime}`,
    messageId: built.messageId,
  })),
  encryptMime: vi.fn(async ({ built }: { built: BuiltMime }) => ({
    mime: `ENCRYPTED:${built.mime}`,
    messageId: built.messageId,
  })),
  signAndEncryptMime: vi.fn(async ({ built }: { built: BuiltMime }) => ({
    mime: `SIGN+ENCRYPTED:${built.mime}`,
    messageId: built.messageId,
  })),
}))

/** A tiny valid-shape base64 payload (content is never decoded as an
 * image here — only the MIME shape matters). */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUg=="
const JPEG_BASE64 = "/9j/4AAQSkZJRg=="
const GIF_BASE64 = "R0lGODdhAQABAPAAAP///w=="

function baseInput(overrides: Partial<SendEmailInput> = {}): SendEmailInput {
  return {
    from: { name: "Me User", email: "me@gmail.com" },
    to: [{ name: "Ada", email: "ada@example.com" }],
    subject: "Hello",
    textBody: "plain text",
    ...overrides,
  }
}

/** The raw (still-encoded) base64 body of the first part carrying the
 * given Content-Type, with its line wraps removed. Header-agnostic: the
 * body is whatever follows the part's blank line. */
function partBase64(mime: string, contentType: string): string | null {
  const at = mime.indexOf(`Content-Type: ${contentType}`)
  if (at === -1) return null
  const headerEnd = mime.indexOf("\r\n\r\n", at)
  if (headerEnd === -1) return null
  const match = mime.slice(headerEnd + 4).match(/^([\s\S]*?)\r\n--/)
  return match ? match[1].replace(/\r\n/g, "") : null
}

/** Decode a part body (base64 + UTF-8, the only shape the builder emits). */
function decodedPart(mime: string, contentType: string): string | null {
  const base64 = partBase64(mime, contentType)
  if (base64 === null) return null
  return new TextDecoder().decode(
    Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  )
}

describe("extractInlineImages", () => {
  it("rewrites data: srcs to cid: refs and reports one part per image", () => {
    const html =
      "<p>before</p>" +
      `<img src="data:image/png;base64,${PNG_BASE64}">` +
      `<img src="data:image/jpeg;base64,${JPEG_BASE64}">` +
      "<p>after</p>"
    const { html: rewritten, images } = extractInlineImages(html)
    expect(images).toHaveLength(2)
    expect(images[0].mimeType).toBe("image/png")
    expect(images[0].contentBase64).toBe(PNG_BASE64)
    expect(images[0].contentIdHeader).toMatch(/^<img-.+@emailer>$/)
    expect(images[0].contentId).not.toContain("<")
    expect(images[1].mimeType).toBe("image/jpeg")
    // Every src rewritten, nothing else touched.
    expect(rewritten).toContain(`<img src="cid:${images[0].contentId}">`)
    expect(rewritten).toContain(`<img src="cid:${images[1].contentId}">`)
    expect(rewritten).toContain("<p>before</p>")
    expect(rewritten).toContain("<p>after</p>")
    expect(rewritten).not.toContain("data:image")
    // Distinct ids per image.
    expect(images[0].contentId).not.toBe(images[1].contentId)
  })

  it("passes HTML without data: images through byte-identical", () => {
    const html = '<p>plain</p><img src="https://example.com/x.png">'
    const { html: rewritten, images } = extractInlineImages(html)
    expect(images).toEqual([])
    expect(rewritten).toBe(html)
  })

  it("hasInlineImages detects the composer's data: srcs only", () => {
    expect(hasInlineImages('<img src="data:image/png;base64,AAA">')).toBe(true)
    expect(hasInlineImages('<img src="https://example.com/x.png">')).toBe(false)
    expect(hasInlineImages(undefined)).toBe(false)
  })
})

describe("buildMimeMessage — inline images", () => {
  it("emits no related structure when the body has no data: images", () => {
    const built = buildMimeMessage(baseInput({ htmlBody: "<p>plain</p>" }))
    expect(built.mime).toContain("Content-Type: multipart/alternative")
    expect(built.mime).not.toContain("multipart/related")
    expect(built.mime).not.toContain("Content-ID")
  })

  it("wraps the alternative block in multipart/related with one part per image", () => {
    const built = buildMimeMessage(
      baseInput({
        htmlBody: `<p>see below</p><img src="data:image/png;base64,${PNG_BASE64}">`,
      })
    )
    // Top level is related now.
    expect(built.mime).toMatch(
      /Content-Type: multipart\/related; boundary="[^"]+"\r\n/
    )
    // The alternative block nests inside, and its HTML (decoded from the
    // base64 text/html part) references the cid.
    expect(built.mime).toContain("Content-Type: multipart/alternative")
    const html = decodedPart(built.mime, "text/html") ?? ""
    const cid = html.match(/src="cid:(img-[^"]+)"/)?.[1]
    expect(cid).toBeTruthy()
    expect(built.mime).toContain(`Content-ID: <${cid}>`)
    expect(built.mime).toContain("Content-Type: image/png")
    expect(built.mime).toContain("Content-Disposition: inline")
    expect(built.mime).toMatch(/Content-Disposition: inline; filename="image-1\.png"/)
    // The image part body carries the exact original base64.
    expect(partBase64(built.mime, "image/png")).toBe(PNG_BASE64)
  })

  it("keeps attachments in multipart/mixed and only adds related when images exist", () => {
    const noImages = buildMimeMessage(
      baseInput({
        htmlBody: "<p>plain</p>",
        attachments: [
          {
            filename: "a.pdf",
            mimeType: "application/pdf",
            contentBase64: "AAAA",
          },
        ],
      })
    )
    expect(noImages.mime).toContain("multipart/mixed")
    expect(noImages.mime).not.toContain("multipart/related")

    const withImages = buildMimeMessage(
      baseInput({
        htmlBody: `<p>pic</p><img src="data:image/gif;base64,${GIF_BASE64}">`,
        attachments: [
          {
            filename: "a.pdf",
            mimeType: "application/pdf",
            contentBase64: "AAAA",
          },
        ],
      })
    )
    // mixed{related{alternative, image}, attachment} — the standard shape.
    expect(withImages.mime).toContain("multipart/mixed")
    expect(withImages.mime).toContain("multipart/related")
    expect(withImages.mime).toContain(
      'Content-Disposition: attachment; filename="a.pdf"'
    )
    expect(withImages.mime).toMatch(
      /Content-Disposition: inline; filename="image-1\.gif"/
    )
    expect(partBase64(withImages.mime, "image/gif")).toBe(GIF_BASE64)
  })

  it("the plain-text part is unaffected by the cid rewrite", () => {
    const built = buildMimeMessage(
      baseInput({
        textBody: "see attachment",
        htmlBody: `<p>pic</p><img src="data:image/png;base64,${PNG_BASE64}">`,
      })
    )
    expect(decodedPart(built.mime, "text/plain")).toBe("see attachment")
  })
})

describe("buildMimeMessagePgp — inline images", () => {
  it("builds the related structure before the transform wraps it", async () => {
    const { signMime } = await import("../../crypto/pgp-transform")
    const built = await buildMimeMessagePgp(
      baseInput({
        htmlBody: `<p>enc</p><img src="data:image/png;base64,${PNG_BASE64}">`,
      }),
      { mode: "sign", signingKey: {} as never }
    )
    expect(built.mime.startsWith("SIGNED:")).toBe(true)
    const inner = built.mime.slice("SIGNED:".length)
    expect(inner).toContain("multipart/related")
    expect(decodedPart(inner, "text/html") ?? "").toMatch(
      /src="cid:img-[^"]+"/
    )
    expect(signMime).toHaveBeenCalledTimes(1)
  })
})

describe("decomposeMimeMessage — inline image round trip", () => {
  it("maps cid: refs back to data: URLs and does not count them as attachments", () => {
    const built = buildMimeMessage(
      baseInput({
        htmlBody: `<p>pic</p><img src="data:image/png;base64,${PNG_BASE64}">`,
        attachments: [
          {
            filename: "a.pdf",
            mimeType: "application/pdf",
            contentBase64: "AAAA",
          },
        ],
      })
    )
    const decomposed = decomposeMimeMessage(built.mime)
    expect(decomposed.attachments.map((a) => a.filename)).toEqual(["a.pdf"])
    expect(decomposed.htmlBody).toContain(
      `src="data:image/png;base64,${PNG_BASE64}"`
    )
    expect(decomposed.htmlBody).not.toContain("cid:")
  })
})
