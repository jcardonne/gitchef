use std::fs::{self, File};
use std::io::{Read, Write};
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;

pub const MODEL_FILENAME: &str = "qwen2.5-coder-0.5b-instruct-q4_k_m.gguf";
pub const MODEL_DOWNLOAD_URL: &str =
    "https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf";
pub const EXPECTED_MODEL_SIZE: u64 = 491_400_064;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddedModelStatus {
    pub installed: bool,
    pub file_size_bytes: u64,
    pub expected_size_bytes: u64,
    pub model_path: String,
    pub downloading: bool,
    pub progress_percent: f32,
    pub bytes_downloaded: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgressEvent {
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    pub progress_percent: f32,
    pub speed_bytes_per_sec: u64,
    pub done: bool,
    pub error: Option<String>,
}

struct DownloadState {
    active: bool,
    cancel_flag: Arc<AtomicBool>,
    bytes_downloaded: u64,
    total_bytes: u64,
    speed_bytes_per_sec: u64,
    last_error: Option<String>,
}

static DOWNLOAD_STATE: LazyLock<Mutex<DownloadState>> = LazyLock::new(|| {
    Mutex::new(DownloadState {
        active: false,
        cancel_flag: Arc::new(AtomicBool::new(false)),
        bytes_downloaded: 0,
        total_bytes: EXPECTED_MODEL_SIZE,
        speed_bytes_per_sec: 0,
        last_error: None,
    })
});

static INFERENCE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Returns the models directory inside the app data directory.
pub fn models_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Msg(format!("No app data dir: {e}")))?
        .join("models");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Returns the full path to the embedded model file.
pub fn model_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(models_dir(app)?.join(MODEL_FILENAME))
}

/// Returns the full path to the partial download file.
pub fn tmp_model_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(models_dir(app)?.join(format!("{MODEL_FILENAME}.tmp")))
}

/// Checks the status of the local embedded model.
pub fn get_status(app: &AppHandle) -> AppResult<EmbeddedModelStatus> {
    let path = model_path(app)?;
    let dl = DOWNLOAD_STATE.lock();

    let (installed, file_size_bytes) = if path.exists() {
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        // Valid if file exists and has non-trivial size
        (size > 1_000_000, size)
    } else {
        (false, 0)
    };

    let progress_percent = if dl.active && dl.total_bytes > 0 {
        (dl.bytes_downloaded as f64 / dl.total_bytes as f64 * 100.0) as f32
    } else if installed {
        100.0
    } else {
        0.0
    };

    Ok(EmbeddedModelStatus {
        installed,
        file_size_bytes,
        expected_size_bytes: EXPECTED_MODEL_SIZE,
        model_path: path.to_string_lossy().to_string(),
        downloading: dl.active,
        progress_percent,
        bytes_downloaded: dl.bytes_downloaded,
        error: dl.last_error.clone(),
    })
}

/// Starts downloading the embedded model in a background thread if not already running.
pub fn start_download(app: &AppHandle) -> AppResult<()> {
    let final_path = model_path(app)?;
    if final_path.exists() {
        let size = fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
        if size > 1_000_000 {
            return Ok(());
        }
    }

    let tmp_path = tmp_model_path(app)?;
    let cancel_flag = Arc::new(AtomicBool::new(false));

    {
        let mut dl = DOWNLOAD_STATE.lock();
        if dl.active {
            return Ok(());
        }
        dl.active = true;
        dl.cancel_flag = Arc::clone(&cancel_flag);
        dl.bytes_downloaded = 0;
        dl.total_bytes = EXPECTED_MODEL_SIZE;
        dl.speed_bytes_per_sec = 0;
        dl.last_error = None;
    }

    let app_clone = app.clone();

    std::thread::spawn(move || {
        let run = || -> AppResult<()> {
            let resp = ureq::get(MODEL_DOWNLOAD_URL)
                .timeout(Duration::from_secs(600))
                .call()
                .map_err(|e| AppError::Msg(format!("Download request failed: {e}")))?;

            let total_bytes = resp
                .header("Content-Length")
                .and_then(|h| h.parse::<u64>().ok())
                .unwrap_or(EXPECTED_MODEL_SIZE);

            {
                let mut dl = DOWNLOAD_STATE.lock();
                dl.total_bytes = total_bytes;
            }

            let mut reader = resp.into_reader();
            let mut writer = File::create(&tmp_path)?;
            let mut buf = [0u8; 64 * 1024];
            let mut downloaded: u64 = 0;
            let mut last_emit = Instant::now();
            let mut bytes_since_last_emit: u64 = 0;

            loop {
                if cancel_flag.load(Ordering::Relaxed) {
                    drop(writer);
                    let _ = fs::remove_file(&tmp_path);
                    return Err(AppError::Msg("Download cancelled by user".into()));
                }

                let n = reader.read(&mut buf)?;
                if n == 0 {
                    break;
                }

                writer.write_all(&buf[..n])?;
                downloaded += n as u64;
                bytes_since_last_emit += n as u64;

                let elapsed = last_emit.elapsed();
                if elapsed >= Duration::from_millis(250) {
                    let speed = (bytes_since_last_emit as f64 / elapsed.as_secs_f64()) as u64;
                    let pct = ((downloaded as f64 / total_bytes as f64) * 100.0) as f32;

                    {
                        let mut dl = DOWNLOAD_STATE.lock();
                        dl.bytes_downloaded = downloaded;
                        dl.speed_bytes_per_sec = speed;
                    }

                    let _ = app_clone.emit(
                        "chef://model-download-progress",
                        DownloadProgressEvent {
                            bytes_downloaded: downloaded,
                            total_bytes,
                            progress_percent: pct.min(100.0),
                            speed_bytes_per_sec: speed,
                            done: false,
                            error: None,
                        },
                    );

                    last_emit = Instant::now();
                    bytes_since_last_emit = 0;
                }
            }

            writer.flush()?;
            drop(writer);

            // Atomically rename tmp file to destination
            fs::rename(&tmp_path, &final_path)?;

            let _ = app_clone.emit(
                "chef://model-download-progress",
                DownloadProgressEvent {
                    bytes_downloaded: downloaded,
                    total_bytes,
                    progress_percent: 100.0,
                    speed_bytes_per_sec: 0,
                    done: true,
                    error: None,
                },
            );

            Ok(())
        };

        let result = run();
        let mut dl = DOWNLOAD_STATE.lock();
        dl.active = false;
        if let Err(ref e) = result {
            let err_msg = e.to_string();
            dl.last_error = Some(err_msg.clone());
            let _ = app_clone.emit(
                "chef://model-download-progress",
                DownloadProgressEvent {
                    bytes_downloaded: dl.bytes_downloaded,
                    total_bytes: dl.total_bytes,
                    progress_percent: 0.0,
                    speed_bytes_per_sec: 0,
                    done: false,
                    error: Some(err_msg),
                },
            );
        }
    });

    Ok(())
}

