//! AI provider clients and the [`ai_chat`] command (task 4.1, design D1).
//!
//! D1 in one line: the HTTP calls to AI providers live in Rust, the TS
//! layer (`services/ai`, later tasks) builds prompts, invokes this
//! command, and owns caching/UI state. Hand-rolled JSON over the same
//! TCP + native-tls stack the IMAP/SMTP/avatar code uses (`http` here) —
//! SDK crates were explicitly rejected in the design (vendor churn; thin
//! REST is stable) and no new crates were added.
//!
//! Providers (one module each, behind the small [`AiProvider`] trait):
//! - [`anthropic`]  — `POST {base}/v1/messages`, `x-api-key` +
//!   `anthropic-version` headers; parse `content[0].text`.
//! - [`openai`]     — `POST /v1/chat/completions`, `Authorization: Bearer`;
//!   parse `choices[0].message.content`.
//! - [`openai_compat`] — the same wire shape against a user-configured
//!   base URL (+ optional path override); covers gateways and is the
//!   engine behind the Ollama client.
//! - [`gemini`]     — `POST /v1beta/models/{model}:generateContent?key=…`;
//!   parse `candidates[0].content.parts[0].text`.
//! - [`ollama`]     — [`openai_compat`] against `http://localhost:11434`
//!   by default (no key); stays on the local machine (spec "AI consent
//!   and data boundaries": Ollama SHALL keep all requests local).
//!
//! Streaming is deferred (design D1 allows non-streaming for v1 of every
//! surface): [`AiProvider::chat`] returns the whole completion. The
//! trait is deliberately shaped so a `chat_stream` slotting a Tauri
//! channel in later is additive — no existing signature changes.
//!
//! # API-key pragmatics (the enforced contract)
//!
//! Design D1's letter says keys "never enter the webview". That is
//! impossible for a user-pasted key typed into a settings form rendered
//! in the webview; the frontend (task 4.2+) seals keys at rest with the
//! existing AES-256-GCM envelope (`src/services/crypto/credentials.ts`)
//! and this module enforces everything that is actually enforceable:
//!
//! - keys are NEVER persisted by any code here (no settings table, no
//!   file, no cache entry touches them);
//! - keys are NEVER logged (no `log::` call in this module tree takes
//!   key material) and never appear in a `get`/`list` command;
//! - keys are NEVER echoed back: [`AiError`] has no key field, and every
//!   message that could embed provider-supplied text (body snippets in
//!   [`AiError::Status`]) is passed through [`redact`] so a hostile or
//!   misbehaving endpoint that echoes the key still cannot leak it
//!   through an error shown in the UI;
//! - the key travels once per call: webview → [`ai_chat`] argument →
//!   provider header, then it is dropped.
//!
//! # Outbound hosts and the CSP
//!
//! `ai_chat` connects to arbitrary user-configured hosts (the four
//! vendor endpoints, `localhost:11434` for Ollama, custom base URLs).
//! These are Rust-side sockets — the webview CSP / `http:` capability
//! allowlist does not apply to them (same posture as `avatar.rs`), so
//! adding providers requires no CSP or capability changes.
//!
//! # Rate limiting
//!
//! Each call is tagged with the `surface` that invoked it and admitted
//! by a per-surface fixed-window limiter ([`RateLimiter`]) before any
//! network I/O (spec "AI caching and failure handling": failures SHALL
//! be rate-limited to avoid request storms). Defaults: summaries
//! 10/min, categorization 30/min, every other surface 20/min. The
//! command never blocks mail functionality: it is one async task on
//! Tauri's runtime and shares nothing with the IMAP/SMTP paths.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

pub(crate) mod http;
pub mod anthropic;
pub mod gemini;
pub mod ollama;
pub mod openai;
pub mod openai_compat;

#[cfg(test)]
mod mock;

use crate::ai::anthropic::AnthropicClient;
use crate::ai::gemini::GeminiClient;
use crate::ai::ollama::OllamaClient;
use crate::ai::openai::OpenAiClient;
use crate::ai::openai_compat::OpenAiCompatClient;

/// `max_tokens` used when the caller omits it (task 4.1 command shape:
/// `maxTokens?`). Enough for a thread summary or a reply suggestion.
pub const DEFAULT_MAX_TOKENS: u32 = 1024;

/// The response body read cap for AI calls ([`http`]): chat completions
/// are JSON and stay far below this; the cap exists so a misbehaving or
/// hostile endpoint cannot stream forever or balloon memory.
pub(crate) const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

// ---------- Shared request/response types ----------

/// Which side of the conversation a message is on. Providers map this to
/// their own role vocabulary (Gemini: `assistant` → `model`; OpenAI-style
/// APIs get the system prompt as a `system` message, Anthropic as the
/// `system` field).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
}

/// One conversation turn. `content` is plain text — prompt shaping
/// (thread text, style profiles, …) is the TS layer's job (design D1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

/// A complete chat-completion request. `system` is the optional
/// instruction block sent ahead of the conversation.
#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: u32,
}

