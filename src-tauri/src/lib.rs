use image::{DynamicImage, GenericImageView, ImageEncoder};
use rayon::prelude::*;
use serde::Serialize;
use std::fs;
use std::panic::catch_unwind;
use std::path::PathBuf;
use tauri::Emitter;

#[cfg(target_os = "macos")]
use trash::macos::{DeleteMethod, TrashContextExtMacos};

// Camera native sensor resolutions: (model substring, width, height)
// Model matching is case-insensitive and uses contains() so partial matches work
static CAMERA_DB: &[(&str, u32, u32)] = &[
    // Sony Alpha
    ("ILCE-7M5", 7008, 4672),
    ("ILCE-7M4", 7008, 4672),
    ("ILCE-7M3", 6000, 4000),
    ("ILCE-7M2", 6000, 4000),
    ("ILCE-7RM5", 9504, 6336),
    ("ILCE-7RM4", 9504, 6336),
    ("ILCE-7RM3", 7952, 5304),
    ("ILCE-7RM2", 7952, 5304),
    ("ILCE-7SM3", 4240, 2832),
    ("ILCE-7SM2", 4240, 2832),
    ("ILCE-7CR", 9504, 6336),
    ("ILCE-7C", 6000, 4000),
    ("ILCE-9M3", 6000, 4000),
    ("ILCE-9M2", 6000, 4000),
    ("ILCE-9", 6000, 4000),
    ("ILCE-1", 8640, 5760),
    ("ILCE-6700", 6192, 4128),
    ("ILCE-6600", 6000, 4000),
    ("ILCE-6500", 6000, 4000),
    ("ILCE-6400", 6000, 4000),
    ("ILCE-6300", 6000, 4000),
    ("ILCE-6100", 6000, 4000),
    ("ILCE-6000", 6000, 4000),
    ("ZV-E1", 4240, 2832),
    ("ZV-E10M2", 6192, 4128),
    ("ZV-E10", 6000, 4000),
    // Canon EOS R
    ("EOS R5 Mark II", 8192, 5464),
    ("EOS R5", 8192, 5464),
    ("EOS R6 Mark II", 6000, 4000),
    ("EOS R6", 5472, 3648),
    ("EOS R3", 6000, 4000),
    ("EOS R1", 6000, 4000),
    ("EOS R7", 7008, 4672),
    ("EOS R8", 6000, 4000),
    ("EOS R10", 6000, 4000),
    ("EOS R50", 6000, 4000),
    ("EOS R100", 6000, 4000),
    ("EOS R", 6720, 4480),
    ("EOS RP", 6240, 4160),
    // Canon EOS DSLR
    ("EOS 5D Mark IV", 6720, 4480),
    ("EOS 5D Mark III", 5760, 3840),
    ("EOS 6D Mark II", 6240, 4160),
    ("EOS 6D", 5472, 3648),
    ("EOS 90D", 6960, 4640),
    ("EOS 80D", 6000, 4000),
    ("EOS 77D", 6000, 4000),
    ("EOS 70D", 5472, 3648),
    ("EOS Rebel T8i", 6000, 4000),
    ("EOS 850D", 6000, 4000),
    // Nikon Z
    ("Z 9", 8256, 5504),
    ("Z 8", 8256, 5504),
    ("Z 7II", 8256, 5504),
    ("Z 7", 8256, 5504),
    ("Z 6III", 6000, 4000),
    ("Z 6II", 6048, 4024),
    ("Z 6", 6048, 4024),
    ("Z 5", 6016, 4016),
    ("Z f", 6048, 4032),
    ("Z fc", 5568, 3712),
    ("Z 50", 5568, 3712),
    ("Z 30", 5568, 3712),
    // Nikon DSLR
    ("D850", 8256, 5504),
    ("D810", 7360, 4912),
    ("D780", 6048, 4024),
    ("D750", 6016, 4016),
    ("D500", 5568, 3712),
    ("D7500", 5568, 3712),
    ("D5600", 6000, 4000),
    ("D3500", 6000, 4000),
    // Fujifilm X
    ("X-T5", 7728, 5152),
    ("X-T4", 6240, 4160),
    ("X-T3", 6240, 4160),
    ("X-T30 II", 6240, 4160),
    ("X-T30", 6240, 4160),
    ("X-H2S", 6240, 4160),
    ("X-H2", 7728, 5152),
    ("X-S20", 6240, 4160),
    ("X-S10", 6240, 4160),
    ("X-E4", 6240, 4160),
    ("X100VI", 7728, 5152),
    ("X100V", 6240, 4160),
    ("X100F", 6000, 4000),
    // Fujifilm GFX
    ("GFX100 II", 11648, 8736),
    ("GFX100S", 11648, 8736),
    ("GFX 50S II", 8256, 6192),
    ("GFX 50R", 8256, 6192),
    // Panasonic Lumix
    ("DC-S5M2", 6000, 4000),
    ("DC-S5", 6000, 4000),
    ("DC-S1R", 11552, 8672),
    ("DC-S1H", 6000, 4000),
    ("DC-S1", 6000, 4000),
    ("DC-GH6", 5776, 4336),
    ("DC-GH5S", 3680, 2760),
    ("DC-GH5", 5184, 3888),
    ("DC-G9", 5184, 3888),
    // Leica
    ("LEICA Q3", 9520, 6336),
    ("LEICA Q2", 8368, 5584),
    ("LEICA M11", 9528, 6328),
    ("LEICA SL2-S", 6000, 4000),
    ("LEICA SL2", 8368, 5584),
    // Hasselblad
    ("X2D 100C", 11656, 8742),
    ("X1D II 50C", 8272, 6200),
    ("X1D-50c", 8272, 6200),
    // OM System / Olympus
    ("OM-1 Mark II", 5184, 3888),
    ("OM-1", 5184, 3888),
    ("E-M1 Mark III", 5184, 3888),
    ("E-M1 Mark II", 5184, 3888),
    ("E-M5 Mark III", 5184, 3888),
    // Pentax
    ("PENTAX K-1 Mark II", 7360, 4912),
    ("PENTAX K-1", 7360, 4912),
    ("PENTAX K-3 Mark III", 6192, 4128),
    // Ricoh
    ("GR IIIx", 6000, 4000),
    ("GR III", 6000, 4000),
    // DJI drones
    ("FC3582", 8064, 6048),  // Mavic 3 Pro
    ("FC3411", 5280, 3956),  // Mavic 3
    ("FC3170", 5472, 3648),  // Mini 3 Pro
    ("FC7303", 4000, 3000),  // Mini 2
    ("L2D-20c", 5280, 3956), // Mavic 3 (Hasselblad)
];

