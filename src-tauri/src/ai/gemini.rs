//! Google Gemini generateContent client (task 4.1, design D1).
//!
//! Wire format:
//!
//! ```text
//! POST {base}/v1beta/models/{model}:generateContent?key=<key>
//!      (default base https://generativelanguage.googleapis.com)
//! Content-Type: application/json
//! {"contents": [{"role": "user"|"model", "parts": [{"text": "..."}]}…],
//!  "systemInstruction": {"parts": [{"text": "..."}]},   ← only when set
//!  "generationConfig": {"maxOutputTokens": N}}
//! ```
//!
//! Gemini's role vocabulary differs from ours: `assistant` maps to
//! `model`, and the system prompt is a top-level `systemInstruction`
//! rather than a message. Parse path:
//! `candidates[0].content.parts[0].text`; the response's `modelVersion`
//! field names the model (falling back to the requested id). Non-2xx →
//! [`AiError::Status`] (429 → [`AiError::RateLimited`]); a 2xx body that
//! is not this JSON shape → [`AiError::Parse`].
//!
//! Key handling: Gemini authenticates via the `key` query parameter, so
//! the request URL contains the key. That URL is therefore NEVER placed
//! in a log line or an error message, and error body snippets go through
//! [`super::redact`] like every other provider.

use serde::{Deserialize, Serialize};

use super::http;
use super::{status_error, AiError, AiProvider, ChatRequest, ChatResponse, ChatRole, ChatUsage};

/// The official Generative Language API origin.
pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";
const GENERATE_PATH: &str = "/v1beta/models";

/// A client for the official Gemini endpoint.
#[derive(Debug, Clone)]
pub struct GeminiClient {
    base_url: String,
    api_key: String,
}

impl GeminiClient {
    pub fn new(api_key: String) -> Self {
        GeminiClient {
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
    contents: Vec<WireContent<'a>>,
    #[serde(rename = "systemInstruction", skip_serializing_if = "Option::is_none")]
    system_instruction: Option<WireInstruction<'a>>,
    #[serde(rename = "generationConfig")]
    generation_config: WireGeneration,
}

#[derive(Serialize)]
struct WireContent<'a> {
    role: &'a str,
    parts: Vec<WirePart<'a>>,
}

#[derive(Serialize)]
struct WireInstruction<'a> {
    parts: Vec<WirePart<'a>>,
}

#[derive(Serialize)]
struct WirePart<'a> {
    text: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireGeneration {
    max_output_tokens: u32,
}

#[derive(Deserialize)]
struct WireResponse {
    #[serde(default)]
    candidates: Vec<WireCandidate>,
    #[serde(rename = "modelVersion", default)]
    model_version: Option<String>,
    /// Gemini's `usageMetadata` (`promptTokenCount` /
    /// `candidatesTokenCount` / `totalTokenCount`, task 2.2). Absent or
    /// partial → no usage on the response; the TS client estimates.
    #[serde(rename = "usageMetadata", default)]
    usage_metadata: Option<WireUsageMetadata>,
}

#[derive(Deserialize)]
struct WireUsageMetadata {
    #[serde(rename = "promptTokenCount", default)]
    prompt_token_count: Option<u64>,
    #[serde(rename = "candidatesTokenCount", default)]
    candidates_token_count: Option<u64>,
    #[serde(rename = "totalTokenCount", default)]
    total_token_count: Option<u64>,
}

#[derive(Deserialize)]
struct WireCandidate {
    #[serde(default)]
    content: Option<WireCandidateContent>,
}

#[derive(Deserialize)]
struct WireCandidateContent {
    #[serde(default)]
    parts: Vec<WireResponsePart>,
}

#[derive(Deserialize)]
struct WireResponsePart {
    #[serde(default)]
    text: Option<String>,
}

fn gemini_role(role: ChatRole) -> &'static str {
    match role {
        ChatRole::User => "user",
        ChatRole::Assistant => "model",
    }
}

/// `None` unless BOTH per-side counts are present (a partial report is
/// no report); the total defaults to prompt + completion when the
/// endpoint omits it.
fn parse_usage(usage: Option<WireUsageMetadata>) -> Option<ChatUsage> {
    let usage = usage?;
    let prompt = usage.prompt_token_count?;
    let completion = usage.candidates_token_count?;
    Some(ChatUsage::from_parts(
        prompt,
        completion,
        usage.total_token_count,
    ))
}

