use image::ImageEncoder;
use rayon::prelude::*;
use serde::Serialize;
use std::fs;
use std::panic::catch_unwind;
use std::path::PathBuf;
use tauri::Emitter;

#[cfg(target_os = "macos")]
use trash::macos::{DeleteMethod, TrashContextExtMacos};

// Progress payload sent to the frontend over Tauri events so each file's
// progress bar can update independently as it finishes.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileProgress {
    index: usize,
    result: CompressionResult,
}

// Everything the UI needs to show per-file results. Sent both as an event
// (during compression) and as the final return value (when all files are done).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompressionResult {
    path: String,
    name: String,
    original_size: u64,
    compressed_size: u64,
    savings_percent: f64,
    success: bool,
    error: Option<String>,
}

// Main entry point from the frontend. Files are compressed in parallel via rayon
// inside a blocking task so we don't choke Tauri's async runtime. Each file fires
// a progress event as it finishes — the UI picks these up to update individual bars.
#[tauri::command]
async fn compress_images(
    app: tauri::AppHandle,
    file_paths: Vec<String>,
    output_format: String,
    quality: u8,
) -> Result<Vec<CompressionResult>, String> {
    tokio::task::spawn_blocking(move || -> Vec<CompressionResult> {
        let mut indexed: Vec<(usize, CompressionResult)> = file_paths
            .par_iter()
            .enumerate()
            .map(|(i, p)| {
                let result = compress_single(p, &output_format, quality);
                let _ = app.emit(
                    "compression-progress",
                    FileProgress {
                        index: i,
                        result: result.clone(),
                    },
                );
                (i, result)
            })
            .collect();
        // rayon doesn't guarantee order, so sort before returning
        indexed.sort_by_key(|(i, _)| *i);
        indexed.into_iter().map(|(_, r)| r).collect()
    })
    .await
    .map_err(|e: tokio::task::JoinError| e.to_string())
}

// Pipeline for a single file: decode → re-encode to a temp file → compare sizes → swap.
// If the result isn't smaller we bail, so we never make things worse. The original gets
// moved to the system trash (not permanently deleted) so users can recover if needed.
fn compress_single(path: &str, output_format: &str, quality: u8) -> CompressionResult {
    let original_path = PathBuf::from(path);
    let name = original_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let original_size = match fs::metadata(&original_path) {
        Ok(m) => m.len(),
        Err(e) => {
            return CompressionResult {
                path: path.to_string(),
                name,
                original_size: 0,
                compressed_size: 0,
                savings_percent: 0.0,
                success: false,
                error: Some(format!("Cannot read file: {}", e)),
            };
        }
    };

    let ext = original_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    // "original" means keep the same format, just make it smaller
    let effective_format = match output_format {
        "original" => ext.as_str(),
        other => other,
    };

    // Don't rename .jpeg to .jpg or vice versa — keep whatever the user had
    let output_ext = match effective_format {
        "jpg" | "jpeg" => ext.as_str(),
        other => other,
    };

    let is_converting = output_ext != ext.as_str();

    let final_path = if is_converting {
        original_path.with_extension(output_ext)
    } else {
        original_path.clone()
    };

    let final_name = final_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let tmp_path = original_path
        .parent()
        .unwrap_or(&original_path)
        .join(format!(".{}.tmp", name));

    let compress_result = match effective_format {
        "jpg" | "jpeg" => compress_jpeg(&original_path, &tmp_path, quality),
        "png" => compress_png(&original_path, &tmp_path, quality),
        "webp" => compress_webp(&original_path, &tmp_path, quality),
        "avif" => compress_avif(&original_path, &tmp_path, quality),
        _ => Err(format!("Unsupported format: .{}", ext)),
    };

    if let Err(e) = compress_result {
        let _ = fs::remove_file(&tmp_path);
        return CompressionResult {
            path: path.to_string(),
            name,
            original_size,
            compressed_size: 0,
            savings_percent: 0.0,
            success: false,
            error: Some(e),
        };
    }

    let compressed_size = match fs::metadata(&tmp_path) {
        Ok(m) => m.len(),
        Err(e) => {
            let _ = fs::remove_file(&tmp_path);
            return CompressionResult {
                path: path.to_string(),
                name,
                original_size,
                compressed_size: 0,
                savings_percent: 0.0,
                success: false,
                error: Some(format!("Cannot read compressed file: {}", e)),
            };
        }
    };

    // No point replacing a file with something the same size or bigger
    if !is_converting && compressed_size >= original_size {
        let _ = fs::remove_file(&tmp_path);
        return CompressionResult {
            path: path.to_string(),
            name,
            original_size,
            compressed_size: original_size,
            savings_percent: 0.0,
            success: true,
            error: None,
        };
    }

    let trash_result = {
        let mut ctx = trash::TrashContext::new();
        #[cfg(target_os = "macos")]
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(&original_path)
    };

    if let Err(e) = trash_result {
        let _ = fs::remove_file(&tmp_path);
        return CompressionResult {
            path: path.to_string(),
            name,
            original_size,
            compressed_size: 0,
            savings_percent: 0.0,
            success: false,
            error: Some(format!("Cannot trash original: {}", e)),
        };
    }

    if let Err(e) = fs::rename(&tmp_path, &final_path) {
        return CompressionResult {
            path: path.to_string(),
            name,
            original_size,
            compressed_size: 0,
            savings_percent: 0.0,
            success: false,
            error: Some(format!("Cannot replace original: {}", e)),
        };
    }

    let savings_percent = (1.0 - compressed_size as f64 / original_size as f64) * 100.0;

    CompressionResult {
        path: final_path.to_string_lossy().to_string(),
        name: final_name,
        original_size,
        compressed_size,
        savings_percent,
        success: true,
        error: None,
    }
}