/// Provider-reported token usage for one completion (task 2.2, design
/// D8). The `ai_usage` ROW itself is written TS-side (Emailer's SQLite is
/// frontend-owned via tauri-plugin-sql; the Rust side has no DB
/// connection) — this struct only carries the provider's numbers across
/// the IPC so the TS client can record them, falling back to its own
/// chars/4 estimate when they are absent. Field names are snake_case on
/// the wire, matching the rest of the command payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ChatUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

impl ChatUsage {
    /// Build from the provider-reported per-side counts, computing the
    /// total as prompt + completion when the provider sends none.
    pub(crate) fn from_parts(prompt: u64, completion: u64, total: Option<u64>) -> Self {
        ChatUsage {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: total.unwrap_or_else(|| prompt.saturating_add(completion)),
        }
    }
}

/// A complete chat-completion response: the assistant text and the model
/// that produced it (the provider's own model id when it reports one).
/// `usage` is the provider's token report, [`None`] when the provider
/// omitted it — the TS client estimates in that case, so every COMPLETED
/// request still records usage.
#[derive(Debug, Clone, Serialize)]
pub struct ChatResponse {
    pub content: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<ChatUsage>,
}

/// The provider abstraction (design D1: "one module per provider behind a
/// small trait: chat-completion, streaming optional"). Not used as a
/// trait object — [`ai_chat`] routes to concrete clients — but every
/// provider speaks the same two methods, which keeps the command routing
/// and future tests uniform.
pub trait AiProvider {
    /// Stable provider id (`"anthropic"`, `"openai"`, …) — the same
    /// vocabulary the TS layer uses in `ai_chat`'s `provider` argument.
    fn id(&self) -> &str;

    /// Run one chat completion. Errors are always [`AiError`] with a
    /// specific kind and never carry the API key.
    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse, AiError>;
}

// ---------- Errors ----------

/// Why a call failed. The spec ("AI caching and failure handling")
/// demands failures "reported … with a specific reason", so the variants
/// are concrete: network vs HTTP status vs unparseable body vs the local
/// rate limiter vs a configuration mistake. No variant ever stores the
/// API key — [`AiError::Status`] carries only a truncated, key-redacted
/// body snippet.
#[derive(Debug, Clone)]
pub enum AiError {
    /// Connection, TLS, timeout, or cap failure talking to the endpoint.
    Network(String),
    /// The endpoint answered with a non-2xx status. `body_snippet` is the
    /// first bytes of the error body, key-redacted, for inline display.
    Status {
        code: u16,
        body_snippet: String,
    },
    /// The endpoint answered 2xx but the body was not the JSON shape the
    /// provider module documents.
    Parse(String),
    /// The local per-surface limiter (or a provider HTTP 429) refused the
    /// call; `retry_after_secs` says when to retry.
    RateLimited {
        retry_after_secs: Option<u64>,
    },
    /// The request itself is wrong: unknown provider, missing key for a
    /// provider that needs one, missing base URL, bad URL scheme, or
    /// plaintext HTTP to a non-loopback host.
    Config(String),
}

impl AiError {
    /// Stable machine-readable kind string — the `kind` field of the
    /// structured command error (`network` / `status` / `parse` /
    /// `rate_limited` / `config`).
    pub fn kind(&self) -> &'static str {
        match self {
            AiError::Network(_) => "network",
            AiError::Status { .. } => "status",
            AiError::Parse(_) => "parse",
            AiError::RateLimited { .. } => "rate_limited",
            AiError::Config(_) => "config",
        }
    }

    /// The HTTP status code when the failure was an HTTP-level one.
    pub fn status(&self) -> Option<u16> {
        match self {
            AiError::Status { code, .. } => Some(*code),
            _ => None,
        }
    }

    /// Convert into the webview-facing structured error, scrubbing any
    /// occurrence of the API key from the message (defense in depth: the
    /// provider modules already redact; this is the last line).
    pub(crate) fn into_command_error(self, secret: Option<&str>) -> AiCommandError {
        let mut command_error = AiCommandError {
            kind: self.kind().to_string(),
            message: self.to_string(),
            status: self.status(),
        };
        command_error.message = redact(&command_error.message, secret);
        command_error
    }
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AiError::Network(message) => write!(f, "network error: {message}"),
            AiError::Status { code, body_snippet } if body_snippet.is_empty() => {
                write!(f, "provider returned HTTP {code}")
            }
            AiError::Status { code, body_snippet } => {
                write!(f, "provider returned HTTP {code}: {body_snippet}")
            }
            AiError::Parse(message) => write!(f, "unexpected response from provider: {message}"),
            AiError::RateLimited { retry_after_secs } => match retry_after_secs {
                Some(secs) => write!(f, "rate limited; retry in {secs}s"),
                None => write!(f, "rate limited; retry shortly"),
            },
            AiError::Config(message) => write!(f, "configuration error: {message}"),
        }
    }
}

impl std::error::Error for AiError {}

