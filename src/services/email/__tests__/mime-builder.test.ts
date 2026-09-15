import { describe, expect, it } from "vitest"

import {
  buildMimeMessage,
  encodeHeaderValue,
  formatAddress,
  htmlToText,
  isAscii,
  stringToBase64Url,
} from "../mime-builder"
import type { SendEmailInput } from "../types"

function baseInput(overrides: Partial<SendEmailInput> = {}): SendEmailInput {
  return {
    from: { name: "Me User", email: "me@gmail.com" },
    to: [{ name: "Ada", email: "ada@example.com" }],
    subject: "Hello",
    textBody: "plain text",
    ...overrides,
  }
}

/** Decode every base64-encoded part body back to text for assertions. */
function decodedBodies(mime: string): string[] {
  const bodies: string[] = []
  const pattern = /Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g
  for (const [, base64] of mime.matchAll(pattern)) {
    bodies.push(atob(base64.replace(/\r\n/g, "")))
  }
  return bodies
}

/** atob returns a latin1 string — decode UTF-8 bytes properly. */
function decodeBase64Utf8(base64: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  )
}

describe("buildMimeMessage", () => {
  it("emits the RFC 5322 headers with CRLF endings", () => {
    const built = buildMimeMessage(
      baseInput({
        cc: [{ email: "cc@example.com" }],
        bcc: [{ name: "Secret", email: "bcc@example.com" }],
        subject: "Hi there",
        inReplyTo: "<msg-0@example.com>",
        references: "<msg-0@example.com> <msg-1@example.com>",
        messageId: "<my-id@gmail.com>",
        htmlBody: "<p>html</p>",
      })
    )

    expect(built.mime).toContain("\r\n")
    expect(built.mime).toMatch(/^From: Me User <me@gmail\.com>\r\n/)
    expect(built.mime).toContain("To: Ada <ada@example.com>\r\n")
    expect(built.mime).toContain("Cc: cc@example.com\r\n")
    expect(built.mime).toContain("Bcc: Secret <bcc@example.com>\r\n")
    expect(built.mime).toContain("Subject: Hi there\r\n")
    expect(built.mime).toContain("In-Reply-To: <msg-0@example.com>\r\n")
    expect(built.mime).toContain(
      "References: <msg-0@example.com> <msg-1@example.com>\r\n"
    )
    expect(built.mime).toContain("Message-ID: <my-id@gmail.com>\r\n")
    expect(built.mime).toMatch(
      /Date: [A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} \+0000\r\n/
    )
    expect(built.mime).toContain("MIME-Version: 1.0\r\n")
    expect(built.messageId).toBe("<my-id@gmail.com>")
  })

  it("builds a multipart/alternative structure with both bodies", () => {
    const built = buildMimeMessage(
      baseInput({ htmlBody: "<p>Hello <b>world</b></p>" })
    )

    const boundary =
      /Content-Type: multipart\/alternative; boundary="([^"]+)"/.exec(
        built.mime
      )?.[1]
    expect(boundary).toBeTruthy()
    expect(built.mime).toContain(`--${boundary}\r\n`)
    expect(built.mime).toContain(`--${boundary}--\r\n`)
    expect(built.mime).toContain("Content-Type: text/plain; charset=UTF-8")
    expect(built.mime).toContain("Content-Type: text/html; charset=UTF-8")
    expect(built.mime).toContain("Content-Transfer-Encoding: base64")

    const bodies = decodedBodies(built.mime)
    expect(bodies).toContain("plain text")
    expect(bodies).toContain("<p>Hello <b>world</b></p>")
  })

  it("generates a plain-text part from html when textBody is absent", () => {
    const built = buildMimeMessage(
      baseInput({
        textBody: undefined,
        htmlBody: "<p>One</p><p>Two &amp; three</p>",
      })
    )
    const bodies = decodedBodies(built.mime)
    expect(bodies).toContain("One\nTwo & three")
  })

  it("reuses a provided Message-ID and generates one at the sender domain otherwise", () => {
    const generated = buildMimeMessage(baseInput())
    expect(generated.messageId).toMatch(/^<\d+\.[0-9a-f]+@gmail\.com>$/)
    expect(generated.mime).toContain(`Message-ID: ${generated.messageId}`)
  })

  it("RFC 2047-encodes non-ASCII subjects and names", () => {
    const built = buildMimeMessage(
      baseInput({
        subject: "Grüße aus München",
        to: [{ name: "José García", email: "jose@example.com" }],
      })
    )
    expect(built.mime).toContain("Subject: =?UTF-8?B?")
    expect(built.mime).toContain("=?UTF-8?B?")

    // Decoding the encoded words restores the original text.
    let decoded = built.mime
    for (const [whole, base64] of built.mime.matchAll(
      /=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g
    )) {
      decoded = decoded.replace(whole, decodeBase64Utf8(base64))
    }
    expect(decoded).toContain("Subject: Grüße aus München")
    expect(decoded).toContain("José García <jose@example.com>")
  })

  it("chunks long non-ASCII subjects into multiple encoded words", () => {
    const subject = "Ü".repeat(60)
    const header = encodeHeaderValue(subject)
    for (const word of header.split(/\r\n /)) {
      expect(word.length).toBeLessThanOrEqual(75)
    }
    const decoded = header
      .split(/\r\n /)
      .map((word) => /=\?UTF-8\?B\?(.*)\?=/.exec(word)?.[1] ?? "")
      .map(decodeBase64Utf8)
      .join("")
    expect(decoded).toBe(subject)
  })

  it("strips CR/LF from header values (header-injection guard)", () => {
    const built = buildMimeMessage(baseInput({ subject: "Hi\r\nBcc: evil@x" }))
    // The payload is one folded line — no injected Bcc header exists.
    expect(built.mime).toContain("Subject: Hi Bcc: evil@x\r\n")
    expect(built.mime).not.toMatch(/^Bcc:/m)
    expect(built.mime).not.toContain("\r\nBcc:")
  })

  it("folds CR/LF out of In-Reply-To and References", () => {
    const built = buildMimeMessage(
      baseInput({
        inReplyTo: "<msg-0@example.com>\r\nBcc: victim@x",
        references: "<a@x>\n<b@x>",
      })
    )
    expect(built.mime).toContain(
      "In-Reply-To: <msg-0@example.com> Bcc: victim@x\r\n"
    )
    expect(built.mime).toContain("References: <a@x> <b@x>\r\n")
    // Each threaded header stays a single physical line.
    const lines = built.mime.split(/\r\n/)
    expect(
      lines.filter((line) => line.startsWith("In-Reply-To:"))
    ).toHaveLength(1)
    expect(lines.filter((line) => line.startsWith("References:"))).toHaveLength(
      1
    )
    expect(built.mime).not.toMatch(/^Bcc:/m)
  })

  it("strips CR/LF from the address email part", () => {
    expect(formatAddress({ email: "a@x.com\r\nBcc: evil@x" })).toBe(
      "a@x.comBcc: evil@x"
    )
    // Newline-bearing ASCII names unfold to spaces like other headers.
    expect(formatAddress({ name: "Bob\r\nEvil", email: "b@x.com" })).toBe(
      "Bob Evil <b@x.com>"
    )
    const built = buildMimeMessage(
      baseInput({ to: [{ email: "a@x.com\r\nBcc: evil@x" }] })
    )
    expect(built.mime).toContain("To: a@x.comBcc: evil@x\r\n")
    expect(built.mime).not.toMatch(/^Bcc:/m)
  })

  it("omits empty recipient headers and keeps Bcc in the MIME (Gmail delivers to MIME Bcc)", () => {
    const built = buildMimeMessage(baseInput())
    expect(built.mime).not.toMatch(/^Cc:/m)
    expect(built.mime).not.toMatch(/^Bcc:/m)

    const withBcc = buildMimeMessage(
      baseInput({ bcc: [{ email: "hidden@example.com" }] })
    )
    expect(withBcc.mime).toContain("Bcc: hidden@example.com")
  })

  it("formats addresses with quoting when needed", () => {
    expect(formatAddress({ name: "Doe, Jane", email: "j@d" })).toBe(
      '"Doe, Jane" <j@d>'
    )
    expect(formatAddress({ email: "bare@d" })).toBe("bare@d")
  })

  it("reports ASCII-ness", () => {
    expect(isAscii("plain")).toBe(true)
    expect(isAscii("nön")).toBe(false)
  })

  it("base64url-encodes without padding or +/ characters", () => {
    expect(stringToBase64Url("hello")).toBe("aGVsbG8")
    expect(stringToBase64Url("subjects?&/=")).not.toMatch(/[+/=]/)
  })
})

