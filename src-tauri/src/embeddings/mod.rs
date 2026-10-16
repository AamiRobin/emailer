//! Local semantic-search embeddings (parity-round-3 design D1, task 6.1).
//!
//! Compiled only behind the `local-embeddings` Cargo feature (ON by
//! default): candle-core + candle-transformers run the BGE-small-en-v1.5
//! model (384-dim) on CPU, tokenizers does the 512-token truncation, and
//! the model files themselves are downloaded by the frontend through the
//! shared pinned downloader (task 1.4's `download_model`, SHA-256
//! verified) into an app-managed directory whose path THIS module
//! receives from the caller — hf-hub's cache is deliberately NOT used
//! (one download flow, one persistence story: migration v21
//! `model_downloads`, written by TS).
//!
//! Pinned model (documented per the 1.4 contract; verified 2026-10-04 by
//! downloading the revision and hashing the files locally):
//!   repo     BAAI/bge-small-en-v1.5 (official, safetensors, no ONNX)
//!   revision 5c38ec7c405ec4b44b94cc5a9bb96e735b38267a
//!   model.safetensors  133,466,304 bytes
//!     sha256 3c9f31665447c8911517620762200d2245a2518d6e7208acc78cd9db317e21ad
//!   tokenizer.json      711,396 bytes
//!     sha256 d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66
//!   config.json             743 bytes
//!     sha256 094f8e891b932f2000c92cfc663bac4c62069f5d8af5b5278c4306aef3084750
//!
//! One command, `embed_texts(model_dir, batch) -> Vec<Vec<f32>>`: the
//! frontend owns everything else (doc selection, batching cadence,
//! storage in thread_vectors, cosine ranking — design D1's split: Rust
//! computes, the frontend owns storage and SQL). Batching here is one
//! padded forward pass per call: encode with 512-token truncation, pad
//! to the batch's longest sequence, mean-pool the token embeddings over
//! the attention mask, then L2-normalize. The upstream BGE repo ships a
//! CLS-pooling config in `1_Pooling`, but every vector this app produces
//! — documents AND queries — goes through THIS one pooling path, so the
//! cosine ranking is self-consistent either way (mean pooling is the
//! documented choice, parity-round-3 task 6.1).
//!
//! Determinism: candle's BertModel runs in eval mode by construction
//! (its Dropout module is an identity op outside training), inference is
//! fixed-shape CPU float math, and no seed-sensitive sampling exists on
//! the path — the same text always yields the same vector (asserted by
//! the real-model test below).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use candle_core::{Device, Tensor};
use candle_transformers::models::bert::{BertModel, Config, DTYPE};
use serde::Serialize;
use tokenizers::Tokenizer;

/// Embedding dimensionality of BGE-small-en-v1.5 (migration v21's
/// thread_vectors.dim expectation).
pub const EMBED_DIM: usize = 384;

/// Per-document truncation budget in tokens (the model's
/// max_position_embeddings; D1's "512-token budget").
pub const MAX_TOKENS: usize = 512;

/// Upper bound on one call's batch — the frontend batches at 32; a
/// bigger ask is a caller bug, not a workload.
const MAX_BATCH: usize = 64;

// ---------- Command error ----------

/// Typed error for `embed_texts` — the `kind` string is stable so the TS
/// layer can branch without parsing prose (the model_downloads module's
/// precedent). `model_missing` (files not downloaded yet) is the one
/// kind the frontend is expected to see in production: it means "index
/// enabled but the model is gone" and degrades to a no-op, never an
/// error surface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingError {
    kind: String,
    message: String,
}

impl EmbeddingError {
    fn model_missing(message: String) -> Self {
        Self { kind: "model_missing".into(), message }
    }

    fn io(message: String) -> Self {
        Self { kind: "io".into(), message }
    }

    fn config(message: String) -> Self {
        Self { kind: "config".into(), message }
    }

    fn tokenizer(message: String) -> Self {
        Self { kind: "tokenizer".into(), message }
    }

    fn model_load(message: String) -> Self {
        Self { kind: "model_load".into(), message }
    }