fn get_camera_native_resolution(path: &str) -> Result<(u32, u32), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open file for EXIF: {}", e))?;
    let mut buf = std::io::BufReader::new(file);
    let exif = match exif::Reader::new().read_from_container(&mut buf) {
        Ok(exif) => exif,
        Err(e) => {
            // Retry with raw bytes
            let data = std::fs::read(path).map_err(|e| format!("Cannot reread: {}", e))?;
            exif::Reader::new()
                .read_raw(data)
                .map_err(|e2| format!("EXIF failed: container={:?}, raw={:?}", e, e2))?
        }
    };

    let model = exif
        .get_field(exif::Tag::Model, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string())
        .unwrap_or_default();

    if model.is_empty() {
        return Err("No camera model in EXIF".to_string());
    }

    let model_upper = model.to_uppercase();
    for &(db_model, w, h) in CAMERA_DB {
        if model_upper.contains(&db_model.to_uppercase()) {
            return Ok((w, h));
        }
    }

    Err(format!("Unrecognized camera: {}", model.trim_matches('"')))
}

fn resize_to_original(img: DynamicImage, path: &str) -> (DynamicImage, Option<String>) {
    let (native_w, native_h) = match get_camera_native_resolution(path) {
        Ok(res) => res,
        Err(reason) => return (img, Some(reason)),
    };

    let (cur_w, cur_h) = img.dimensions();
    let max_native = native_w.max(native_h);
    let max_current = cur_w.max(cur_h);

    if max_current >= max_native {
        return (img, None);
    }

    let scale = max_native as f64 / max_current as f64;
    let new_w = (cur_w as f64 * scale).round() as u32;
    let new_h = (cur_h as f64 * scale).round() as u32;

    let resized = img.resize_exact(new_w, new_h, image::imageops::FilterType::Lanczos3);
    (resized, None)
}

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
    warning: Option<String>,
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
    scale_factor: u32,
) -> Result<Vec<CompressionResult>, String> {
    tokio::task::spawn_blocking(move || -> Vec<CompressionResult> {
        let mut indexed: Vec<(usize, CompressionResult)> = file_paths
            .par_iter()
            .enumerate()
            .map(|(i, p)| {
                let result = compress_single(p, &output_format, quality, scale_factor);
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

fn resize_if_needed(img: DynamicImage, scale_factor: u32) -> DynamicImage {
    if scale_factor <= 1 {
        return img;
    }
    let (w, h) = img.dimensions();
    let new_w = w * scale_factor;
    let new_h = h * scale_factor;
    img.resize_exact(new_w, new_h, image::imageops::FilterType::Lanczos3)
}

// Pipeline for a single file: decode → resize → re-encode to a temp file → compare sizes → swap.
// If the result isn't smaller we bail, so we never make things worse. The original gets
// moved to the system trash (not permanently deleted) so users can recover if needed.
fn compress_single(path: &str, output_format: &str, quality: u8, scale_factor: u32) -> CompressionResult {
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
                warning: None,
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

    // Decode image once, resize if needed, then pass to format-specific encoders
    let img = match image::open(&original_path) {
        Ok(img) => img,
        Err(e) => {
            return CompressionResult {
                path: path.to_string(),
                name,
                original_size,
                compressed_size: 0,
                savings_percent: 0.0,
                success: false,
                error: Some(format!("Cannot decode image: {}", e)),
                warning: None,
            };
        }
    };

    let (orig_w, orig_h) = img.dimensions();
    let (img, exif_warning) = if scale_factor == 1 {
        resize_to_original(img, path)
    } else {
        (resize_if_needed(img, scale_factor), None)
    };
    let was_resized = (orig_w, orig_h) != img.dimensions();

    let compress_result = match effective_format {
        "jpg" | "jpeg" => compress_jpeg(&img, &tmp_path, quality),
        "png" => compress_png(&img, &tmp_path, quality),
        "webp" => compress_webp(&img, &tmp_path, quality),
        "avif" => compress_avif(&img, &tmp_path, quality),
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
            warning: None,
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
                warning: None,
            };
        }
    };

    // No point replacing a file with something the same size or bigger,
    // but skip this guard when the user explicitly requested a resize
    if !is_converting && !was_resized && compressed_size >= original_size {
        let _ = fs::remove_file(&tmp_path);
        return CompressionResult {
            path: path.to_string(),
            name,
            original_size,
            compressed_size: original_size,
            savings_percent: 0.0,
            success: true,
            error: None,
            warning: exif_warning,
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
            warning: None,
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
            warning: None,
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
        warning: exif_warning,
    }
}

// Quality is user-configurable (50-100). For lossy formats it maps directly
// to encoder quality; for PNG it controls the oxipng optimization preset.

fn compress_jpeg(img: &DynamicImage, output: &PathBuf, quality: u8) -> Result<(), String> {
    let rgb = img.to_rgb8();
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

fn compress_png(img: &DynamicImage, output: &PathBuf, quality: u8) -> Result<(), String> {
    // oxipng needs a file path, so save the (possibly resized) image to a tmp file first
    let tmp_png = output.with_extension("tmp.png");
    img.save(&tmp_png)
        .map_err(|e| format!("Cannot write temp PNG: {}", e))?;

    let in_file = oxipng::InFile::Path(tmp_png.clone());
    let out_file = oxipng::OutFile::from_path(output.clone());
    // Map quality to oxipng preset: higher quality = less aggressive (preset 1),
    // lower quality = more aggressive compression (preset 4)
    let preset = if quality >= 90 { 1 } else if quality >= 70 { 2 } else if quality >= 50 { 3 } else { 4 };
    let result = oxipng::optimize(&in_file, &out_file, &oxipng::Options::from_preset(preset))
        .map(|_| ())
        .map_err(|e| format!("OxiPNG optimization failed: {}", e));

    let _ = fs::remove_file(&tmp_png);
    result
}

fn compress_webp(img: &DynamicImage, output: &PathBuf, quality: u8) -> Result<(), String> {
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let encoder = webp::Encoder::from_rgba(rgba.as_raw(), width, height);
    let memory = encoder.encode(quality as f32);
    fs::write(output, &*memory).map_err(|e| format!("Cannot write compressed file: {}", e))
}

fn compress_avif(img: &DynamicImage, output: &PathBuf, quality: u8) -> Result<(), String> {
    let rgba = img.to_rgba8();
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