describe("htmlToText", () => {
  it("drops tags, breaks on block elements, decodes entities", () => {
    expect(htmlToText("<style>p{}</style><p>Hi</p>Bye&nbsp;!")).toBe(
      "Hi\nBye !"
    )
  })

  it("ignores script contents and collapses blank runs", () => {
    expect(
      htmlToText("<script>alert(1)</script><p>a</p>\n\n\n\n<p>b</p>")
    ).toBe("a\n\nb")
  })
})

describe("buildMimeMessage attachments (task 8.5)", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 253, 254])
  const contentBase64 = btoa(String.fromCharCode(...bytes))

  function attachmentInput(
    attachments: NonNullable<SendEmailInput["attachments"]>
  ): SendEmailInput {
    return baseInput({ attachments })
  }

  function mixedBoundaryOf(mime: string): string {
    return (
      /Content-Type: multipart\/mixed; boundary="([^"]+)"/.exec(mime)?.[1] ?? ""
    )
  }

  it("wraps the alternative bodies in multipart/mixed with one part per attachment", () => {
    const built = buildMimeMessage(
      attachmentInput([
        {
          filename: "data.bin",
          mimeType: "application/octet-stream",
          contentBase64,
        },
      ])
    )
    const mixed = mixedBoundaryOf(built.mime)
    expect(mixed).toBeTruthy()
    // Top-level wrapper is mixed; the alternative block is nested inside.
    expect(built.mime).toMatch(
      new RegExp(
        `Content-Type: multipart/mixed; boundary="${mixed}"\\r\\n\\r\\n--${mixed}\\r\\nContent-Type: multipart/alternative`
      )
    )
    // Both alternative bodies survive inside the nested block.
    expect(decodedBodies(built.mime)).toContain("plain text")
    expect(built.mime).toContain("Content-Type: multipart/alternative")
  })

  it("emits attachment part headers and a base64 body that decodes to the bytes", () => {
    const built = buildMimeMessage(
      attachmentInput([
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          contentBase64,
        },
      ])
    )
    expect(built.mime).toContain(
      'Content-Type: application/pdf; name="report.pdf"'
    )
    expect(built.mime).toContain(
      'Content-Disposition: attachment; filename="report.pdf"'
    )
    // The part body is the wrapped (76-char lines) base64 of the input,
    // directly under the attachment part's Content-Transfer-Encoding.
    const part =
      /Content-Disposition: attachment[^\r\n]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(
        built.mime
      )
    expect(part).toBeTruthy()
    const decoded = Uint8Array.from(atob(part![1].replace(/\r\n/g, "")), (c) =>
      c.charCodeAt(0)
    )
    expect([...decoded]).toEqual([...bytes])
  })

  it("falls back to application/octet-stream and tolerates an htmlBody-less draft", () => {
    const built = buildMimeMessage(
      baseInput({
        htmlBody: undefined,
        attachments: [{ filename: "raw", contentBase64 }],
      })
    )
    expect(built.mime).toContain(
      'Content-Type: application/octet-stream; name="raw"'
    )
    // No explicit HTML part; the explicit textBody survives next to the
    // attachment part.
    const decoded = decodedBodies(built.mime)
    expect(decoded[0]).toBe("plain text")
    expect(decoded).toHaveLength(2)
  })

  it("keeps the plain multipart/alternative shape without attachments", () => {
    const built = buildMimeMessage(baseInput({ htmlBody: "<p>hi</p>" }))
    expect(built.mime).toMatch(/Content-Type: multipart\/alternative/)
    expect(built.mime).not.toContain("multipart/mixed")
    expect(built.mime).not.toContain("Content-Disposition: attachment")
  })

  it("escapes quotes in filenames and header-injection newlines", () => {
    const built = buildMimeMessage(
      attachmentInput([
        {
          filename: 'we"ird\\name.txt',
          mimeType: "text/plain",
          contentBase64,
        },
      ])
    )
    expect(built.mime).toContain('name="we\\"ird\\\\name.txt"')
    // Newlines never produce a new header line.
    const injected = buildMimeMessage(
      attachmentInput([{ filename: "x.txt\r\nBcc: evil@x", contentBase64 }])
    )
    expect(injected.mime).not.toContain("\r\nBcc:")
  })

  it("encodes non-ASCII filenames as RFC 2047 words inside the quoted param", () => {
    const built = buildMimeMessage(
      attachmentInput([
        { filename: "résumé.txt", mimeType: "text/plain", contentBase64 },
      ])
    )
    expect(built.mime).toMatch(/name="=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?="/)
    // Round-trip: every encoded word decodes back to the original name.
    const words = [
      ...built.mime.matchAll(/name="((?:=\?UTF-8\?B\?.*?\?=)+)"/g),
    ].map((match) =>
      match[1]
        .split(/\r\n /)
        .map((word) => /=\?UTF-8\?B\?(.*)\?=/.exec(word)?.[1] ?? "")
        .map((chunk) =>
          new TextDecoder().decode(
            Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0))
          )
        )
        .join("")
    )
    expect(words.filter(Boolean)).toEqual(["résumé.txt", "résumé.txt"])
  })
})