    fn inference(message: String) -> Self {
        Self { kind: "inference".into(), message }
    }
}

impl std::fmt::Display for EmbeddingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for EmbeddingError {}

// ---------- The engine ----------

/// The loaded BGE model + tokenizer pair. Built once per model directory
/// and cached (see [`engine_for`]): loading mmaps ~133 MB of safetensors
/// and builds the layer stack, far too slow to repeat per call.
struct EmbeddingEngine {
    tokenizer: Tokenizer,
    model: BertModel,
    device: Device,
}

impl EmbeddingEngine {
    /// Load the three pinned files out of `model_dir` (the directory the
    /// frontend's download flow manages). Missing files are the expected
    /// `model_missing` failure; unreadable/corrupt ones get their own
    /// kinds so a bad download surfaces distinctly from an absent one.
    fn load(model_dir: &Path) -> Result<Self, EmbeddingError> {
        let tokenizer_path = model_dir.join("tokenizer.json");
        let config_path = model_dir.join("config.json");
        let model_path = model_dir.join("model.safetensors");
        for path in [&tokenizer_path, &config_path, &model_path] {
            if !path.is_file() {
                return Err(EmbeddingError::model_missing(format!(
                    "model file {} is not present — download the model first",
                    path.display()
                )));
            }
        }

        let mut tokenizer = Tokenizer::from_file(&tokenizer_path).map_err(|error| {
            EmbeddingError::tokenizer(format!(
                "load {}: {error}",
                tokenizer_path.display()
            ))
        })?;
        tokenizer
            .with_truncation(Some(tokenizers::tokenizer::TruncationParams {
                max_length: MAX_TOKENS,
                ..Default::default()
            }))
            .map_err(|error| {
                EmbeddingError::tokenizer(format!("set truncation: {error}"))
            })?;

        let config: Config = serde_json::from_str(
            &std::fs::read_to_string(&config_path).map_err(|error| {
                EmbeddingError::io(format!("read {}: {error}", config_path.display()))
            })?
        )
        .map_err(|error| {
            EmbeddingError::config(format!(
                "parse {}: {error}",
                config_path.display()
            ))
        })?;

        let device = Device::Cpu;
        let vb = unsafe {
            candle_nn::VarBuilder::from_mmaped_safetensors(
                std::slice::from_ref(&model_path),
                DTYPE,
                &device,
            )
        }
        .map_err(|error| {
            EmbeddingError::model_load(format!(
                "load {}: {error}",
                model_path.display()
            ))
        })?;
        let model = BertModel::load(vb, &config).map_err(|error| {
            EmbeddingError::model_load(format!("build BertModel: {error}"))
        })?;
        Ok(Self { tokenizer, model, device })
    }

    /// Embed one batch: tokenize (512-token truncation), pad to the
    /// longest sequence, one forward pass, masked mean-pool, L2-normalize.
    fn embed(&self, batch: &[String]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        if batch.is_empty() {
            return Ok(Vec::new());
        }
        let encodings = self
            .tokenizer
            .encode_batch(batch.to_vec(), true)
            .map_err(|error| {
                EmbeddingError::tokenizer(format!("encode batch: {error}"))
            })?;
        let longest = encodings
            .iter()
            .map(|encoding| encoding.get_ids().len())
            .max()
            .unwrap_or(0);
        let mut input_ids = Vec::with_capacity(batch.len() * longest);
        let mut attention_mask = Vec::with_capacity(batch.len() * longest);
        // BERT's [PAD] id (config.json pad_token_id for every BGE model).
        const PAD_ID: u32 = 0;
        for encoding in &encodings {
            let ids = encoding.get_ids();
            let mask = encoding.get_attention_mask();
            input_ids.extend_from_slice(ids);
            attention_mask.extend_from_slice(mask);
            for _ in ids.len()..longest {
                input_ids.push(PAD_ID);
                attention_mask.push(0);
            }
        }
        let shape = (batch.len(), longest);
        let input_ids = Tensor::new(&input_ids[..], &self.device)
            .and_then(|tensor| tensor.reshape(shape))
            .map_err(|error| EmbeddingError::inference(format!("input ids: {error}")))?;
        let attention_mask = Tensor::new(&attention_mask[..], &self.device)
            .and_then(|tensor| tensor.reshape(shape))
            .map_err(|error| {
                EmbeddingError::inference(format!("attention mask: {error}"))
            })?;
        let token_type_ids = Tensor::zeros(shape, candle_core::DType::U32, &self.device)
            .map_err(|error| {
                EmbeddingError::inference(format!("token type ids: {error}"))
            })?;
        // (batch, seq, hidden) token embeddings.
        let sequence_output = self
            .model
            .forward(&input_ids, &token_type_ids, Some(&attention_mask))
            .map_err(|error| EmbeddingError::inference(format!("forward: {error}")))?;
        let rows = mean_pool_and_normalize(&sequence_output, &attention_mask)
            .map_err(|error| EmbeddingError::inference(format!("pool: {error}")))?;
        debug_assert!(
            rows.iter().all(|row| row.len() == EMBED_DIM),
            "the pooled rows must carry the model's dimensionality"
        );
        Ok(rows)
    }
}

