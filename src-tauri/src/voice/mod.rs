//! Local voice dictation (parity-round-3 design D3, task 7.1).
//!
//! Compiled only behind the `voice` Cargo feature (ON by default):
//! whisper-rs runs the ggml-base multilingual model (~148 MB, CPU only —
//! the design's explicit non-goal is GPU acceleration) downloaded through
//! the shared pinned downloader (task 1.4) into an app-managed directory
//! whose path THIS module receives from the caller, mirroring the
//! embeddings module (design D1's split: Rust computes, the frontend owns
//! storage and every SQL statement).
//!
//! Pinned model (documented per the 1.4 contract; verified 2026-10-04 by
//! downloading the revision and hashing the file locally):
//!   repo     ggerganov/whisper.cpp (official whisper.cpp models)
//!   revision 5359861c739e955e79d9a303bcbc70fb988958b1
//!   ggml-base.bin      147,951,465 bytes (~148 MB, multilingual)
//!     sha256 60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe
//!
//! One command, `transcribe(model_dir, path, language_hint)`:
//! `path` is a 16 kHz mono float32 WAV file the frontend wrote through
//! the fs plugin (MediaRecorder audio → WebAudio decode → resample →
//! WAV encode), `language_hint` is an ISO code ("" = auto-detect). The
//! result is `{text, language}` — `language` the ISO code whisper resolved
//! (detected or pinned). Audio never leaves the machine: whisper.cpp runs
//! in-process; the only network touch is the model download itself.
//!
//! The loaded context is cached per model directory (see [`engine_for`]):
//! loading mmaps ~148 MB of ggml weights, far too slow to repeat per
//! utterance. Both the (cached) load and the (multi-second-capable)
//! inference run as blocking work off the async runtime, exactly like the
//! embeddings module's `embed_texts`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use whisper_rs::{
    get_lang_str, FullParams, SamplingStrategy, WhisperContext,
    WhisperContextParameters,
};

/// The sample rate the whole dictation pipeline speaks (the frontend's
/// resampler targets it; whisper.cpp expects exactly this).
pub const SAMPLE_RATE_HZ: u32 = 16_000;

/// The model file the engine loads out of `model_dir` — the single file
/// the pinned download flow deposits there (task 1.4; see the module doc
/// for the pinned revision + SHA-256).
pub const MODEL_FILENAME: &str = "ggml-base.bin";

// ---------- Command error ----------

/// Typed error for `transcribe` — the `kind` string is stable so the TS
/// layer can branch without parsing prose (the model_downloads module's
/// precedent). `model_missing` (files not downloaded yet) is the one kind
/// the frontend is expected to see in production: the dictation button
/// routes to the first-use download flow on it, never to an error toast.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceError {
    kind: String,
    message: String,
}

impl VoiceError {
    fn model_missing(message: String) -> Self {
        Self { kind: "model_missing".into(), message }
    }

    fn model_load(message: String) -> Self {
        Self { kind: "model_load".into(), message }
    }

    fn inference(message: String) -> Self {
        Self { kind: "inference".into(), message }
    }

    fn io(message: String) -> Self {
        Self { kind: "io".into(), message }
    }

    fn config(message: String) -> Self {
        Self { kind: "config".into(), message }
    }
}

impl std::fmt::Display for VoiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for VoiceError {}

// ---------- The command result ----------

/// One transcription: the recognized text (possibly empty — silence
/// transcribes to "") and the ISO language code whisper resolved
/// (auto-detected when no hint was given).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub text: String,
    pub language: String,
}

// ---------- WAV reading ----------

/// Minimal RIFF/WAVE reader for EXACTLY the file the frontend writes:
/// one `fmt ` chunk (IEEE float, mono, 16 kHz) + one `data` chunk of
/// little-endian f32 samples. Anything else is a contract violation and
/// gets its own typed error — a wrong format must never silently
/// transcribe garbage (a 44.1 kHz file read as 16 kHz would come out as
/// slowed-down nonsense).
///
/// Chunk walking (not fixed offsets) because writers legitimately pad
/// chunks to even lengths and may prepend metadata chunks; the parser
/// skips anything it does not know.
#[derive(Debug)]
struct WavAudio {
    samples: Vec<f32>,
}