impl AiProvider for GeminiClient {
    fn id(&self) -> &str {
        "gemini"
    }

    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse, AiError> {
        let mut contents = Vec::with_capacity(request.messages.len());
        for message in &request.messages {
            contents.push(WireContent {
                role: gemini_role(message.role),
                parts: vec![WirePart {
                    text: &message.content,
                }],
            });
        }
        let wire_request = WireRequest {
            contents,
            system_instruction: request.system.as_deref().map(|system| WireInstruction {
                parts: vec![WirePart { text: system }],
            }),
            generation_config: WireGeneration {
                max_output_tokens: request.max_tokens,
            },
        };
        let body = serde_json::to_string(&wire_request)
            .map_err(|error| AiError::Config(format!("failed to encode the request body: {error}")))?;

        // The key lives in the query string — this URL never reaches a
        // log line or error message (module docs).
        let url = format!(
            "{}{}/{}:generateContent?key={}",
            self.base_url.trim_end_matches('/'),
            GENERATE_PATH,
            request.model,
            self.api_key
        );
        let response = http::post_json(&url, &[], &body).await?;
        if !(200..300).contains(&response.status) {
            return Err(status_error(
                response.status,
                &response.body,
                response.retry_after_secs,
                Some(&self.api_key),
            ));
        }

        let parsed: WireResponse = serde_json::from_str(&response.body)
            .map_err(|error| AiError::Parse(format!("not a Gemini generateContent response: {error}")))?;
        let text = parsed
            .candidates
            .into_iter()
            .find_map(|candidate| {
                candidate
                    .content
                    .and_then(|content| content.parts.into_iter().find_map(|part| part.text))
            })
            .ok_or_else(|| {
                AiError::Parse("no candidates[0].content.parts text in the response".to_string())
            })?;
        Ok(ChatResponse {
            content: text,
            model: parsed
                .model_version
                .unwrap_or_else(|| request.model.clone()),
            usage: parse_usage(parsed.usage_metadata),
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
            model: "gemini-1.5-flash".to_string(),
            system: Some("Classify mail.".to_string()),
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
            max_tokens: 90,
        }
    }

    #[tokio::test]
    async fn happy_path_wire_shape_and_parse() {
        let body = r#"{"candidates":[{"content":{"parts":[{"text":"Newsletter."}],"role":"model"},"finishReason":"STOP"}],"modelVersion":"gemini-1.5-flash-002","usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":35,"totalTokenCount":42}}"#;
        let server = mock::spawn(200, "OK", body).await;
        let client =
            GeminiClient::new("g-key-1".to_string()).with_base_url(server.base_url());

        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(response.content, "Newsletter.");
        assert_eq!(response.model, "gemini-1.5-flash-002");
        // usageMetadata lands on the response (task 2.2).
        assert_eq!(
            response.usage,
            Some(super::super::ChatUsage {
                prompt_tokens: 7,
                completion_tokens: 35,
                total_tokens: 42,
            })
        );

        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        // Model id in the path, key in the query string.
        assert_eq!(
            request.target,
            "/v1beta/models/gemini-1.5-flash:generateContent?key=g-key-1"
        );
        assert_eq!(request.header("content-type"), Some("application/json"));
        let sent: serde_json::Value = serde_json::from_str(&request.body).unwrap();
        let contents = sent["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 3);
        assert_eq!(contents[0]["role"], "user");
        // Assistant turns map to Gemini's "model" role.
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(contents[1]["parts"][0]["text"], "second");
        assert_eq!(
            sent["systemInstruction"]["parts"][0]["text"],
            "Classify mail."
        );
        assert_eq!(sent["generationConfig"]["maxOutputTokens"], 90);
    }

    #[tokio::test]
    async fn no_candidates_is_a_parse_error() {
        // A real Gemini shape for a blocked request: candidates omitted.
        let body = r#"{"promptFeedback":{"blockReason":"SAFETY"}}"#;
        let server = mock::spawn(200, "OK", body).await;
        let client = GeminiClient::new("k".to_string()).with_base_url(server.base_url());
        let err = client.chat(sample_request()).await.unwrap_err();
        assert_eq!(err.kind(), "parse");
    }

    #[tokio::test]
    async fn absent_or_partial_usage_metadata_is_none() {
        // No usageMetadata at all (task 2.2: leave None — TS estimates).
        let server = mock::spawn(
            200,
            "OK",
            r#"{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"}}]}"#,
        )
        .await;
        let client = GeminiClient::new("k".to_string()).with_base_url(server.base_url());
        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(response.usage, None);
        // A total without per-side counts is a partial report: None.
        let server = mock::spawn(
            200,
            "OK",
            r#"{"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"}}],"usageMetadata":{"totalTokenCount":42}}"#,
        )
        .await;
        let client = GeminiClient::new("k".to_string()).with_base_url(server.base_url());
        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(response.usage, None);
    }

    #[tokio::test]
    async fn http_400_echoing_the_key_reports_it_redacted() {
        let body = r#"{"error":{"code":400,"message":"API key g-key-echo-55 not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}"#;
        let server = mock::spawn(400, "Bad Request", body).await;
        let client =
            GeminiClient::new("g-key-echo-55".to_string()).with_base_url(server.base_url());
        let err = client.chat(sample_request()).await.unwrap_err();
        match err {
            AiError::Status { code, body_snippet } => {
                assert_eq!(code, 400);
                assert!(!body_snippet.contains("g-key-echo-55"), "{body_snippet}");
                assert!(body_snippet.contains("[redacted]"), "{body_snippet}");
            }
            other => panic!("expected status error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn malformed_json_body_is_a_parse_error() {
        let server = mock::spawn(200, "OK", "not json at all").await;
        let client = GeminiClient::new("k".to_string()).with_base_url(server.base_url());
        let err = client.chat(sample_request()).await.unwrap_err();
        assert_eq!(err.kind(), "parse");
    }
}
