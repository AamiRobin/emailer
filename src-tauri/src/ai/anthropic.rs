//! Anthropic Messages API client (task 4.1, design D1).
//!
//! Wire format:
//!
//! ```text
//! POST {base}/v1/messages            (default base https://api.anthropic.com)
//! x-api-key: <key>
//! anthropic-version: 2023-06-01
//! Content-Type: application/json
//! {"model": "...", "max_tokens": N,
//!  "system": "...",                                  ← only when a system prompt is set
//!  "messages": [{"role": "user", "content": "..."}, …]}
//! ```
//!
//! Parse path: `content[0].text` — the first `text` block of the
//! response's `content` array; the response's `model` field names the
//! model (falling back to the requested id). Non-2xx → [`AiError::Status`]
//! (429 → [`AiError::RateLimited`]) with a key-redacted body snippet; a
//! 2xx body that is not this JSON shape → [`AiError::Parse`].

use serde::{Deserialize, Serialize};

use super::http;
use super::{status_error, AiError, AiProvider, ChatRequest, ChatResponse, ChatRole, ChatUsage};

/// The official Anthropic API origin.
pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const MESSAGES_PATH: &str = "/v1/messages";
/// The API version header Anthropic requires on every call.
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// A client for the official Anthropic endpoint.
#[derive(Debug, Clone)]
pub struct AnthropicClient {
    base_url: String,
    api_key: String,
}

impl AnthropicClient {
    pub fn new(api_key: String) -> Self {
        AnthropicClient {
            base_url: DEFAULT_BASE_URL.to_string(),
            api_key,
        }
    }

    /// Point at a different origin (test seam; production routing keeps
    /// the official endpoint).
    #[cfg(test)]
    fn with_base_url(mut self, base_url: String) -> Self {
        self.base_url = base_url;
        self
    }
}

// ---------- Wire structs ----------

#[derive(Serialize)]
struct WireRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<&'a str>,
    messages: Vec<WireMessage<'a>>,
}

#[derive(Serialize)]
struct WireMessage<'a> {
    role: ChatRole,
    content: &'a str,
}

#[derive(Deserialize)]
struct WireResponse {
    #[serde(default)]
    content: Vec<WireContentBlock>,
    #[serde(default)]
    model: Option<String>,
    /// Anthropic reports `usage.input_tokens` / `usage.output_tokens` on
    /// every Messages response (task 2.2); absent/blank → no usage on the
    /// command response and the TS client estimates.
    #[serde(default)]
    usage: Option<WireUsage>,
}

#[derive(Deserialize)]
struct WireContentBlock {
    #[serde(rename = "type", default)]
    block_type: Option<String>,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize)]
struct WireUsage {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
}

/// Anthropic has no total field — the total is input + output. `None`
/// unless BOTH sides are present (a partial report is no report).
fn parse_usage(usage: Option<WireUsage>) -> Option<ChatUsage> {
    let usage = usage?;
    let input = usage.input_tokens?;
    let output = usage.output_tokens?;
    Some(ChatUsage::from_parts(input, output, None))
}