// Quality is user-configurable (50-100). For lossy formats it maps directly
// to encoder quality; for PNG it controls the oxipng optimization preset.

fn compress_jpeg(input: &PathBuf, output: &PathBuf, quality: u8) -> Result<(), String> {
    let img = image::open(input).map_err(|e| format!("Cannot decode image: {}", e))?;
    let rgb = img.into_rgb8();
    let (width, height) = rgb.dimensions();
    let pixels = rgb.as_raw();

    // mozjpeg can panic on malformed input so we catch that rather
    // than letting it take down the whole app
    let jpeg_bytes = catch_unwind(|| {
        let mut comp = mozjpeg::Compress::new(mozjpeg::ColorSpace::JCS_RGB);
        comp.set_size(width as usize, height as usize);
        comp.set_quality(quality as f32);
        comp.set_mem_dest();
        comp.start_compress();
        comp.write_scanlines(pixels);
        comp.finish_compress();
        comp.data_to_vec().expect("Failed to get JPEG data")
    })
    .map_err(|_| "MozJPEG compression failed".to_string())?;

    fs::write(output, jpeg_bytes).map_err(|e| format!("Cannot write compressed file: {}", e))
}

fn compress_png(input: &PathBuf, output: &PathBuf, quality: u8) -> Result<(), String> {
    let in_file = oxipng::InFile::Path(input.clone());
    let out_file = oxipng::OutFile::from_path(output.clone());
    // Map quality to oxipng preset: higher quality = less aggressive (preset 1),
    // lower quality = more aggressive compression (preset 4)
    let preset = if quality >= 90 { 1 } else if quality >= 70 { 2 } else if quality >= 50 { 3 } else { 4 };
    oxipng::optimize(&in_file, &out_file, &oxipng::Options::from_preset(preset))
        .map(|_| ())
        .map_err(|e| format!("OxiPNG optimization failed: {}", e))
}

fn compress_webp(input: &PathBuf, output: &PathBuf, quality: u8) -> Result<(), String> {
    let img = image::open(input).map_err(|e| format!("Cannot decode image: {}", e))?;
    let rgba = img.into_rgba8();
    let (width, height) = rgba.dimensions();
    let encoder = webp::Encoder::from_rgba(rgba.as_raw(), width, height);
    let memory = encoder.encode(quality as f32);
    fs::write(output, &*memory).map_err(|e| format!("Cannot write compressed file: {}", e))
}

fn compress_avif(input: &PathBuf, output: &PathBuf, quality: u8) -> Result<(), String> {
    let img = image::open(input).map_err(|e| format!("Cannot decode image: {}", e))?;
    let rgba = img.into_rgba8();
    let (width, height) = rgba.dimensions();
    let file =
        fs::File::create(output).map_err(|e| format!("Cannot create output file: {}", e))?;
    let writer = std::io::BufWriter::new(file);
    image::codecs::avif::AvifEncoder::new_with_speed_quality(writer, 10, quality)
        .write_image(
            rgba.as_raw(),
            width,
            height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("AVIF encoding failed: {}", e))
}

// Boot up the Tauri app — registers plugins and exposes our commands to the frontend
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![compress_images])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
