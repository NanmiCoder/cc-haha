use crate::{
    AppError, ClipboardContent, ImageBuffer, ImageFormat, adapter::PlatformAdapter,
    commands::operation_response::operation_response, parse_png_dimensions,
};
use serde_json::{Value, json};
use std::path::PathBuf;

pub struct ClipboardSetArgs {
    pub text: Option<String>,
    pub image: Option<PathBuf>,
    pub file_urls: Vec<String>,
}

pub fn execute(args: ClipboardSetArgs, adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    let content = build_content(args)?;
    let format = content.format();
    let lease = crate::commands::helpers::acquire_interaction_lease(adapter)?;
    let report = adapter.set_clipboard_content(&content, &lease)?;
    operation_response(&report, json!({ "type": format.as_str() }))
}

fn build_content(args: ClipboardSetArgs) -> Result<ClipboardContent, AppError> {
    if !args.file_urls.is_empty() {
        return Ok(ClipboardContent::FileUrls(validate_file_urls(
            &args.file_urls,
        )?));
    }
    if let Some(path) = args.image {
        let data = crate::storage::private_file::read_regular_bounded(
            &path,
            crate::MAX_PNG_INPUT_BYTES as u64,
        )
        .map_err(image_read_error)?;
        let Some((width, height)) = parse_png_dimensions(&data) else {
            return Err(AppError::invalid_input("--image file is not a valid PNG"));
        };
        return Ok(ClipboardContent::Image(ImageBuffer {
            data,
            format: ImageFormat::Png,
            width,
            height,
            scale_factor: 1.0,
        }));
    }
    Ok(ClipboardContent::Text(args.text.unwrap_or_default()))
}

fn image_read_error(error: std::io::Error) -> AppError {
    if matches!(
        error.kind(),
        std::io::ErrorKind::InvalidData
            | std::io::ErrorKind::NotFound
            | std::io::ErrorKind::PermissionDenied
    ) {
        return AppError::invalid_input(format!(
            "--image must be a local regular PNG no larger than {} MiB",
            crate::MAX_PNG_INPUT_BYTES / (1024 * 1024)
        ));
    }
    AppError::Io(error)
}

/// Reports missing `--file-url` entries by count and index only — the
/// entries themselves may be sensitive paths and this error can reach a
/// trace file.
fn validate_file_urls(urls: &[String]) -> Result<Vec<String>, AppError> {
    let missing: Vec<usize> = urls
        .iter()
        .enumerate()
        .filter(|(_, path)| !std::path::Path::new(path).exists())
        .map(|(index, _)| index)
        .collect();
    if !missing.is_empty() {
        return Err(AppError::invalid_input(format!(
            "{} of {} --file-url entries do not exist on disk (indexes: {missing:?})",
            missing.len(),
            urls.len()
        )));
    }
    Ok(urls.to_vec())
}

#[cfg(test)]
#[path = "clipboard_set_tests.rs"]
mod tests;