/// Masked mean pooling over the sequence dimension, then L2-normalize
/// each row to unit length (the task-6.1 recipe): sum the token
/// embeddings weighted by the attention mask, divide by the real-token
/// count, scale to norm 1 — so cosine similarity is a plain dot product
/// downstream (the TS loader exploits that, task 6.3).
fn mean_pool_and_normalize(
    sequence_output: &Tensor,
    attention_mask: &Tensor,
) -> candle_core::Result<Vec<Vec<f32>>> {
    let mask = attention_mask
        .to_dtype(candle_core::DType::F32)?
        .unsqueeze(2)?; // (batch, seq, 1)
    let summed = sequence_output.broadcast_mul(&mask)?.sum(1)?; // (batch, hidden)
    let counts = mask.sum(1)?; // (batch, 1)
    let pooled = summed.broadcast_div(&counts)?;
    // Epsilon-guarded L2 norm: a degenerate all-zero pool (never produced
    // by the real model, but cheap to keep finite) divides by ~1e-12 and
    // stays zeros instead of NaN.
    let norms = pooled.sqr()?.sum_keepdim(1)?; // (batch, 1)
    // affine(1, eps) is candle's scalar add: norm + 1e-12 keeps a
    // degenerate all-zero pool finite (zeros out) instead of NaN.
    let eps = norms.affine(1.0, 1e-12)?;
    let normalized = pooled.broadcast_div(&eps.sqrt()?)?;
    normalized.to_vec2::<f32>()
}

// ---------- Engine cache ----------

/// The one loaded engine, keyed by the directory it came from. A changed
/// path (a re-download, a moved models dir) reloads; there is never more
/// than one engine alive. The cache exists because a full load takes
/// seconds — the assistant's semantic_search call would otherwise pay it
/// on every tool use.
static ENGINE: Mutex<Option<(PathBuf, Arc<EmbeddingEngine>)>> = Mutex::new(None);

fn engine_for(model_dir: &Path) -> Result<Arc<EmbeddingEngine>, EmbeddingError> {
    let mut guard = ENGINE
        .lock()
        .map_err(|_| EmbeddingError::inference("engine cache poisoned".into()))?;
    match guard.as_ref() {
        Some((path, engine)) if path == model_dir => Ok(engine.clone()),
        _ => {
            let engine = Arc::new(EmbeddingEngine::load(model_dir)?);
            *guard = Some((model_dir.to_path_buf(), engine.clone()));
            Ok(engine)
        }
    }
}

// ---------- The command ----------