/// The webview-facing error shape for `ai_chat`:
/// `{ kind, message, status? }`. `kind` is [`AiError::kind`]'s stable
/// string so the TS layer can branch (retry on `network`, back off on
/// `rate_limited`, surface config mistakes) without parsing prose.
#[derive(Debug, Serialize)]
pub struct AiCommandError {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

impl From<AiError> for AiCommandError {
    fn from(error: AiError) -> Self {
        AiCommandError {
            kind: error.kind().to_string(),
            message: error.to_string(),
            status: error.status(),
        }
    }
}

/// Replace every occurrence of `secret` in `text` with `[redacted]`.
/// Applied to anything that embeds provider-supplied bytes (error body
/// snippets) and to final command error messages. Skips absent/empty
/// secrets (Ollama runs keyless) and strings under [`MIN_REDACT_LEN`]:
/// real API keys are long, and treating a stray short argument as a
/// secret would shred ordinary words without protecting anything
/// credential-shaped.
pub(crate) fn redact(text: &str, secret: Option<&str>) -> String {
    match secret {
        Some(secret) if secret.len() >= MIN_REDACT_LEN => text.replace(secret, "[redacted]"),
        _ => text.to_string(),
    }
}

/// Minimum length for a string to be treated as redactable key material.
pub(crate) const MIN_REDACT_LEN: usize = 8;

/// First [`MAX_SNIPPET_BYTES`] bytes of `body`, char-boundary safe — the
/// displayable fragment of an error response body.
pub(crate) fn snippet(body: &str) -> String {
    const MAX_SNIPPET_BYTES: usize = 300;
    let mut end = MAX_SNIPPET_BYTES.min(body.len());
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    body[..end].to_string()
}

/// The shared non-2xx → [`AiError`] mapping every provider module uses:
/// 429 becomes [`AiError::RateLimited`] (honoring a `Retry-After` seconds
/// header when present), anything else a [`AiError::Status`] with a
/// key-redacted snippet of the response body.
pub(crate) fn status_error(
    code: u16,
    body: &str,
    retry_after_secs: Option<u64>,
    secret: Option<&str>,
) -> AiError {
    if code == 429 {
        return AiError::RateLimited { retry_after_secs };
    }
    AiError::Status {
        code,
        body_snippet: redact(&snippet(body), secret),
    }
}

// ---------- Per-surface rate limiting ----------

/// Rate-limit window: one minute, per surface.
pub(crate) const RATE_WINDOW: Duration = Duration::from_secs(60);
/// Summaries are the heaviest surface (whole threads per call): 10/min.
pub(crate) const SUMMARIES_LIMIT: u32 = 10;
/// Categorization assist fires per incoming message: 30/min.
pub(crate) const CATEGORIZATION_LIMIT: u32 = 30;
/// Quick-reply chips are the latency surface (parity-round-2 task 2.4):
/// tiny prompts and a 3-line output, so they get the loosest budget —
/// 40/min, fast enough to feel ambient across a mailbox session.
pub(crate) const QUICK_REPLIES_LIMIT: u32 = 40;
/// Every other (and any future) surface: 20/min.
pub(crate) const DEFAULT_LIMIT: u32 = 20;

/// The per-surface request budget per [`RATE_WINDOW`]. Surface names come
/// from the TS layer; matching is by distinctive prefix so "summary" and
/// "summaries" share a budget and new surfaces get the default.
pub(crate) fn limit_for_surface(surface: &str) -> u32 {
    let lowered = surface.to_ascii_lowercase();
    if lowered.contains("summar") {
        SUMMARIES_LIMIT
    } else if lowered.contains("categor") {
        CATEGORIZATION_LIMIT
    } else if lowered.contains("quick-repl") {
        QUICK_REPLIES_LIMIT
    } else {
        DEFAULT_LIMIT
    }
}

#[derive(Debug, Clone, Copy)]
struct WindowEntry {
    started: Instant,
    count: u32,
}

/// Fixed-window per-surface rate limiter (spec "AI caching and failure
/// handling": rate-limit AI calls to avoid request storms). Deliberately
/// tiny: one map entry per surface seen this minute. Lock poisoning is
/// recovered from (the counter is advisory, never worth a panic) so the
/// command can never take the app down.
pub(crate) struct RateLimiter {
    windows: Mutex<HashMap<String, WindowEntry>>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl RateLimiter {
    pub(crate) fn new() -> Self {
        RateLimiter {
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Account one request for `surface`. `Ok(())` = proceed with the
    /// network call; `Err(AiError::RateLimited)` = refuse BEFORE any I/O,
    /// with the seconds until the current window resets.
    pub(crate) fn check(&self, surface: &str) -> Result<(), AiError> {
        let limit = limit_for_surface(surface);
        let mut windows = self.lock();
        let now = Instant::now();
        let entry = windows
            .entry(surface.to_string())
            .or_insert_with(|| WindowEntry {
                started: now,
                count: 0,
            });
        if now.duration_since(entry.started) >= RATE_WINDOW {
            entry.started = now;
            entry.count = 0;
        }
        if entry.count >= limit {
            let elapsed = now.duration_since(entry.started);
            return Err(AiError::RateLimited {
                retry_after_secs: Some(RATE_WINDOW.saturating_sub(elapsed).as_secs() + 1),
            });
        }
        entry.count += 1;
        Ok(())
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, WindowEntry>> {
        match self.windows.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

/// Managed state for the AI subsystem: the shared per-surface limiter
/// every `ai_chat` call passes through. Registered in `lib.rs`.
#[derive(Default)]
pub struct AiState {
    pub(crate) limiter: RateLimiter,
}

// ---------- The command ----------

/// `ai_chat` arguments, grouped so the routing logic is testable without
/// a Tauri app (unit tests build this directly). `base_url` is honored
/// only for `ollama` and `openai-compatible` — the named vendor clients
/// pin their official endpoints.
#[derive(Debug, Clone)]
pub(crate) struct AiCall {
    pub provider: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: u32,
    pub surface: String,
}

// ---------- Reasoning-tag stripping ----------

/// Inline reasoning tags emitted by chain-of-thought models (DeepSeek-R1,
/// QwQ, Qwen3, …) inside their `content`. Matched case-insensitively.
const REASONING_TAGS: [&str; 4] = ["think", "thinking", "reason", "reasoning"];

/// Strip the chain-of-thought reasoning some models emit inline in
/// `content` (e.g. `<think>…</think>`) and keep only the user-facing
/// answer — the ANSWER half of the reference's split_reasoning (ideas-only
/// read; the reasoning itself is dropped, not surfaced). Handles complete
/// blocks, a lone leading `</think>` (reasoning streamed before any open
/// tag), and an unterminated `<think>` (reasoning that runs to the end).
/// Case-insensitive; otherwise the answer text is kept byte-identical.
fn strip_reasoning(text: &str) -> String {
    let mut answer = text.to_string();

    // 1) Well-formed <tag>…</tag> blocks, earliest first, repeatedly.
    loop {
        let lower = answer.to_ascii_lowercase();
        let mut earliest: Option<(usize, usize)> = None; // (open_start, block_end)
        for tag in REASONING_TAGS {
            let open = format!("<{tag}>");
            let close = format!("</{tag}>");
            if let Some(open_start) = lower.find(&open) {
                let inner = open_start + open.len();
                if let Some(rel) = lower[inner..].find(&close) {
                    let end = inner + rel + close.len();
                    if earliest.map_or(true, |(o, _)| open_start < o) {
                        earliest = Some((open_start, end));
                    }
                }
            }
        }
        match earliest {
            Some((open_start, end)) => answer.replace_range(open_start..end, ""),
            None => break,
        }
    }

    // 2) An unterminated open tag: everything from it to the end is
    // reasoning (a block whose close has not arrived — or never will).
    {
        let lower = answer.to_ascii_lowercase();
        let mut cut: Option<usize> = None; // open_start
        for tag in REASONING_TAGS {
            let open = format!("<{tag}>");
            if let Some(open_start) = lower.find(&open) {
                if cut.map_or(true, |o| open_start < o) {
                    cut = Some(open_start);
                }
            }
        }
        if let Some(open_start) = cut {
            answer.truncate(open_start);
        }
    }

    // 3) A lone closer with no opener left before it: some models emit
    // only `</think>` ahead of the answer, so everything before the LAST
    // lone closer was reasoning.
    {
        let lower = answer.to_ascii_lowercase();
        let mut cut: Option<usize> = None; // end of the last lone closer
        for tag in REASONING_TAGS {
            let close = format!("</{tag}>");
            if let Some(close_start) = lower.find(&close) {
                let end = close_start + close.len();
                if cut.map_or(true, |e| end > e) {
                    cut = Some(end);
                }
            }
        }
        if let Some(end) = cut {
            answer.replace_range(0..end, "");
        }
    }

    answer.trim().to_string()
}

/// Route one call: rate-limit the surface, build the right provider
/// client, run the completion, and map any failure to the structured
/// webview error — with the API key scrubbed from the message. Never
/// panics; never persists anything.
pub(crate) async fn ai_chat_impl(
    limiter: &RateLimiter,
    call: AiCall,
) -> Result<ChatResponse, AiCommandError> {
    let secret = call.api_key.as_deref();

    if call.messages.is_empty() {
        return Err(AiError::Config("at least one message is required".to_string())
            .into_command_error(secret));
    }
    if call.model.trim().is_empty() {
        return Err(AiError::Config("a model id is required".to_string()).into_command_error(secret));
    }
    if let Err(error) = limiter.check(&call.surface) {
        return Err(error.into_command_error(secret));
    }

    let request = ChatRequest {
        model: call.model,
        system: call.system,
        messages: call.messages,
        max_tokens: call.max_tokens,
    };

    let result = match call.provider.as_str() {
        "anthropic" => match non_empty(secret) {
            Some(key) => run(&AnthropicClient::new(key.to_string()), &call.surface, request).await,
            None => Err(AiError::Config("anthropic requires an API key".to_string())),
        },
        "openai" => match non_empty(secret) {
            Some(key) => run(&OpenAiClient::new(key.to_string()), &call.surface, request).await,
            None => Err(AiError::Config("openai requires an API key".to_string())),
        },
        "gemini" => match non_empty(secret) {
            Some(key) => run(&GeminiClient::new(key.to_string()), &call.surface, request).await,
            None => Err(AiError::Config("gemini requires an API key".to_string())),
        },
        "ollama" => {
            // Ollama needs no key; the base URL may be overridden (still
            // enforced: plaintext HTTP only to loopback hosts, see http).
            let client = match non_empty(call.base_url.as_deref()) {
                Some(base_url) => OllamaClient::with_base_url(base_url.to_string()),
                None => OllamaClient::new(),
            };
            run(&client, &call.surface, request).await
        }
        "openai-compatible" | "openai_compat" | "custom" => {
            match non_empty(call.base_url.as_deref()) {
                Some(base_url) => {
                    let client =
                        OpenAiCompatClient::new(base_url.to_string(), call.api_key.clone());
                    run(&client, &call.surface, request).await
                }
                None => Err(AiError::Config(
                    "openai-compatible requires a base URL".to_string(),
                )),
            }
        }
        other => Err(AiError::Config(format!(
            "unknown provider {other:?}; expected anthropic, openai, gemini, ollama, or openai-compatible"
        ))),
    };

    let mut response = result.map_err(|error| error.into_command_error(secret))?;
    // Strip inline chain-of-thought reasoning from the user-facing text at
    // this ONE seam, so every surface and every provider benefits. The
    // provider's usage block was already parsed from the raw body inside
    // `chat` — it rides along verbatim, so the ai_usage accounting the TS
    // layer performs is unaffected (only the displayed text is cleaned).
    response.content = strip_reasoning(&response.content);
    Ok(response)
}

/// Run one completion through a concrete provider client. The debug log
/// carries ids only (surface, provider id) — never key material. Takes
/// just the surface because the request construction above has moved the
/// other `AiCall` fields.
async fn run(
    provider: &impl AiProvider,
    surface: &str,
    request: ChatRequest,
) -> Result<ChatResponse, AiError> {
    log::debug!("ai_chat surface={surface:?} provider={}", provider.id());
    provider.chat(request).await
}

/// `Some` for trimmed non-empty strings, `None` otherwise.
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// Run one AI chat completion for the TS layer (design D1). Arguments
/// (Tauri maps the webview's camelCase to these snake_case params):
///
/// - `provider`: `"anthropic" | "openai" | "gemini" | "ollama" |
///   "openai-compatible"` (alias `"custom"`).
/// - `baseUrl` (optional): honored for `ollama` (default
///   `http://localhost:11434`) and `openai-compatible` (required there).
///   Plaintext HTTP is only ever allowed to loopback hosts; remote
///   endpoints must use HTTPS.
/// - `apiKey` (optional): the unsealed key for THIS call, passed by the
///   frontend from its sealed store (see the module docs for the
///   key-handling contract). Required for the three vendor providers,
///   unused by Ollama, optional for openai-compatible.
/// - `model`: the model id to request.
/// - `system` (optional): instruction block.
/// - `messages`: `[{ role: "user" | "assistant", content }]`.
/// - `maxTokens` (optional): output budget, default [`DEFAULT_MAX_TOKENS`].
/// - `surface`: which AI surface is calling (drives the rate limiter).
///
/// Returns `{ content, model }` or a structured error
/// `{ kind, message, status? }` — never a panic, never the key.
#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AiState>,
    provider: String,
    base_url: Option<String>,
    api_key: Option<String>,
    model: String,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
    surface: String,
) -> Result<ChatResponse, AiCommandError> {
    let call = AiCall {
        provider,
        base_url,
        api_key,
        model,
        system,
        messages,
        max_tokens: max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        // An unnamed surface still gets limiter admission, under the
        // default budget.
        surface: if surface.trim().is_empty() {
            "default".to_string()
        } else {
            surface
        },
    };
    ai_chat_impl(&state.limiter, call).await
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    // ----- redaction / snippets -----

    #[test]
    fn redact_replaces_every_occurrence_of_the_secret() {
        let text = "key sk-abc-123 used here and sk-abc-123 again";
        assert_eq!(
            redact(text, Some("sk-abc-123")),
            "key [redacted] used here and [redacted] again"
        );
        // Absent or empty secret: no-op.
        assert_eq!(redact(text, None), text);
        assert_eq!(redact(text, Some("")), text);
        // A long-enough secret that is not present changes nothing.
        assert_eq!(redact(text, Some("sk-not-here-99")), text);
        // Short strings are not treated as secrets: redacting a 1-char
        // "key" would replace every matching letter in ordinary words.
        assert_eq!(redact("loopback", Some("k")), "loopback");
    }

    #[test]
    fn snippet_truncates_on_a_char_boundary() {
        assert_eq!(snippet("short body"), "short body");
        assert_eq!(snippet(&"x".repeat(500)).chars().count(), 300);
        // The cap is in bytes: 300 bytes of a 2-byte character is 150
        // chars — and the boundary walk never splits a codepoint.
        assert_eq!(snippet(&"é".repeat(400)).chars().count(), 150);
        // An odd byte offset lands mid-character; walk back to the
        // boundary instead of panicking.
        let odd = format!("a{}", "é".repeat(400));
        assert_eq!(snippet(&odd).chars().count(), 150);
    }

    // ----- error shape -----

    #[test]
    fn ai_error_debug_and_display_omit_the_key() {
        let err = status_error(
            500,
            r#"upstream saw key sk-super-secret-42 and exploded"#,
            None,
            Some("sk-super-secret-42"),
        );
        let debug = format!("{err:?}");
        let display = err.to_string();
        assert!(!debug.contains("sk-super-secret-42"), "{debug}");
        assert!(!display.contains("sk-super-secret-42"), "{display}");
        assert!(debug.contains("[redacted]"), "{debug}");
        assert_eq!(err.kind(), "status");
        assert_eq!(err.status(), Some(500));
    }

    #[test]
    fn error_kinds_are_specific_and_stable() {
        assert_eq!(AiError::Network("x".into()).kind(), "network");
        assert_eq!(AiError::Parse("x".into()).kind(), "parse");
        assert_eq!(
            AiError::RateLimited {
                retry_after_secs: None
            }
            .kind(),
            "rate_limited"
        );
        assert_eq!(AiError::Config("x".into()).kind(), "config");
    }

    #[test]
    fn http_429_maps_to_rate_limited_with_retry_after() {
        let err = status_error(429, "slow down", Some(17), Some("sk-x"));
        match err {
            AiError::RateLimited {
                retry_after_secs: Some(17),
            } => {}
            other => panic!("expected rate_limited(17), got {other:?}"),
        }
    }

    // ----- rate limiter -----

    #[test]
    fn surface_budgets_match_the_documented_defaults() {
        assert_eq!(limit_for_surface("summaries"), SUMMARIES_LIMIT);
        assert_eq!(limit_for_surface("summary"), SUMMARIES_LIMIT);
        assert_eq!(limit_for_surface("categorization"), CATEGORIZATION_LIMIT);
        // Quick-reply chips (task 2.4) get their own, looser budget — the
        // exact wire name and a prefix variant both land in it.
        assert_eq!(limit_for_surface("quick-replies"), QUICK_REPLIES_LIMIT);
        assert_eq!(limit_for_surface("quick-reply"), QUICK_REPLIES_LIMIT);
        // Natural-language rule assist (task 2.5) is on-demand and cheap:
        // no special bucket — the default budget serves it.
        assert_eq!(limit_for_surface("rule-assist"), DEFAULT_LIMIT);
        // Unknown and future surfaces share the default budget.
        assert_eq!(limit_for_surface("smart-replies"), DEFAULT_LIMIT);
        assert_eq!(limit_for_surface("ask-inbox"), DEFAULT_LIMIT);
        assert_eq!(limit_for_surface(""), DEFAULT_LIMIT);
    }

    #[test]
    fn quick_reply_budget_is_looser_than_the_default_and_independent() {
        assert!(QUICK_REPLIES_LIMIT > DEFAULT_LIMIT);
        let limiter = RateLimiter::new();
        // Exhaust the summaries budget (the tightest) first…
        for _ in 0..SUMMARIES_LIMIT {
            assert!(limiter.check("summaries").is_ok());
        }
        assert!(limiter.check("summaries").is_err());
        // …the chips' looser window is untouched by that and still has
        // room past the default budget, too.
        for _ in 0..DEFAULT_LIMIT {
            assert!(limiter.check("quick-replies").is_ok());
        }
        assert!(limiter.check("quick-replies").is_ok());
    }

    #[test]
    fn burst_over_limit_is_refused_without_a_network_call() {
        let limiter = RateLimiter::new();
        for _ in 0..CATEGORIZATION_LIMIT {
            assert!(limiter.check("categorization").is_ok());
        }
        match limiter.check("categorization") {
            Err(AiError::RateLimited {
                retry_after_secs: Some(secs),
            }) => assert!((1..=60).contains(&secs), "retry window {secs}s"),
            other => panic!("expected rate_limited, got {other:?}"),
        }
    }

    #[test]
    fn surfaces_have_independent_windows() {
        let limiter = RateLimiter::new();
        for _ in 0..SUMMARIES_LIMIT {
            assert!(limiter.check("summaries").is_ok());
        }
        assert!(limiter.check("summaries").is_err());
        // A different surface still has its full budget.
        assert!(limiter.check("categorization").is_ok());
    }

    // ----- command routing (no Tauri runtime needed) -----

    fn call(provider: &str, base_url: Option<String>, api_key: Option<String>) -> AiCall {
        AiCall {
            provider: provider.to_string(),
            base_url,
            api_key,
            model: "test-model".to_string(),
            system: None,
            messages: vec![ChatMessage {
                role: ChatRole::User,
                content: "hi".to_string(),
            }],
            max_tokens: 16,
            surface: "summaries".to_string(),
        }
    }

    #[tokio::test]
    async fn config_mistakes_are_structured_config_errors() {
        let limiter = RateLimiter::new();
        // Unknown provider.
        let err = ai_chat_impl(&limiter, call("claude", None, None))
            .await
            .unwrap_err();
        assert_eq!(err.kind, "config");
        // Missing key for a provider that needs one.
        let err = ai_chat_impl(&limiter, call("anthropic", None, None))
            .await
            .unwrap_err();
        assert_eq!(err.kind, "config");
        // Missing base URL for openai-compatible.
        let err = ai_chat_impl(&limiter, call("openai-compatible", None, Some("k".into())))
            .await
            .unwrap_err();
        assert_eq!(err.kind, "config");
        // No messages.
        let mut bad = call("openai", None, Some("k".into()));
        bad.messages.clear();
        let err = ai_chat_impl(&limiter, bad).await.unwrap_err();
        assert_eq!(err.kind, "config");
    }

    #[tokio::test]
    async fn plaintext_http_to_a_remote_host_is_a_config_error() {
        let limiter = RateLimiter::new();
        let err = ai_chat_impl(
            &limiter,
            call(
                "openai-compatible",
                Some("http://api.example.com/v1".to_string()),
                Some("k".into()),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, "config");
        assert!(err.message.contains("loopback"), "{err:?}");
    }

    #[tokio::test]
    async fn rate_limited_surfaces_never_reach_the_network() {
        let server = mock::spawn(200, "OK", "{}").await;
        let limiter = RateLimiter::new();
        // Exhaust the summaries budget first.
        for _ in 0..SUMMARIES_LIMIT {
            assert!(limiter.check("summaries").is_ok());
        }
        let err = ai_chat_impl(
            &limiter,
            call("openai-compatible", Some(server.base_url()), Some("k".into())),
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, "rate_limited");
        assert!(err.status.is_none());
        assert!(
            server.requests().is_empty(),
            "a rate-limited call must not touch the network"
        );
    }

    #[tokio::test]
    async fn openai_compatible_round_trip_through_the_command_shape() {
        let body = r#"{"choices":[{"index":0,"message":{"role":"assistant","content":"pong"}}],"model":"llama3"}"#;
        let server = mock::spawn(200, "OK", body).await;
        let limiter = RateLimiter::new();

        let response = ai_chat_impl(
            &limiter,
            AiCall {
                provider: "openai-compatible".to_string(),
                base_url: Some(server.base_url()),
                api_key: Some("sk-custom-1".to_string()),
                model: "llama3".to_string(),
                system: Some("Be brief.".to_string()),
                messages: vec![
                    ChatMessage {
                        role: ChatRole::User,
                        content: "ping".to_string(),
                    },
                    ChatMessage {
                        role: ChatRole::Assistant,
                        content: "hello".to_string(),
                    },
                    ChatMessage {
                        role: ChatRole::User,
                        content: "ping again".to_string(),
                    },
                ],
                max_tokens: 64,
                surface: "summaries".to_string(),
            },
        )
        .await
        .expect("round trip succeeds");
        assert_eq!(response.content, "pong");
        assert_eq!(response.model, "llama3");

        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, "/v1/chat/completions");
        assert_eq!(request.header("authorization"), Some("Bearer sk-custom-1"));
        let sent: serde_json::Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(sent["model"], "llama3");
        assert_eq!(sent["max_tokens"], 64);
        // System prompt becomes the leading system message.
        assert_eq!(sent["messages"][0]["role"], "system");
        assert_eq!(sent["messages"][0]["content"], "Be brief.");
        assert_eq!(sent["messages"].as_array().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn server_error_echoing_the_key_never_leaks_it_to_the_response() {
        let key = "sk-echo-me-9876";
        let body = format!(r#"{{"error":{{"message":"auth failed for key {key}"}}}}"#);
        let server = mock::spawn(500, "Internal Server Error", &body).await;
        let limiter = RateLimiter::new();

        let err = ai_chat_impl(
            &limiter,
            call("openai-compatible", Some(server.base_url()), Some(key.into())),
        )
        .await
        .unwrap_err();

        assert_eq!(err.kind, "status");
        assert_eq!(err.status, Some(500));
        let json = serde_json::to_string(&err).unwrap();
        assert!(!json.contains(key), "leaked via JSON: {json}");
        assert!(!err.message.contains(key), "leaked via message: {err:?}");
        assert!(err.message.contains("[redacted]"), "{err:?}");
    }

    // ----- usage passthrough (task 2.2, design D8) -----

    #[tokio::test]
    async fn provider_usage_rides_the_command_response() {
        // The command response carries the provider's usage verbatim (the
        // ai_usage ROW is written TS-side; Rust stays DB-free).
        let body = r#"{"choices":[{"message":{"content":"pong"}}],"model":"llama3","usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}"#;
        let server = mock::spawn(200, "OK", body).await;
        let limiter = RateLimiter::new();

        let response = ai_chat_impl(
            &limiter,
            call("openai-compatible", Some(server.base_url()), Some("k".into())),
        )
        .await
        .expect("round trip succeeds");
        assert_eq!(
            response.usage,
            Some(ChatUsage {
                prompt_tokens: 12,
                completion_tokens: 4,
                total_tokens: 16,
            })
        );
        // And the serialization exposes the snake_case fields the TS
        // client reads (with the whole block omitted when absent).
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["usage"]["prompt_tokens"], 12);
        assert_eq!(json["usage"]["completion_tokens"], 4);
        assert_eq!(json["usage"]["total_tokens"], 16);

        // No usage in the body → the field is absent from the payload.
        let body = r#"{"choices":[{"message":{"content":"pong"}}],"model":"llama3"}"#;
        let server = mock::spawn(200, "OK", body).await;
        let response = ai_chat_impl(
            &limiter,
            call("openai-compatible", Some(server.base_url()), Some("k".into())),
        )
        .await
        .expect("round trip succeeds");
        assert_eq!(response.usage, None);
        let json = serde_json::to_value(&response).unwrap();
        assert!(json.get("usage").is_none());
    }

    #[test]
    fn usage_total_defaults_to_the_sum_of_the_sides() {
        assert_eq!(
            ChatUsage::from_parts(10, 5, None),
            ChatUsage {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
            }
        );
        assert_eq!(
            ChatUsage::from_parts(10, 5, Some(16)),
            ChatUsage {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 16,
            }
        );
    }

    // ----- reasoning-tag stripping (single seam in ai_chat_impl) -----

    #[test]
    fn strip_reasoning_removes_a_wellformed_block() {
        let answer = strip_reasoning("<think>let me think about this</think>The answer is 42.");
        assert_eq!(answer, "The answer is 42.");
    }

    #[test]
    fn strip_reasoning_handles_a_lone_leading_closer() {
        // Some models emit the close tag only, ahead of the answer.
        let answer = strip_reasoning("reasoning first\n</think>\nFinal answer.");
        assert_eq!(answer, "Final answer.");
    }

    #[test]
    fn strip_reasoning_treats_an_unterminated_block_as_all_reasoning() {
        // An open tag with no close: everything from it to the end is
        // reasoning — the answer is what came before (possibly nothing).
        assert_eq!(strip_reasoning("<think>still thinking about it"), "");
        assert_eq!(
            strip_reasoning("The answer is 42. <think>rambles on forever"),
            "The answer is 42."
        );
    }

    #[test]
    fn strip_reasoning_is_a_noop_on_clean_content() {
        let answer = strip_reasoning("Just a plain answer.");
        assert_eq!(answer, "Just a plain answer.");
    }

    #[test]
    fn strip_reasoning_matches_tags_case_insensitively() {
        assert_eq!(strip_reasoning("<THINK>hmm</THINK>Answer"), "Answer");
        assert_eq!(strip_reasoning("<Think>hmm</ThInK>Answer"), "Answer");
        assert_eq!(strip_reasoning("<tHinK>hmm</think>Answer"), "Answer");
    }

    #[test]
    fn strip_reasoning_removes_multiple_blocks_earliest_first() {
        let answer = strip_reasoning("<think>a</think>A<think>b</think>B");
        assert_eq!(answer, "AB");
        // Interleaved with a close-only lead: every block goes, and text
        // after the lone closer belongs to the answer (the reference's
        // close-only contract: only what PRECEDES the closer is reasoning).
        assert_eq!(
            strip_reasoning("</think>lead <think>a</think>A<think>b</think>B"),
            "lead AB"
        );
    }

    #[test]
    fn strip_reasoning_covers_every_supported_tag_name() {
        for tag in ["think", "thinking", "reason", "reasoning"] {
            let answer = strip_reasoning(&format!("<{tag}>reasoning</{tag}>Answer"));
            assert_eq!(answer, "Answer", "tag {tag}");
        }
    }

    #[tokio::test]
    async fn reasoning_is_stripped_from_the_command_response_but_usage_rides_verbatim() {
        // The raw provider body carries reasoning inline in the content
        // AND a usage block: the command response must return only the
        // answer while the token counts stay exactly as reported (the
        // strip happens after usage was parsed from the raw body).
        let body = r#"{"choices":[{"message":{"content":"<think>internal scratchpad</think>\nThe visible answer."}}],"model":"r1","usage":{"prompt_tokens":7,"completion_tokens":30,"total_tokens":37}}"#;
        let server = mock::spawn(200, "OK", body).await;
        let limiter = RateLimiter::new();

        let response = ai_chat_impl(
            &limiter,
            call("openai-compatible", Some(server.base_url()), Some("k".into())),
        )
        .await
        .expect("round trip succeeds");

        assert_eq!(response.content, "The visible answer.");
        assert_eq!(
            response.usage,
            Some(ChatUsage {
                prompt_tokens: 7,
                completion_tokens: 30,
                total_tokens: 37,
            })
        );
    }
}
