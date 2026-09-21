//! Generic OpenAI-compatible chat-completions client (task 4.1, design
//! D1). The user configures a base URL (+ optional path override) and an
//! optional API key; this one module covers Ollama's OpenAI endpoint and
//! gateway providers without a dedicated module.
//!
//! Wire format (the classic OpenAI chat-completions shape, chosen for
//! widest gateway/Ollama compatibility):
//!
//! ```text
//! POST {base_url}{path}                       (default path /v1/chat/completions)
//! Content-Type: application/json
//! Authorization: Bearer <key>                 (omitted entirely when keyless)
//! {"model": "...", "max_tokens": N, "messages": [
//!     {"role": "system",    "content": "..."}   ← only when a system prompt is set
//!     {"role": "user",      "content": "..."},
//!     {"role": "assistant", "content": "..."} ]}
//! ```
//!
//! Parse path: `choices[0].message.content`; the response's `model`
//! field names the model (falling back to the requested id). Non-2xx
//! becomes [`AiError::Status`] (429 → [`AiError::RateLimited`]) with a
//! key-redacted body snippet; a 2xx body that is not this JSON shape is
//! [`AiError::Parse`].

use serde::{Deserialize, Serialize};

use super::http;
use super::{status_error, AiError, AiProvider, ChatRequest, ChatResponse, ChatRole, ChatUsage};

/// The standard OpenAI path, appended to the configured base URL.
pub const DEFAULT_COMPLETIONS_PATH: &str = "/v1/chat/completions";

/// A client for one configured OpenAI-compatible endpoint.
#[derive(Debug, Clone)]
pub struct OpenAiCompatClient {
    base_url: String,
    path: String,
    /// `None` for keyless endpoints (Ollama, open gateways): no
    /// Authorization header is sent at all.
    api_key: Option<String>,
}

impl OpenAiCompatClient {
    pub fn new(base_url: String, api_key: Option<String>) -> Self {
        OpenAiCompatClient {
            base_url,
            path: DEFAULT_COMPLETIONS_PATH.to_string(),
            api_key,
        }
    }

    /// Override the completions path (gateways that mount the OpenAI
    /// shape somewhere else).
    pub fn with_path(mut self, path: String) -> Self {
        self.path = path;
        self
    }

    /// The full request URL.
    pub(crate) fn url(&self) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), self.path)
    }
}

// ---------- Wire structs (request encode + response parse) ----------

#[derive(Serialize)]
struct WireRequest<'a> {
    model: &'a str,
    messages: Vec<WireMessage<'a>>,
    max_tokens: u32,
}

#[derive(Serialize)]
struct WireMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct WireResponse {
    #[serde(default)]
    choices: Vec<WireChoice>,
    #[serde(default)]
    model: Option<String>,
    /// OpenAI's classic `usage` block (`prompt_tokens` /
    /// `completion_tokens` / `total_tokens`, task 2.2). Ollama and most
    /// gateways mirror it; absent or partial → no usage on the response
    /// and the TS client estimates.
    #[serde(default)]
    usage: Option<WireUsage>,
}

#[derive(Deserialize)]
struct WireUsage {
    #[serde(default)]
    prompt_tokens: Option<u64>,
    #[serde(default)]
    completion_tokens: Option<u64>,
    #[serde(default)]
    total_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct WireChoice {
    #[serde(default)]
    message: Option<WireResponseMessage>,
}

#[derive(Deserialize)]
struct WireResponseMessage {
    #[serde(default)]
    content: Option<String>,
}

/// Encode a [`ChatRequest`] into the wire body: the system prompt (when
/// set) becomes the leading `system` message.
pub(crate) fn encode_request(request: &ChatRequest) -> Result<String, AiError> {
    let mut messages = Vec::with_capacity(request.messages.len() + 1);
    if let Some(system) = &request.system {
        messages.push(WireMessage {
            role: "system",
            content: system,
        });
    }
    for message in &request.messages {
        messages.push(WireMessage {
            role: match message.role {
                ChatRole::User => "user",
                ChatRole::Assistant => "assistant",
            },
            content: &message.content,
        });
    }
    serde_json::to_string(&WireRequest {
        model: &request.model,
        messages,
        max_tokens: request.max_tokens,
    })
    .map_err(|error| AiError::Config(format!("failed to encode the request body: {error}")))
}

/// `None` unless BOTH per-side counts are present (a partial report is
/// no report); the total defaults to prompt + completion when the
/// endpoint omits it.
fn parse_usage(usage: Option<WireUsage>) -> Option<ChatUsage> {
    let usage = usage?;
    let prompt = usage.prompt_tokens?;
    let completion = usage.completion_tokens?;
    Some(ChatUsage::from_parts(prompt, completion, usage.total_tokens))
}

/// Parse a 2xx body into a [`ChatResponse`]: first choice with message
/// content wins; `fallback_model` is the requested id, used when the
/// endpoint omits its own `model` field.
pub(crate) fn parse_completion(body: &str, fallback_model: &str) -> Result<ChatResponse, AiError> {
    let parsed: WireResponse = serde_json::from_str(body)
        .map_err(|error| AiError::Parse(format!("not a chat-completions response: {error}")))?;
    let content = parsed
        .choices
        .into_iter()
        .find_map(|choice| choice.message.and_then(|message| message.content))
        .ok_or_else(|| {
            AiError::Parse("no choices[0].message.content in the response".to_string())
        })?;
    Ok(ChatResponse {
        content,
        model: parsed.model.unwrap_or_else(|| fallback_model.to_string()),
        usage: parse_usage(parsed.usage),
    })
}

impl AiProvider for OpenAiCompatClient {
    fn id(&self) -> &str {
        "openai-compatible"
    }

    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse, AiError> {
        let body = encode_request(&request)?;
        // The Bearer header exists only when a key is configured.
        let auth_header = self.api_key.as_ref().map(|key| format!("Bearer {key}"));
        let headers: Vec<(&str, &str)> = match &auth_header {
            Some(auth) => vec![("authorization", auth.as_str())],
            None => Vec::new(),
        };

        let response = http::post_json(&self.url(), &headers, &body).await?;
        if !(200..300).contains(&response.status) {
            return Err(status_error(
                response.status,
                &response.body,
                response.retry_after_secs,
                self.api_key.as_deref(),
            ));
        }
        parse_completion(&response.body, &request.model)
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
            model: "llama3".to_string(),
            system: Some("Be terse.".to_string()),
            messages: vec![ChatMessage {
                role: ChatRole::User,
                content: "hello".to_string(),
            }],
            max_tokens: 32,
        }
    }

