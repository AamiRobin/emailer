//! OpenAI chat-completions client (task 4.1, design D1).
//!
//! Wire format: `POST https://api.openai.com/v1/chat/completions` with
//! `Authorization: Bearer <key>`; body
//! `{"model", "max_tokens", "messages":[{"role","content"}…]}` with the
//! system prompt prepended as a `role: "system"` message. Parse path:
//! `choices[0].message.content`. Non-2xx → [`AiError::Status`] (429 →
//! [`AiError::RateLimited`]) with a key-redacted body snippet; a 2xx
//! non-JSON body → [`AiError::Parse`].
//!
//! This module pins the official endpoint and delegates the wire work to
//! the identical-shape [`openai_compat`] client — one encode/parse pair
//! for every OpenAI-shaped API.

use super::openai_compat::OpenAiCompatClient;
use super::{AiError, AiProvider, ChatRequest, ChatResponse};

/// The official OpenAI API origin.
pub const DEFAULT_BASE_URL: &str = "https://api.openai.com";

/// A client for the official OpenAI endpoint.
#[derive(Debug, Clone)]
pub struct OpenAiClient {
    inner: OpenAiCompatClient,
}

impl OpenAiClient {
    pub fn new(api_key: String) -> Self {
        OpenAiClient {
            inner: OpenAiCompatClient::new(DEFAULT_BASE_URL.to_string(), Some(api_key)),
        }
    }

    /// Point at a different origin (test seam; production routing keeps
    /// the official endpoint — custom origins go through the
    /// `openai-compatible` provider instead).
    #[cfg(test)]
    fn with_base_url(api_key: String, base_url: String) -> Self {
        OpenAiClient {
            inner: OpenAiCompatClient::new(base_url, Some(api_key)),
        }
    }
}

impl AiProvider for OpenAiClient {
    fn id(&self) -> &str {
        "openai"
    }

    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse, AiError> {
        self.inner.chat(request).await
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::mock;
    use crate::ai::{ChatMessage, ChatRole};

    fn sample_request() -> ChatRequest {
        ChatRequest {
            model: "gpt-4o-mini".to_string(),
            system: Some("You draft replies.".to_string()),
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
            max_tokens: 128,
        }
    }

    #[tokio::test]
    async fn happy_path_wire_shape_and_parse() {
        let body = r#"{"id":"chatcmpl-1","object":"chat.completion","model":"gpt-4o-mini-2024-07-18","choices":[{"index":0,"message":{"role":"assistant","content":"Draft ready."},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":6,"total_tokens":26}}"#;
        let server = mock::spawn(200, "OK", body).await;
        let client = OpenAiClient::with_base_url(
            "sk-openai-1".to_string(),
            server.base_url(),
        );

        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(response.content, "Draft ready.");
        // The response's own model id wins over the requested one.
        assert_eq!(response.model, "gpt-4o-mini-2024-07-18");
        // OpenAI's usage block rides the shared parse (task 2.2).
        assert_eq!(
            response.usage,
            Some(super::super::ChatUsage {
                prompt_tokens: 20,
                completion_tokens: 6,
                total_tokens: 26,
            })
        );

        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, "/v1/chat/completions");
        assert_eq!(request.header("authorization"), Some("Bearer sk-openai-1"));
        assert_eq!(request.header("content-type"), Some("application/json"));
        let sent: serde_json::Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(sent["model"], "gpt-4o-mini");
        assert_eq!(sent["max_tokens"], 128);
        // System prompt is the leading message; roles pass through.
        let messages = sent["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], "You draft replies.");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[2]["role"], "assistant");
        assert_eq!(messages[3]["role"], "user");
    }

    #[tokio::test]
    async fn missing_model_field_falls_back_to_the_requested_id() {
        let body = r#"{"choices":[{"message":{"content":"ok"}}]}"#;
        let server = mock::spawn(200, "OK", body).await;
        let client = OpenAiClient::with_base_url("k".to_string(), server.base_url());
        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(response.model, "gpt-4o-mini");
    }

    #[tokio::test]
    async fn http_401_maps_to_a_status_error() {
        let server = mock::spawn(
            401,
            "Unauthorized",
            r#"{"error":{"message":"Incorrect API key provided"}}"#,
        )
        .await;
        let client = OpenAiClient::with_base_url("sk-bad".to_string(), server.base_url());
        let err = client.chat(sample_request()).await.unwrap_err();
        match err {
            AiError::Status { code, body_snippet } => {
                assert_eq!(code, 401);
                assert!(
                    body_snippet.contains("Incorrect API key"),
                    "{body_snippet}"
                );
            }
            other => panic!("expected status error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn malformed_json_body_is_a_parse_error() {
        let server = mock::spawn(200, "OK", "gateway timeout text").await;
        let client = OpenAiClient::with_base_url("k".to_string(), server.base_url());
        let err = client.chat(sample_request()).await.unwrap_err();
        assert_eq!(err.kind(), "parse");
    }
}