fn read_wav_f32_mono(path: &Path) -> Result<WavAudio, VoiceError> {
    let bytes = std::fs::read(path).map_err(|error| {
        VoiceError::io(format!("read {}: {error}", path.display()))
    })?;

    const HEADER: usize = 12; // "RIFF" + size + "WAVE"
    if bytes.len() < HEADER || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(VoiceError::io(format!(
            "{} is not a RIFF/WAVE file",
            path.display()
        )));
    }

    // Walk the chunk list: 4-byte id, 4-byte little-endian size, payload
    // (padded to even length).
    let mut format: Option<(u16, u16, u32)> = None; // (audio_format, channels, sample_rate)
    let mut data: Option<&[u8]> = None;
    let mut offset = HEADER;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(
            bytes[offset + 4..offset + 8]
                .try_into()
                .expect("slice of exactly 4 bytes"),
        ) as usize;
        let payload_start = offset + 8;
        let payload_end = payload_start.checked_add(size).ok_or_else(|| {
            VoiceError::io("wav chunk size overflows the file".to_string())
        })?;
        if payload_end > bytes.len() {
            return Err(VoiceError::io(format!(
                "wav chunk {} truncated ({} of {} bytes)",
                String::from_utf8_lossy(id),
                bytes.len() - payload_start,
                size
            )));
        }
        match id {
            b"fmt " => {
                if size < 16 {
                    return Err(VoiceError::io(
                        "wav fmt chunk shorter than 16 bytes".to_string(),
                    ));
                }
                let audio_format =
                    u16::from_le_bytes(bytes[payload_start..payload_start + 2].try_into().expect("2 bytes"));
                let channels =
                    u16::from_le_bytes(bytes[payload_start + 2..payload_start + 4].try_into().expect("2 bytes"));
                let sample_rate = u32::from_le_bytes(
                    bytes[payload_start + 4..payload_start + 8].try_into().expect("4 bytes"),
                );
                format = Some((audio_format, channels, sample_rate));
            }
            b"data" => data = Some(&bytes[payload_start..payload_end]),
            _ => {}
        }
        // Chunks pad to even lengths; the pad byte belongs to this chunk.
        offset = payload_end + (size % 2);
    }

    let (audio_format, channels, sample_rate) = format.ok_or_else(|| {
        VoiceError::io("wav file carries no fmt chunk".to_string())
    })?;
    // 3 = WAVE_FORMAT_IEEE_FLOAT (the frontend's encoder writes exactly
    // this; 16-bit PCM or anything else is a writer bug, rejected here).
    if audio_format != 3 {
        return Err(VoiceError::io(format!(
            "wav format tag {audio_format} is not IEEE float (3) — the dictation writer must emit float32"
        )));
    }
    if channels != 1 {
        return Err(VoiceError::config(format!(
            "wav carries {channels} channels — dictation must be mono"
        )));
    }
    if sample_rate != SAMPLE_RATE_HZ {
        return Err(VoiceError::config(format!(
            "wav sample rate {sample_rate} != {SAMPLE_RATE_HZ} — the resampler must target 16 kHz"
        )));
    }
    let data = data
        .ok_or_else(|| VoiceError::io("wav file carries no data chunk".to_string()))?;
    if data.len() % 4 != 0 {
        return Err(VoiceError::io(format!(
            "wav data chunk of {} bytes is not a whole number of f32 samples",
            data.len()
        )));
    }
    let samples = data
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("4 bytes")))
        .collect();
    Ok(WavAudio { samples })
}

// ---------- The engine ----------

/// The loaded whisper.cpp context. Built once per model directory and
/// cached (see [`engine_for`]): loading mmaps ~148 MB of ggml weights
/// and builds the decoder, far too slow to repeat per utterance. A
/// per-call `WhisperState` carries the mutable inference scratch — the
/// context itself is shared read-only (`create_state(&self)`), so one
/// cached engine serves utterances back to back.
struct TranscriptionEngine {
    context: WhisperContext,
}

impl TranscriptionEngine {
    /// Load the pinned model file out of `model_dir` (the directory the
    /// frontend's download flow manages). A missing file is the expected
    /// `model_missing` failure; an unreadable/corrupt one gets its own
    /// kind so a bad download surfaces distinctly from an absent one.
    fn load(model_dir: &Path) -> Result<Self, VoiceError> {
        let model_path = model_dir.join(MODEL_FILENAME);
        if !model_path.is_file() {
            return Err(VoiceError::model_missing(format!(
                "model file {} is not present — download the model first",
                model_path.display()
            )));
        }
        // CPU only (design D3 non-goal: no GPU acceleration); defaults
        // are exactly that.
        let context = WhisperContext::new_with_params(
            model_path.to_string_lossy().as_ref(),
            WhisperContextParameters::default(),
        )
        .map_err(|error| {
            VoiceError::model_load(format!(
                "load {}: {error}",
                model_path.display()
            ))
        })?;
        Ok(Self { context })
    }

