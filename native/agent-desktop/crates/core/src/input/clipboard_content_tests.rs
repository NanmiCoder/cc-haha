use super::*;

#[test]
fn text_content_reports_text_format() {
    let content = ClipboardContent::Text("hello".into());
    assert_eq!(content.format(), ClipboardFormat::Text);
    assert_eq!(ClipboardFormat::Text.as_str(), "text");
}

#[test]
fn image_content_reports_image_format() {
    let content = ClipboardContent::Image(ImageBuffer {
        data: vec![0u8; 4],
        format: crate::ImageFormat::Png,
        width: 2,
        height: 2,
        scale_factor: 1.0,
    });
    assert_eq!(content.format(), ClipboardFormat::Image);
    assert_eq!(ClipboardFormat::Image.as_str(), "image");
}

#[test]
fn file_urls_content_reports_file_urls_format() {
    let content = ClipboardContent::FileUrls(vec!["/tmp/a.txt".into()]);
    assert_eq!(content.format(), ClipboardFormat::FileUrls);
    assert_eq!(ClipboardFormat::FileUrls.as_str(), "file_urls");
}

#[test]
fn auto_format_tag_is_distinct_from_content_formats() {
    assert_eq!(ClipboardFormat::Auto.as_str(), "auto");
    assert_ne!(ClipboardFormat::Auto, ClipboardFormat::Text);
}
