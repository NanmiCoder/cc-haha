use crate::{AdapterError, ErrorCode, Point};
use serde::{Deserialize, Serialize};
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub const MAX_CURSOR_IMAGE_PATH_BYTES: usize = 1024;
pub const MAX_CURSOR_IMAGE_BYTES: u64 = 2 * 1024 * 1024;
/// Largest PNG pixel width or height the renderer will decode.
pub const MAX_CURSOR_IMAGE_PIXELS: u32 = 1024;
const PNG_HEADER_BYTES: usize = 24;
const MAX_HOTSPOT: f64 = 512.0;
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// A PNG drawn in place of the built-in cursor arrow. `hotspot` is the
/// click point in image points from the image's top-left corner.
#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CursorImage {
    path: String,
    #[serde(default = "origin", skip_serializing_if = "is_origin")]
    hotspot: Point,
}

impl CursorImage {
    pub fn new(path: String, hotspot: Point) -> Result<Self, AdapterError> {
        Self { path, hotspot }.validated()
    }

    pub fn validated(self) -> Result<Self, AdapterError> {
        if self.path.is_empty() || self.path.contains('\0') {
            return Err(invalid("Cursor image path must be a non-empty file path"));
        }
        if escaped_len(&self.path) > MAX_CURSOR_IMAGE_PATH_BYTES {
            return Err(invalid(format!(
                "Cursor image path must be at most {MAX_CURSOR_IMAGE_PATH_BYTES} bytes once JSON-escaped"
            )));
        }
        if !Path::new(&self.path).is_absolute() {
            return Err(invalid("Cursor image path must be absolute"));
        }
        if !Path::new(&self.path)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
        {
            return Err(invalid("cursor images must be PNG"));
        }
        let within = |value: f64| value.is_finite() && (0.0..=MAX_HOTSPOT).contains(&value);
        if !within(self.hotspot.x) || !within(self.hotspot.y) {
            return Err(invalid(format!(
                "Cursor image --hotspot must be between 0 and {MAX_HOTSPOT} on both axes"
            )));
        }
        Ok(self)
    }

    /// Checks that the file is a regular file within the size limit, carries the PNG
    /// signature and declares at most
    /// [`MAX_CURSOR_IMAGE_PIXELS`] per side. Every check reads the same open file.
    pub fn verify_file(&self) -> Result<(), AdapterError> {
        let unreadable = |error: std::io::Error| {
            invalid(format!("Cursor image '{}' cannot be read", self.path))
                .with_platform_detail(error.to_string())
        };
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NONBLOCK);
        let mut file = options.open(&self.path).map_err(unreadable)?;
        let metadata = file.metadata().map_err(unreadable)?;
        if !metadata.is_file() {
            return Err(invalid(format!(
                "Cursor image '{}' is not a regular file",
                self.path
            )));
        }
        if metadata.len() > MAX_CURSOR_IMAGE_BYTES {
            return Err(invalid(format!(
                "Cursor image must be at most {} MiB",
                MAX_CURSOR_IMAGE_BYTES / (1024 * 1024)
            )));
        }
        let mut header = [0; PNG_HEADER_BYTES];
        file.read_exact(&mut header[..PNG_MAGIC.len()])
            .map_err(unreadable)?;
        if !header.starts_with(PNG_MAGIC) {
            return Err(invalid("cursor images must be PNG"));
        }
        file.read_exact(&mut header[PNG_MAGIC.len()..])
            .map_err(unreadable)?;
        if !png_dimensions_fit(&header) {
            return Err(invalid(format!(
                "Cursor image PNG must be at most {MAX_CURSOR_IMAGE_PIXELS} pixels per side"
            )));
        }
        Ok(())
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub const fn hotspot(&self) -> &Point {
        &self.hotspot
    }
}

fn png_dimensions_fit(header: &[u8]) -> bool {
    let side = |at: usize| {
        header
            .get(at..at + 4)
            .and_then(|bytes| bytes.try_into().ok())
            .map(u32::from_be_bytes)
    };
    matches!(
        (header.get(12..16), side(16), side(20)),
        (Some(b"IHDR"), Some(width), Some(height))
            if (1..=MAX_CURSOR_IMAGE_PIXELS).contains(&width)
                && (1..=MAX_CURSOR_IMAGE_PIXELS).contains(&height)
    )
}

fn escaped_len(value: &str) -> usize {
    serde_json::to_string(value).map_or(usize::MAX, |json| json.len().saturating_sub(2))
}

const fn origin() -> Point {
    Point { x: 0.0, y: 0.0 }
}

fn is_origin(point: &Point) -> bool {
    *point == origin()
}

fn invalid(message: impl Into<String>) -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, message)
}