/// Cancels an in-progress download.
pub fn cancel_download(app: &AppHandle) -> AppResult<()> {
    let mut dl = DOWNLOAD_STATE.lock();
    if dl.active {
        dl.cancel_flag.store(true, Ordering::Relaxed);
        dl.active = false;
    }
    if let Ok(tmp) = tmp_model_path(app) {
        if tmp.exists() {
            let _ = fs::remove_file(tmp);
        }
    }
    Ok(())
}

/// Deletes the local embedded model to free disk space.
pub fn delete_model(app: &AppHandle) -> AppResult<()> {
    cancel_download(app)?;
    let path = model_path(app)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
}

/// Executes local inference with Qwen 2.5 Coder 0.5B via llama.cpp.
pub fn generate(
    app: &AppHandle,
    system_prompt: &str,
    user_prompt: &str,
    temperature: f32,
) -> AppResult<String> {
    let path = model_path(app)?;
    if !path.exists() {
        return Err(AppError::Msg(
            "Chef AI model is not installed. Please click 'Download & Enable' in Settings or the Chef AI prompt to download the 390 MB model.".into(),
        ));
    }

    // Only one inference job runs at a time
    let _inference_guard = INFERENCE_LOCK.lock();

    let mut backend = LlamaBackend::init()
        .map_err(|e| AppError::Msg(format!("Failed to initialize llama backend: {e}")))?;
    backend.void_logs();

    let mut model_params = LlamaModelParams::default();
    // Enable GPU acceleration (Metal on Apple Silicon, or CPU fallback elsewhere)
    model_params = model_params.with_n_gpu_layers(99);

    let model = LlamaModel::load_from_file(&backend, &path, &model_params)
        .map_err(|e| AppError::Msg(format!("Failed to load model from file: {e}")))?;

    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(2048));

    let mut ctx = model
        .new_context(&backend, ctx_params)
        .map_err(|e| AppError::Msg(format!("Failed to create model context: {e}")))?;

    // Qwen 2.5 ChatML format
    let prompt = format!(
        "<|im_start|>system\n{system_prompt}<|im_end|>\n<|im_start|>user\n{user_prompt}<|im_end|>\n<|im_start|>assistant\n"
    );

    let tokens = model
        .str_to_token(&prompt, AddBos::Never)
        .map_err(|e| AppError::Msg(format!("Tokenize error: {e}")))?;

    let n_prompt = tokens.len();
    if n_prompt >= 1800 {
        return Err(AppError::Msg(
            "Prompt exceeds local context window size. Try staging fewer files.".into(),
        ));
    }

    let mut batch = LlamaBatch::new(2048, 1);
    for (i, token) in tokens.iter().enumerate() {
        let is_last = i == n_prompt - 1;
        batch
            .add(*token, i as i32, &[0], is_last)
            .map_err(|e| AppError::Msg(format!("Batch add error: {e}")))?;
    }

    ctx.decode(&mut batch)
        .map_err(|e| AppError::Msg(format!("Decode prompt error: {e}")))?;

    let temp = if temperature <= 0.01 { 0.2 } else { temperature };
    let mut sampler = LlamaSampler::chain_simple([
        LlamaSampler::temp(temp),
        LlamaSampler::top_p(0.95, 1),
        LlamaSampler::greedy(),
    ]);

    let mut output = String::new();
    let mut decoder = encoding_rs::UTF_8.new_decoder();
    let mut current_pos = n_prompt as i32;
    let max_new_tokens = 512;

    for _ in 0..max_new_tokens {
        let token = sampler.sample(&ctx, batch.n_tokens() - 1);
        sampler.accept(token);

        if model.is_eog_token(token) {
            break;
        }

        let piece = model
            .token_to_piece(token, &mut decoder, false, None)
            .unwrap_or_default();
        output.push_str(&piece);

        batch.clear();
        batch
            .add(token, current_pos, &[0], true)
            .map_err(|e| AppError::Msg(format!("Batch add step error: {e}")))?;
        ctx.decode(&mut batch)
            .map_err(|e| AppError::Msg(format!("Decode step error: {e}")))?;
        current_pos += 1;
    }

    Ok(output.trim().to_string())
}
