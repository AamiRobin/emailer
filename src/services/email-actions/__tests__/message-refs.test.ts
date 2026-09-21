import { describe, expect, it } from "vitest"

import type { MessageRow } from "../../db/messages"
import { buildMessageRefs, MissingProviderRefError } from "../message-refs"

/** Row factory: only the provider-identity + id columns matter here. */
function row(overrides: Partial<MessageRow>): MessageRow {
  return {
    id: "msg-1",
    thread_id: "thread-1",
    account_id: "acc-1",
    gmail_message_id: null,
    imap_uid: null,
    imap_folder: null,
    message_id_header: null,
    in_reply_to: null,
    references_header: null,
    subject: null,
    from_name: null,
    from_address: null,
    to_json: null,
    cc_json: null,
    bcc_json: null,
    date: 0,
    snippet: null,
    body_html: null,
    body_text: null,
    headers: null,
    size_estimate: null,
    is_read: 0,
    is_flagged: 0,
    has_attachments: 0,
    parts_json: null,
    created_at: 0,
    auth_results: null,
    ...overrides,
  }
}

describe("buildMessageRefs", () => {
  it("addresses gmail by the exact message id, with a numeric uid fallback", () => {
    const refs = buildMessageRefs("gmail", [
      row({ id: "m1", gmail_message_id: "5000000000000001" }),
      row({ id: "m2", gmail_message_id: "5000000000000002" }),
    ])
    expect(refs).toEqual([
      {
        folder: "",
        uid: 5000000000000001,
        providerMessageId: "5000000000000001",
      },
      {
        folder: "",
        uid: 5000000000000002,
        providerMessageId: "5000000000000002",
      },
    ])
  })

  it("carries opaque hex gmail ids verbatim and degrades uid to 0", () => {
    const refs = buildMessageRefs("gmail", [
      row({ id: "m1", gmail_message_id: "17bec548b2c4e7ca" }),
    ])
    expect(refs).toEqual([
      {
        folder: "",
        uid: 0,
        providerMessageId: "17bec548b2c4e7ca",
      },
    ])
  })

  it("addresses imap by folder path + uid", () => {
    const refs = buildMessageRefs("imap", [
      row({ id: "m1", imap_folder: "INBOX", imap_uid: 101 }),
      row({ id: "m2", imap_folder: "INBOX", imap_uid: 102 }),
    ])
    expect(refs).toEqual([
      { folder: "INBOX", uid: 101 },
      { folder: "INBOX", uid: 102 },
    ])
  })

  it("throws MissingProviderRefError for a gmail row without an id", () => {
    expect(() => buildMessageRefs("gmail", [row({ id: "m-broken" })])).toThrow(
      MissingProviderRefError
    )
  })

  it("throws MissingProviderRefError for an imap row without uid/folder", () => {
    expect(() =>
      buildMessageRefs("imap", [row({ id: "m-broken", imap_uid: 7 })])
    ).toThrow(MissingProviderRefError)
    expect(() =>
      buildMessageRefs("imap", [row({ id: "m-broken", imap_folder: "INBOX" })])
    ).toThrow(MissingProviderRefError)
  })
})