    /// Transcribe one utterance: greedy decoding (dictation wants the
    /// fast path, not beam search), the hint pinned or auto-detect when
    /// empty, all console printing silenced (whisper.cpp would otherwise
    /// spew progress lines into the app's stdout), no prior context
    /// carried between utterances (each dictation stands alone).
    fn transcribe(
        &self,
        samples: &[f32],
        language_hint: &str,
    ) -> Result<TranscriptionResult, VoiceError> {
        let mut state = self
            .context
            .create_state()
            .map_err(|error| VoiceError::inference(format!("create state: {error}")))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        let hint = language_hint.trim();
        // "auto" is whisper.cpp's auto-detect sentinel — the empty hint's
        // documented mapping (design D3: explicit setting defaulting to
        // auto-detect).
        params.set_language(Some(if hint.is_empty() { "auto" } else { hint }));
        params.set_no_context(true);
        params.set_print_progress(false);
        params.set_print_special(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        state
            .full(params, samples)
            .map_err(|error| VoiceError::inference(format!("run transcription: {error}")))?;

        let segment_count = state
            .full_n_segments()
            .map_err(|error| VoiceError::inference(format!("segment count: {error}")))?;
        let mut text = String::new();
        for segment in 0..segment_count {
            let piece = state
                .full_get_segment_text_lossy(segment)
                .map_err(|error| {
                    VoiceError::inference(format!("segment {segment} text: {error}"))
                })?;
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(piece.trim());
        }

        // The language whisper resolved: the pinned hint when given, the
        // detected code otherwise (design D3: the result carries it).
        let lang_id = state
            .full_lang_id_from_state()
            .map_err(|error| VoiceError::inference(format!("language id: {error}")))?;
        let language = get_lang_str(lang_id).unwrap_or("unknown").to_string();

        Ok(TranscriptionResult {
            text: text.trim().to_string(),
            language,
        })
    }
}

// ---------- Engine cache ----------

/// The one loaded engine, keyed by the directory it came from. A changed
/// path (a re-download, a moved models dir) reloads; there is never more
/// than one engine alive. The cache exists because a full load takes
/// seconds — dictation would otherwise pay it on every utterance (the
/// embeddings module's [`embeddings::engine_for`] pattern).
static ENGINE: Mutex<Option<(PathBuf, Arc<TranscriptionEngine>)>> = Mutex::new(None);

fn engine_for(model_dir: &Path) -> Result<Arc<TranscriptionEngine>, VoiceError> {
    let mut guard = ENGINE
        .lock()
        .map_err(|_| VoiceError::inference("engine cache poisoned".into()))?;
    match guard.as_ref() {
        Some((path, engine)) if path == model_dir => Ok(engine.clone()),
        _ => {
            let engine = Arc::new(TranscriptionEngine::load(model_dir)?);
            *guard = Some((model_dir.to_path_buf(), engine.clone()));
            Ok(engine)
        }
    }
}

// ---------- The command ----------

/// Transcribe the 16 kHz mono float32 WAV file at `path` with the pinned
/// ggml-base model stored in `model_dir` (the frontend-managed download
/// target). `language_hint` is an ISO language code ("en", "de", …) or
/// "" for auto-detection. Returns the recognized text and the resolved
/// language code. Audio and transcript stay on this machine.
///
/// Validation order: the audio file is parsed and contract-checked FIRST
/// (a writer bug must not pay a model load to discover), then the engine
/// loads (cache hit = no cost), then inference runs. Both the load and
/// the inference are blocking work off the async runtime's IO threads.
#[tauri::command]
pub async fn transcribe(
    model_dir: String,
    path: String,
    language_hint: String,
) -> Result<TranscriptionResult, VoiceError> {
    if model_dir.trim().is_empty() {
        return Err(VoiceError::config(
            "model_dir must name the downloaded model directory".into(),
        ));
    }
    if path.trim().is_empty() {
        return Err(VoiceError::config(
            "path must name the recorded WAV file".into(),
        ));
    }
    // Parse + validate the audio off-runtime (a ~minutes-long recording
    // is still only a few MB of f32, but disk IO never belongs on the
    // async threads).
    let wav_path = PathBuf::from(path);
    let audio = tokio::task::spawn_blocking(move || read_wav_f32_mono(&wav_path))
        .await
        .map_err(|error| VoiceError::io(format!("read task failed: {error}")))??;
    if audio.samples.is_empty() {
        return Err(VoiceError::config(
            "the recording carries no audio samples".into(),
        ));
    }
    // Load + resolve the engine as blocking work (a cold load is seconds;
    // a cache hit is a map lookup).
    let dir = PathBuf::from(model_dir);
    let engine = tokio::task::spawn_blocking(move || engine_for(&dir))
        .await
        .map_err(|error| VoiceError::inference(format!("engine task failed: {error}")))??;
    tokio::task::spawn_blocking(move || {
        let engine = engine;
        engine.transcribe(&audio.samples, &language_hint)
    })
    .await
    .map_err(|error| VoiceError::inference(format!("transcription task failed: {error}")))?
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    /// Little-endian f32 → bytes.
    fn f32_le(value: f32) -> [u8; 4] {
        value.to_le_bytes()
    }

    /// Build the exact WAV the frontend's dictation writer emits:
    /// 44-byte canonical header, IEEE float, mono, 16 kHz, `samples`.
    fn wav_f32_mono_16k(samples: &[f32]) -> Vec<u8> {
        let data_len = (samples.len() * 4) as u32;
        let mut out = Vec::with_capacity(44 + data_len as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
        out.extend_from_slice(&1u16.to_le_bytes()); // mono
        out.extend_from_slice(&SAMPLE_RATE_HZ.to_le_bytes());
        out.extend_from_slice(&(SAMPLE_RATE_HZ * 4).to_le_bytes()); // byte rate
        out.extend_from_slice(&4u16.to_le_bytes()); // block align
        out.extend_from_slice(&32u16.to_le_bytes()); // bits per sample
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        for sample in samples {
            out.extend_from_slice(&f32_le(*sample));
        }
        out
    }

    fn write_wav(dir: &Path, name: &str, samples: &[f32]) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, wav_f32_mono_16k(samples)).unwrap();
        path
    }