/// Embed `batch` of texts with the pinned BGE-small-en-v1.5 model stored
/// in `model_dir` (the frontend-managed download target). Returns one
/// 384-dim, L2-normalized vector per input, order preserved. An empty
/// batch resolves without touching the model. Deterministic: identical
/// inputs yield identical vectors (eval mode, CPU float math).
#[tauri::command]
pub async fn embed_texts(
    model_dir: String,
    batch: Vec<String>,
) -> Result<Vec<Vec<f32>>, EmbeddingError> {
    if batch.is_empty() {
        return Ok(Vec::new());
    }
    if batch.len() > MAX_BATCH {
        return Err(EmbeddingError::config(format!(
            "batch of {} exceeds the {} document cap — split it",
            batch.len(),
            MAX_BATCH
        )));
    }
    if model_dir.trim().is_empty() {
        return Err(EmbeddingError::config(
            "model_dir must name the downloaded model directory".into(),
        ));
    }
    // Load + resolve the engine off the async runtime's IO threads, then
    // run the (multi-second-capable) forward pass as blocking work.
    let dir = PathBuf::from(model_dir);
    let engine = tokio::task::spawn_blocking(move || engine_for(&dir))
        .await
        .map_err(|error| {
            EmbeddingError::inference(format!("engine task failed: {error}"))
        })??;
    tokio::task::spawn_blocking(move || {
        let engine = engine;
        engine.embed(&batch)
    })
    .await
    .map_err(|error| {
        EmbeddingError::inference(format!("embedding task failed: {error}"))
    })?
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    /// Compile-and-link proof for the whole candle stack (the placeholder
    /// module's original guarantee, kept): a tensor roundtrip through the
    /// CPU device fails the build if the resolved crate set is mutually
    /// incompatible.
    #[test]
    fn candle_tensor_roundtrip_on_cpu() {
        let tensor =
            candle_core::Tensor::new(&[[1.0f32, 2.0]], &candle_core::Device::Cpu).unwrap();
        assert_eq!(tensor.dims2().unwrap(), (1, 2));
        let rows = tensor.to_vec2::<f32>().unwrap();
        assert_eq!(rows, vec![vec![1.0, 2.0]]);
    }

    #[test]
    fn tokenizers_reject_non_json_definitions() {
        // No model files needed: a garbage definition must yield Err.
        assert!(tokenizers::Tokenizer::from_bytes(b"not a tokenizer").is_err());
    }

    #[test]
    fn hf_hub_api_builder_constructs_offline() {
        // Builder construction touches neither network nor cache — enough
        // to prove the crate links under the `tokio` async feature.
        let _api = hf_hub::api::tokio::ApiBuilder::new();
    }

    #[test]
    fn empty_batch_resolves_without_a_model() {
        // The cheap no-op path must not require (or load) any files.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let vectors = runtime
            .block_on(embed_texts("/nonexistent".into(), Vec::new()))
            .unwrap();
        assert!(vectors.is_empty());
    }

    #[test]
    fn oversized_batch_is_a_config_error() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let batch = vec!["text".into(); MAX_BATCH + 1];
        let error = runtime
            .block_on(embed_texts("/nonexistent".into(), batch))
            .unwrap_err();
        assert_eq!(error.kind, "config");
    }

    #[test]
    fn blank_model_dir_is_a_config_error() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let error = runtime
            .block_on(embed_texts("   ".into(), vec!["text".into()]))
            .unwrap_err();
        assert_eq!(error.kind, "config");
    }

    #[test]
    fn missing_model_files_give_the_typed_model_missing_error() {
        // The expected production failure before the model is downloaded:
        // a directory that does not exist (or lacks the three files) must
        // surface as kind "model_missing", never a panic or prose error.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let error = runtime
            .block_on(embed_texts(
                std::env::temp_dir().join("emailer-absent-model").into_os_string()
                    .to_string_lossy()
                    .to_string(),
                vec!["hello".into()],
            ))
            .unwrap_err();
        assert_eq!(error.kind, "model_missing");
    }

    #[test]
    fn mean_pool_and_normalize_unit_lengths_and_mask_respect() {
        // (batch=2, seq=3, hidden=2); row 1's last token is masked out.
        let sequence_output = candle_core::Tensor::new(
            &[
                [[3.0f32, 4.0], [0.0, 0.0], [0.0, 0.0]],
                [[1.0, 0.0], [0.0, 2.0], [100.0, -100.0]],
            ],
            &candle_core::Device::Cpu,
        )
        .unwrap();
        let attention_mask =
            candle_core::Tensor::new(&[[1u32, 0, 0], [1, 1, 0]], &candle_core::Device::Cpu)
                .unwrap();
        let rows = mean_pool_and_normalize(&sequence_output, &attention_mask).unwrap();
        assert_eq!(rows.len(), 2);
        // Row 0: only the first token counts → (3,4) normalized.
        assert!((rows[0][0] - 0.6).abs() < 1e-6);
        assert!((rows[0][1] - 0.8).abs() < 1e-6);
        // Row 1: (1,0)+(0,2) = (1,2) normalized; the masked garbage token
        // contributed nothing.
        let norm = (rows[1][0] * rows[1][0] + rows[1][1] * rows[1][1]).sqrt();
        assert!((norm - 1.0).abs() < 1e-6);
        assert!((rows[1][0] - 1.0 / 5.0f32.sqrt()).abs() < 1e-6);
    }

    #[test]
    fn mean_pool_and_normalize_zero_vector_does_not_nan() {
        // An all-zero row (degenerate) must not produce NaNs.
        let sequence_output = candle_core::Tensor::new(
            &[[[0.0f32, 0.0], [0.0, 0.0]]],
            &candle_core::Device::Cpu,
        )
        .unwrap();
        let attention_mask =
            candle_core::Tensor::new(&[[1u32, 1]], &candle_core::Device::Cpu).unwrap();
        let rows = mean_pool_and_normalize(&sequence_output, &attention_mask).unwrap();
        assert!(rows[0].iter().all(|value| value.is_finite()));
    }

    #[test]
    fn embed_error_displays_kind_and_message() {
        let error = EmbeddingError::model_missing("gone".into());
        assert_eq!(error.to_string(), "model_missing: gone");
    }

    /// The REAL engine against the REAL pinned model. Ignored by default:
    /// it needs the ~127 MB model downloaded (point EMAILER_BGE_MODEL_DIR
    /// at a directory holding the pinned tokenizer.json, config.json and
    /// model.safetensors — e.g. the app's models directory) and CI must
    /// not fetch 127 MB to run unit tests; the frontend contract tests
    /// carry the rest.
    #[test]
    #[ignore = "needs EMAILER_BGE_MODEL_DIR pointing at the downloaded BGE model"]
    fn real_model_embeds_deterministically_and_truncates() {
        let dir = std::env::var("EMAILER_BGE_MODEL_DIR")
            .expect("set EMAILER_BGE_MODEL_DIR to the model directory");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();

        let batch = vec![
            "The venue coordinator confirmed the deposit is due Friday".into(),
            "Deposits for the venue must be paid by end of week".into(),
            "Quarterly sales figures exceeded the forecast".into(),
            // Long document: exercises the 512-token truncation.
            "invoice payment ".repeat(4000),
        ];
        let first = runtime
            .block_on(embed_texts(dir.clone(), batch.clone()))
            .unwrap();
        assert_eq!(first.len(), batch.len());
        for vector in &first {
            assert_eq!(vector.len(), EMBED_DIM);
            let norm: f32 = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
            assert!((norm - 1.0).abs() < 1e-4, "unit norm, got {norm}");
        }
        // Determinism: the same batch again yields identical vectors.
        let second = runtime.block_on(embed_texts(dir, batch)).unwrap();
        assert_eq!(first, second);
        // Meaning-based similarity: the two deposit sentences rank above
        // the unrelated sales sentence against the venue query.
        let dot = |a: &[f32], b: &[f32]| -> f32 {
            a.iter().zip(b).map(|(x, y)| x * y).sum()
        };
        let related = dot(&first[0], &first[1]);
        let unrelated = dot(&first[0], &first[2]);
        assert!(
            related > unrelated,
            "cosine {related} should exceed {unrelated}"
        );
        // The truncated document still produced a finite unit vector.
        assert!(first[3].iter().all(|value| value.is_finite()));
    }
}
