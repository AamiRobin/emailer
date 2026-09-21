//! Ollama (local models) client (task 4.1, design D1).
//!
//! Ollama serves an OpenAI-compatible chat-completions endpoint, so this
//! client is [`openai_compat`] pointed at `http://localhost:11434` by
//! default, with a base-URL override for nonstandard ports/hosts. No API
//! key: Ollama is authenticated by owning the machine, so no
//! Authorization header is ever sent.
//!
//! Locality (spec "AI consent and data boundaries": Ollama SHALL keep all
//! requests on the local machine): the default base URL is loopback, and
//! the shared transport (`http`) only ever permits plaintext HTTP to
//! loopback hosts — a plain-HTTP override to a LAN/remote host is a
//! [`AiError::Config`] before any bytes leave the process. A remote
//! Ollama fronted by HTTPS stays possible via an `https://` override.

use super::openai_compat::{OpenAiCompatClient, DEFAULT_COMPLETIONS_PATH};
use super::{AiError, AiProvider, ChatRequest, ChatResponse};

/// Ollama's default local endpoint.
pub const DEFAULT_BASE_URL: &str = "http://localhost:11434";

/// A client for a (by default local) Ollama server.
#[derive(Debug, Clone)]
pub struct OllamaClient {
    inner: OpenAiCompatClient,
}

impl Default for OllamaClient {
    fn default() -> Self {
        Self::new()
    }
}

impl OllamaClient {
    pub fn new() -> Self {
        OllamaClient {
            // Ollama mounts the OpenAI shape at /v1/chat/completions —
            // stated explicitly here so the path override contract stays
            // visible in the provider module that relies on it.
            inner: OpenAiCompatClient::new(DEFAULT_BASE_URL.to_string(), None)
                .with_path(DEFAULT_COMPLETIONS_PATH.to_string()),
        }
    }

    /// Override the Ollama origin (still subject to the plaintext-only-
    /// loopback transport rule).
    pub(crate) fn with_base_url(base_url: String) -> Self {
        OllamaClient {
            inner: OpenAiCompatClient::new(base_url, None)
                .with_path(DEFAULT_COMPLETIONS_PATH.to_string()),
        }
    }
}

impl AiProvider for OllamaClient {
    fn id(&self) -> &str {
        "ollama"
    }

    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse, AiError> {
        self.inner.chat(request).await
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::http;
    use crate::ai::mock;
    use crate::ai::{ChatMessage, ChatRole};

    fn sample_request() -> ChatRequest {
        ChatRequest {
            model: "llama3.1:8b".to_string(),
            system: Some("Draft short replies.".to_string()),
            messages: vec![ChatMessage {
                role: ChatRole::User,
                content: "hello".to_string(),
            }],
            max_tokens: 64,
        }
    }

    #[test]
    fn default_base_url_is_local_plaintext_and_allowed() {
        assert_eq!(DEFAULT_BASE_URL, "http://localhost:11434");
        // The shared transport accepts it: http + loopback.
        let parsed = http::parse_request_url(&format!("{DEFAULT_BASE_URL}/v1/chat/completions"))
            .expect("default endpoint passes the transport policy");
        assert!(!parsed.https);
        assert_eq!(parsed.port, 11434);
    }

    #[tokio::test]
    async fn happy_path_sends_no_auth_header_over_the_openai_shape() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"local answer"}}],"model":"llama3.1:8b","usage":{"prompt_tokens":9,"completion_tokens":3}}"#;
        let server = mock::spawn(200, "OK", body).await;
        let client = OllamaClient::with_base_url(server.base_url());

        let response = client.chat(sample_request()).await.expect("succeeds");
        assert_eq!(response.content, "local answer");
        assert_eq!(response.model, "llama3.1:8b");
        // Ollama's OpenAI-shape usage rides the shared parse (task 2.2);
        // no total, so it is computed prompt + completion.
        assert_eq!(
            response.usage,
            Some(super::super::ChatUsage {
                prompt_tokens: 9,
                completion_tokens: 3,
                total_tokens: 12,
            })
        );

        let request = &server.requests()[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, "/v1/chat/completions");
        // Keyless: no Authorization header at all.
        assert_eq!(request.header("authorization"), None);
        let sent: serde_json::Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(sent["model"], "llama3.1:8b");
        assert_eq!(sent["max_tokens"], 64);
        assert_eq!(sent["messages"][0]["role"], "system");
        assert_eq!(sent["messages"][1]["role"], "user");
    }

    #[tokio::test]
    async fn unreachable_local_server_is_a_network_error() {
        // Port 1 on loopback: nothing listens there; the failure must be
        // a specific network error, never a panic.
        let client = OllamaClient::with_base_url("http://127.0.0.1:1".to_string());
        let err = client.chat(sample_request()).await.unwrap_err();
        assert_eq!(err.kind(), "network");
    }

    #[tokio::test]
    async fn malformed_json_body_is_a_parse_error() {
        let server = mock::spawn(200, "OK", "<html>ollama down</html>").await;
        let client = OllamaClient::with_base_url(server.base_url());
        let err = client.chat(sample_request()).await.unwrap_err();
        assert_eq!(err.kind(), "parse");
    }
}
