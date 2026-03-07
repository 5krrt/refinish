use image::ImageEncoder;
use rayon::prelude::*;
use serde::Serialize;
use std::fs;
use std::panic::catch_unwind;
use std::path::PathBuf;

#[derive(Serialize)]
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

#[tauri::command]
async fn compress_images(
    file_paths: Vec<String>,
    output_format: String,
) -> Result<Vec<CompressionResult>, String> {
    tokio::task::spawn_blocking(move || -> Vec<CompressionResult> {
        file_paths
            .par_iter()
            .map(|p| compress_single(p, &output_format))
            .collect()
    })
    .await
    .map_err(|e: tokio::task::JoinError| e.to_string())
}

fn compress_single(path: &str, output_format: &str) -> CompressionResult {
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

    // Determine effective output format
    let effective_format = match output_format {
        "original" => ext.as_str(),
        other => other,
    };

    // Determine output extension (keep original for jpeg variants)
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
        "jpg" | "jpeg" => compress_jpeg(&original_path, &tmp_path),
        "png" => compress_png(&original_path, &tmp_path),
        "webp" => compress_webp(&original_path, &tmp_path),
        "avif" => compress_avif(&original_path, &tmp_path),
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

    // For same-format: skip if compressed >= original
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

    if let Err(e) = trash::delete(&original_path) {
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

fn compress_jpeg(input: &PathBuf, output: &PathBuf) -> Result<(), String> {
    let img = image::open(input).map_err(|e| format!("Cannot decode image: {}", e))?;
    let rgb = img.to_rgb8();
    let (width, height) = rgb.dimensions();
    let pixels = rgb.as_raw();

    let jpeg_bytes = catch_unwind(|| {
        let mut comp = mozjpeg::Compress::new(mozjpeg::ColorSpace::JCS_RGB);
        comp.set_size(width as usize, height as usize);
        comp.set_quality(80.0);
        comp.set_mem_dest();
        comp.start_compress();
        comp.write_scanlines(pixels);
        comp.finish_compress();
        comp.data_to_vec().expect("Failed to get JPEG data")
    })
    .map_err(|_| "MozJPEG compression failed".to_string())?;

    fs::write(output, jpeg_bytes).map_err(|e| format!("Cannot write compressed file: {}", e))
}

fn compress_png(input: &PathBuf, output: &PathBuf) -> Result<(), String> {
    let in_file = oxipng::InFile::Path(input.clone());
    let out_file = oxipng::OutFile::from_path(output.clone());
    oxipng::optimize(&in_file, &out_file, &oxipng::Options::from_preset(1))
        .map(|_| ())
        .map_err(|e| format!("OxiPNG optimization failed: {}", e))
}

fn compress_webp(input: &PathBuf, output: &PathBuf) -> Result<(), String> {
    let img = image::open(input).map_err(|e| format!("Cannot decode image: {}", e))?;
    let encoder =
        webp::Encoder::from_image(&img).map_err(|e| format!("WebP encoder error: {}", e))?;
    let memory = encoder.encode(80.0);
    fs::write(output, &*memory).map_err(|e| format!("Cannot write compressed file: {}", e))
}

fn compress_avif(input: &PathBuf, output: &PathBuf) -> Result<(), String> {
    let img = image::open(input).map_err(|e| format!("Cannot decode image: {}", e))?;
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let file =
        fs::File::create(output).map_err(|e| format!("Cannot create output file: {}", e))?;
    let writer = std::io::BufWriter::new(file);
    image::codecs::avif::AvifEncoder::new_with_speed_quality(writer, 10, 80)
        .write_image(
            rgba.as_raw(),
            width,
            height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("AVIF encoding failed: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![compress_images])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