    #[test]
    fn wav_reader_parses_the_frontend_shape() {
        let dir =
            std::env::temp_dir().join(format!("emailer-voice-parse-{}", std::process::id()));
        let path = write_wav(&dir, "ok.wav", &[0.0, 0.5, -0.5, 1.0]);
        let audio = read_wav_f32_mono(&path).unwrap();
        assert_eq!(audio.samples, vec![0.0, 0.5, -0.5, 1.0]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wav_reader_tolerates_an_extra_metadata_chunk_and_pad_byte() {
        // "LIST" chunk with an ODD payload size: the pad byte must be
        // skipped, not read as the data header (a fixed-offset parser
        // would fail here; writers legitimately emit odd LIST/INFO).
        let mut bytes = wav_f32_mono_16k(&[1.0]);
        // Splice a LIST chunk in after the 12-byte RIFF header.
        let mut spliced = bytes[..12].to_vec();
        spliced.extend_from_slice(b"LIST");
        spliced.extend_from_slice(&3u32.to_le_bytes()); // odd size
        spliced.extend_from_slice(b"INF");
        spliced.push(0); // pad byte
        spliced.extend_from_slice(&bytes[12..]);
        bytes = spliced;
        let dir =
            std::env::temp_dir().join(format!("emailer-voice-list-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("padded.wav");
        std::fs::write(&path, &bytes).unwrap();
        let audio = read_wav_f32_mono(&path).unwrap();
        assert_eq!(audio.samples, vec![1.0]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wav_reader_rejects_non_wav_and_truncated_files_as_io() {
        let dir =
            std::env::temp_dir().join(format!("emailer-voice-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Not a WAV at all.
        let garbage = dir.join("garbage.wav");
        std::fs::write(&garbage, b"definitely not a wav file").unwrap();
        assert_eq!(read_wav_f32_mono(&garbage).unwrap_err().kind, "io");
        // A WAV header cut off mid-data.
        let truncated = dir.join("truncated.wav");
        let full = wav_f32_mono_16k(&[0.0; 100]);
        std::fs::write(&truncated, &full[..full.len() - 40]).unwrap();
        assert_eq!(read_wav_f32_mono(&truncated).unwrap_err().kind, "io");
        // A WAV with no data chunk.
        let no_data = dir.join("nodata.wav");
        std::fs::write(&no_data, &full[..44]).unwrap();
        assert_eq!(read_wav_f32_mono(&no_data).unwrap_err().kind, "io");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wav_reader_rejects_non_float_formats_and_non_mono_as_contract_bugs() {
        let dir =
            std::env::temp_dir().join(format!("emailer-voice-contract-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 16-bit PCM (format tag 1) — the classic recorder output the
        // writer must NOT emit.
        let mut pcm = wav_f32_mono_16k(&[0.0]);
        pcm[20..22].copy_from_slice(&1u16.to_le_bytes()); // audio_format
        let pcm_path = dir.join("pcm.wav");
        std::fs::write(&pcm_path, &pcm).unwrap();
        assert_eq!(read_wav_f32_mono(&pcm_path).unwrap_err().kind, "io");
        // Stereo float — a resampler bug.
        let mut stereo = wav_f32_mono_16k(&[0.0]);
        stereo[22..24].copy_from_slice(&2u16.to_le_bytes()); // channels
        let stereo_path = dir.join("stereo.wav");
        std::fs::write(&stereo_path, &stereo).unwrap();
        assert_eq!(read_wav_f32_mono(&stereo_path).unwrap_err().kind, "config");
        // Wrong sample rate — a resampler bug.
        let mut rate = wav_f32_mono_16k(&[0.0]);
        rate[24..28].copy_from_slice(&44_100u32.to_le_bytes());
        let rate_path = dir.join("rate.wav");
        std::fs::write(&rate_path, &rate).unwrap();
        assert_eq!(read_wav_f32_mono(&rate_path).unwrap_err().kind, "config");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn blank_model_dir_is_a_config_error() {
        let dir =
            std::env::temp_dir().join(format!("emailer-voice-cfg-{}", std::process::id()));
        let wav = write_wav(&dir, "a.wav", &[0.0; 16_000]);
        let error = transcribe(
            "   ".into(),
            wav.to_string_lossy().to_string(),
            "".into(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, "config");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn blank_audio_path_is_a_config_error() {
        let error = transcribe("/tmp/x".into(), "  ".into(), "".into())
            .await
            .unwrap_err();
        assert_eq!(error.kind, "config");
    }

    #[tokio::test]
    async fn missing_audio_file_is_a_typed_io_error() {
        // Valid model dir arg, absent WAV: the io error must surface
        // BEFORE any model loading (validation precedes the load).
        let error = transcribe(
            "/nonexistent-model-dir".into(),
            "/nonexistent/dictation.wav".into(),
            "".into(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, "io");
    }

    #[tokio::test]
    async fn malformed_wav_is_a_typed_io_error_without_a_model() {
        let dir =
            std::env::temp_dir().join(format!("emailer-voice-mal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("garbage.wav");
        std::fs::write(&wav, b"not a wav").unwrap();
        let error = transcribe(
            "/nonexistent-model-dir".into(),
            wav.to_string_lossy().to_string(),
            "".into(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, "io");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn absent_model_file_gives_the_typed_model_missing_error() {
        // The expected production failure before the model is downloaded:
        // a valid WAV plus a directory without ggml-base.bin must surface
        // as kind "model_missing", never a panic or prose error.
        let dir =
            std::env::temp_dir().join(format!("emailer-voice-absent-{}", std::process::id()));
        let wav = write_wav(&dir, "a.wav", &[0.0; 16_000]);
        let model_dir = dir.join("absent-model");
        let error = transcribe(
            model_dir.to_string_lossy().to_string(),
            wav.to_string_lossy().to_string(),
            "".into(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, "model_missing");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn voice_error_displays_kind_and_message() {
        let error = VoiceError::model_missing("gone".into());
        assert_eq!(error.to_string(), "model_missing: gone");
    }

    /// The REAL engine against the REAL pinned model. Ignored by default:
    /// it needs the ~148 MB model downloaded (point
    /// EMAILER_WHISPER_MODEL_DIR at a directory holding the pinned
    /// ggml-base.bin — e.g. the app's models directory) and a fixture WAV
    /// at EMAILER_WHISPER_TEST_WAV (16 kHz mono float32); CI must not
    /// fetch 148 MB to run unit tests, and the frontend contract tests
    /// carry the rest.
    #[test]
    #[ignore = "needs EMAILER_WHISPER_MODEL_DIR + EMAILER_WHISPER_TEST_WAV"]
    fn real_model_transcribes_fixture_wav() {
        let model_dir = std::env::var("EMAILER_WHISPER_MODEL_DIR")
            .expect("set EMAILER_WHISPER_MODEL_DIR to the model directory");
        let wav = std::env::var("EMAILER_WHISPER_TEST_WAV")
            .expect("set EMAILER_WHISPER_TEST_WAV to a 16 kHz mono float32 wav");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();

        let result = runtime
            .block_on(transcribe(model_dir.clone(), wav.clone(), "".into()))
            .unwrap();
        // The fixture speaks English; auto-detect must resolve it.
        assert_eq!(result.language, "en");
        assert!(!result.text.trim().is_empty(), "expected real text");
        // A pinned hint returns the same text and the pinned code.
        let pinned = runtime
            .block_on(transcribe(
                model_dir,
                wav,
                "en".into(),
            ))
            .unwrap();
        assert_eq!(pinned.language, "en");
        assert_eq!(pinned.text, result.text);
    }
}
