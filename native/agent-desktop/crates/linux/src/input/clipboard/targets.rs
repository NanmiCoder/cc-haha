use agent_desktop_core::{
    AdapterError, ClipboardContent, ClipboardFormat, ErrorCode, ImageBuffer, ImageFormat,
    MAX_PNG_INPUT_BYTES, parse_png_dimensions,
};

use super::formats::{self, GNOME_FILES, PNG, TEXT_TARGETS, URI_LIST};
use super::uri_list;

const FILE_TARGETS: [&str; 2] = [URI_LIST, GNOME_FILES];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Wanted {
    FileUrls(&'static str),
    Image,
    Text(&'static str),
}

impl Wanted {
    pub(crate) fn target_name(&self) -> &'static str {
        match self {
            Self::FileUrls(name) | Self::Text(name) => name,
            Self::Image => PNG,
        }
    }
}

fn first_offered(offered: &[String], candidates: &[&'static str]) -> Option<&'static str> {
    candidates
        .iter()
        .copied()
        .find(|candidate| offered.iter().any(|name| name == candidate))
}

fn files(offered: &[String]) -> Option<Wanted> {
    first_offered(offered, &FILE_TARGETS).map(Wanted::FileUrls)
}

fn image(offered: &[String]) -> Option<Wanted> {
    first_offered(offered, &[PNG]).map(|_| Wanted::Image)
}

fn text(offered: &[String]) -> Option<Wanted> {
    first_offered(offered, &TEXT_TARGETS).map(Wanted::Text)
}

/// Picks the target to request from an owner's `TARGETS` list. `Auto` prefers
/// file paths, then an image, then text.
pub(crate) fn choose_target(offered: &[String], format: ClipboardFormat) -> Option<Wanted> {
    match format {
        ClipboardFormat::FileUrls => files(offered),
        ClipboardFormat::Image => image(offered),
        ClipboardFormat::Text => text(offered),
        ClipboardFormat::Auto => files(offered)
            .or_else(|| image(offered))
            .or_else(|| text(offered)),
    }
}

fn over_cap() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!(
            "The clipboard holds more than the {} MiB cap",
            MAX_PNG_INPUT_BYTES / (1024 * 1024)
        ),
    )
}

/// Builds the content `wanted` names from the bytes an owner sent. A file
/// list with no usable entry comes back as an empty `FileUrls`, which the
/// reader reports as absent.
pub(crate) fn content_of(
    wanted: &Wanted,
    bytes: Vec<u8>,
) -> Result<ClipboardContent, AdapterError> {
    if bytes.len() > MAX_PNG_INPUT_BYTES {
        return Err(over_cap());
    }
    match wanted {
        Wanted::Text(target) => formats::decode_text(target, &bytes).map(ClipboardContent::Text),
        Wanted::Image => {
            let (width, height) = parse_png_dimensions(&bytes).ok_or_else(|| {
                AdapterError::new(
                    ErrorCode::ActionFailed,
                    "The clipboard's image/png data is not a usable PNG",
                )
            })?;
            Ok(ClipboardContent::Image(ImageBuffer {
                data: bytes,
                format: ImageFormat::Png,
                width,
                height,
                scale_factor: 1.0,
            }))
        }
        Wanted::FileUrls(target) => {
            let paths = if *target == GNOME_FILES {
                uri_list::parse_gnome_copied_files(&bytes)?
            } else {
                uri_list::parse_uri_list(&bytes)?
            };
            Ok(ClipboardContent::FileUrls(paths))
        }
    }
}

#[cfg(test)]
#[path = "targets_tests.rs"]
mod tests;