impl AiProvider for AnthropicClient {
    fn id(&self) -> &str {
        "anthropic"
    }

    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse, AiError> {
        let wire_request = WireRequest {
            model: &request.model,
            max_tokens: request.max_tokens,
            system: request.system.as_deref(),
            messages: request
                .messages
                .iter()
                .map(|message| WireMessage {
                    role: message.role,
                    content: &message.content,
                })
                .collect(),
        };
        let body = serde_json::to_string(&wire_request)
            .map_err(|error| AiError::Config(format!("failed to encode the request body: {error}")))?;

        let url = format!("{}{}", self.base_url.trim_end_matches('/'), MESSAGES_PATH);
        let headers = [
            ("x-api-key", self.api_key.as_str()),
            ("anthropic-version", ANTHROPIC_VERSION),
        ];
        let response = http::post_json(&url, &headers, &body).await?;
        if !(200..300).contains(&response.status) {
            return Err(status_error(
                response.status,
                &response.body,
                response.retry_after_secs,
                Some(&self.api_key),
            ));
        }

        let parsed: WireResponse = serde_json::from_str(&response.body)
            .map_err(|error| AiError::Parse(format!("not an Anthropic messages response: {error}")))?;
        // content[0].text, lenient about non-text blocks: prefer the
        // first typed text block, else the first block carrying text.
        let text = parsed
            .content
            .iter()
            .find(|block| block.block_type.as_deref() == Some("text") && block.text.is_some())
            .or_else(|| parsed.content.iter().find(|block| block.text.is_some()))
            .and_then(|block| block.text.clone())
            .ok_or_else(|| AiError::Parse("no text block in the Anthropic response".to_string()))?;
        Ok(ChatResponse {
            content: text,
            model: parsed.model.unwrap_or_else(|| request.model.clone()),
            usage: parse_usage(parsed.usage),
        })
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::mock;
    use crate::ai::ChatMessage;

    fn sample_request() -> ChatRequest {
        ChatRequest {
            model: "claude-3-5-haiku-latest".to_string(),
            system: Some("Summarize mail.".to_string()),
            messages: vec![
                ChatMessage {
                    role: ChatRole::User,
                    content: "first".to_string(),
                },
                ChatMessage {
                    role: ChatRole::Assistant,
                    content: "second".to_string(),
                },
                ChatMessage {
                    role: ChatRole::User,
                    content: "third".to_string(),
                },
            ],
            max_tokens: 256,
        }
    }

    #[tokio::test]
    async fn happy_path_wire_shape_and_parse() {
        let body = r#"{"id":"msg_1","type":"message","role":"assistant","model":"claude-3-5-haiku-20241022","content":[{"type":"text","text":"Summary text."}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5}}"#;
        let server = mock::spawn(200, "OK", body).await;
        let client = AnthropicClient::new("sk-ant-1".to_string())
            .with_base_url(server.base_url());

        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(response.content, "Summary text.");
        assert_eq!(response.model, "claude-3-5-haiku-20241022");
        // usage.input_tokens/output_tokens land on the response (task 2.2);
        // Anthropic sends no total, so it is computed input + output.
        assert_eq!(
            response.usage,
            Some(super::super::ChatUsage {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
            })
        );

        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, "/v1/messages");
        assert_eq!(request.header("x-api-key"), Some("sk-ant-1"));
        assert_eq!(request.header("anthropic-version"), Some("2023-06-01"));
        assert_eq!(request.header("content-type"), Some("application/json"));
        let sent: serde_json::Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(sent["model"], "claude-3-5-haiku-latest");
        assert_eq!(sent["max_tokens"], 256);
        assert_eq!(sent["system"], "Summarize mail.");
        let messages = sent["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(messages[1]["role"], "assistant");
    }

    #[tokio::test]
    async fn picks_the_text_block_from_mixed_content() {
        // tool_use blocks ride alongside text blocks; the text wins.
        let body = r#"{"model":"claude-3-5-haiku-latest","content":[{"type":"tool_use","id":"t1","name":"f","input":{}},{"type":"text","text":"the answer"}]}"#;
        let server = mock::spawn(200, "OK", body).await;
        let client = AnthropicClient::new("k".to_string()).with_base_url(server.base_url());
        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(response.content, "the answer");
    }

    #[tokio::test]
    async fn missing_text_block_is_a_parse_error() {
        let server = mock::spawn(200, "OK", r#"{"content":[]}"#).await;
        let client = AnthropicClient::new("k".to_string()).with_base_url(server.base_url());
        let err = client.chat(sample_request()).await.unwrap_err();
        assert_eq!(err.kind(), "parse");
    }

    #[tokio::test]
    async fn absent_or_partial_usage_report_is_none() {
        // No usage block at all (task 2.2: leave None — TS estimates).
        let server = mock::spawn(200, "OK", r#"{"content":[{"type":"text","text":"hi"}]}"#).await;
        let client = AnthropicClient::new("k".to_string()).with_base_url(server.base_url());
        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(response.usage, None);
        // A partial report (completion side missing) is no report either.
        let server = mock::spawn(
            200,
            "OK",
            r#"{"content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":10}}"#,
        )
        .await;
        let client = AnthropicClient::new("k".to_string()).with_base_url(server.base_url());
        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(response.usage, None);
    }

    #[tokio::test]
    async fn http_401_maps_to_a_status_error() {
        let server = mock::spawn(
            401,
            "Unauthorized",
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
        )
        .await;
        let client = AnthropicClient::new("sk-ant-bad".to_string())
            .with_base_url(server.base_url());
        let err = client.chat(sample_request()).await.unwrap_err();
        match err {
            AiError::Status { code, body_snippet } => {
                assert_eq!(code, 401);
                assert!(body_snippet.contains("authentication_error"), "{body_snippet}");
            }
            other => panic!("expected status error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn malformed_json_body_is_a_parse_error() {
        let server = mock::spawn(200, "OK", "{{{{").await;
        let client = AnthropicClient::new("k".to_string()).with_base_url(server.base_url());
        let err = client.chat(sample_request()).await.unwrap_err();
        assert_eq!(err.kind(), "parse");
    }
}
