#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardFormat {
    Auto,
    Text,
    Image,
    FileUrls,
}

impl ClipboardFormat {
    pub fn as_str(&self) -> &'static str {
        match self {
            ClipboardFormat::Auto => "auto",
            ClipboardFormat::Text => "text",
            ClipboardFormat::Image => "image",
            ClipboardFormat::FileUrls => "file_urls",
        }
    }
}