    #[tokio::test]
    async fn custom_base_url_and_path_wire_shape() {
        let body = r#"{"choices":[{"index":0,"message":{"role":"assistant","content":"hi there"}}],"model":"llama3"}"#;
        let server = mock::spawn(200, "OK", body).await;
        let client = OpenAiCompatClient::new(server.base_url(), Some("sk-gw-1".to_string()))
            .with_path("/api/v1/chat/completions".to_string());

        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(response.content, "hi there");
        assert_eq!(response.model, "llama3");

        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, "/api/v1/chat/completions");
        assert_eq!(request.header("authorization"), Some("Bearer sk-gw-1"));
        assert_eq!(request.header("content-type"), Some("application/json"));
        let sent: serde_json::Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(sent["model"], "llama3");
        assert_eq!(sent["max_tokens"], 32);
        assert_eq!(sent["messages"][0]["role"], "system");
        assert_eq!(sent["messages"][0]["content"], "Be terse.");
        assert_eq!(sent["messages"][1]["role"], "user");
        assert_eq!(sent["messages"][1]["content"], "hello");
    }

    #[tokio::test]
    async fn keyless_endpoints_send_no_authorization_header() {
        let body = r#"{"choices":[{"message":{"content":"ok"}}]}"#;
        let server = mock::spawn(200, "OK", body).await;
        let client = OpenAiCompatClient::new(server.base_url(), None);

        client.chat(sample_request()).await.expect("succeeds");
        let request = &server.requests()[0];
        assert_eq!(request.header("authorization"), None);
    }

    #[tokio::test]
    async fn missing_content_is_a_parse_error() {
        // 2xx but the shape does not match: no choices/message/content.
        let server = mock::spawn(200, "OK", r#"{"object":"chat.completion"}"#).await;
        let client = OpenAiCompatClient::new(server.base_url(), None);
        let err = client.chat(sample_request()).await.unwrap_err();
        assert_eq!(err.kind(), "parse");
    }

    #[tokio::test]
    async fn usage_block_is_parsed_with_the_total_or_its_sum() {
        // Full block: the endpoint's own total wins.
        let server = mock::spawn(
            200,
            "OK",
            r#"{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}"#,
        )
        .await;
        let client = OpenAiCompatClient::new(server.base_url(), None);
        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(
            response.usage,
            Some(super::super::ChatUsage {
                prompt_tokens: 11,
                completion_tokens: 7,
                total_tokens: 18,
            })
        );
        // No total: prompt + completion.
        let server = mock::spawn(
            200,
            "OK",
            r#"{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":11,"completion_tokens":7}}"#,
        )
        .await;
        let client = OpenAiCompatClient::new(server.base_url(), None);
        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(
            response.usage,
            Some(super::super::ChatUsage {
                prompt_tokens: 11,
                completion_tokens: 7,
                total_tokens: 18,
            })
        );
        // Absent usage → None (the TS client estimates).
        let server = mock::spawn(200, "OK", r#"{"choices":[{"message":{"content":"ok"}}]}"#).await;
        let client = OpenAiCompatClient::new(server.base_url(), None);
        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(response.usage, None);
        // A partial report (completion side missing) is no report either.
        let server = mock::spawn(
            200,
            "OK",
            r#"{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":11}}"#,
        )
        .await;
        let client = OpenAiCompatClient::new(server.base_url(), None);
        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(response.usage, None);
    }

    #[tokio::test]
    async fn http_401_maps_to_a_status_error() {
        let server = mock::spawn(
            401,
            "Unauthorized",
            r#"{"error":{"message":"invalid api key"}}"#,
        )
        .await;
        let client = OpenAiCompatClient::new(server.base_url(), Some("sk-bad".to_string()));
        let err = client.chat(sample_request()).await.unwrap_err();
        match err {
            AiError::Status { code, body_snippet } => {
                assert_eq!(code, 401);
                assert!(body_snippet.contains("invalid api key"), "{body_snippet}");
            }
            other => panic!("expected status error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn malformed_json_body_is_a_parse_error() {
        let server = mock::spawn(200, "OK", "<html>not json</html>").await;
        let client = OpenAiCompatClient::new(server.base_url(), None);
        let err = client.chat(sample_request()).await.unwrap_err();
        assert_eq!(err.kind(), "parse");
    }
}
