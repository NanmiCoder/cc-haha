use crate::{ClipboardFormat, ImageBuffer};

#[derive(Debug)]
pub enum ClipboardContent {
    Text(String),
    Image(ImageBuffer),
    FileUrls(Vec<String>),
}

impl ClipboardContent {
    pub fn format(&self) -> ClipboardFormat {
        match self {
            ClipboardContent::Text(_) => ClipboardFormat::Text,
            ClipboardContent::Image(_) => ClipboardFormat::Image,
            ClipboardContent::FileUrls(_) => ClipboardFormat::FileUrls,
        }
    }
}

#[cfg(test)]
#[path = "clipboard_content_tests.rs"]
mod tests;
