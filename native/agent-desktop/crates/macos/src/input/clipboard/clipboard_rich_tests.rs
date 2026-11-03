use super::super::clipboard_file_urls::file_url_to_path;
use super::*;

#[test]
fn undersized_png_is_rejected_without_panicking() {
    assert!(prepare_image(&[1, 2, 3]).is_err());
}

#[test]
fn file_url_to_path_round_trips_a_plain_path() {
    let path = file_url_to_path("file:///tmp/agent-desktop-test.txt")
        .expect("well-formed file:// URL must decode to a path");
    assert_eq!(path, "/tmp/agent-desktop-test.txt");
}

#[test]
fn file_url_to_path_decodes_percent_escaped_spaces() {
    let path = file_url_to_path("file:///tmp/agent%20desktop/note.txt")
        .expect("percent-encoded file:// URL must decode");
    assert_eq!(path, "/tmp/agent desktop/note.txt");
}

#[test]
fn file_url_to_path_rejects_non_file_scheme() {
    assert!(file_url_to_path("https://example.com/a.txt").is_none());
}

#[test]
fn non_png_image_payload_is_rejected_before_native_decode() {
    let error = prepare_image(b"II*\0unbounded-tiff").expect_err("TIFF is unsupported");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn valid_png_is_passed_through_without_decode_or_reencode() {
    let png = one_pixel_png();
    let (prepared, dimensions) = prepare_image(&png).unwrap();

    assert!(matches!(prepared, std::borrow::Cow::Borrowed(_)));
    assert_eq!(prepared.as_ref(), png);
    assert_eq!(dimensions, (1, 1));
}

#[test]
fn file_url_validation_is_all_or_nothing() {
    let paths = vec!["/tmp/good".to_string(), String::new()];

    assert!(prepare_file_urls(&paths).is_err());
}

#[test]
fn file_urls_reject_remote_hosts_and_relative_paths() {
    assert!(file_url_to_path("file://server/share/note.txt").is_none());
    assert!(prepare_file_urls(&["relative/note.txt".into()]).is_err());
}

#[test]
fn file_urls_reject_embedded_nul() {
    assert!(file_url_to_path("file:///tmp/a%00b").is_none());
    assert!(prepare_file_urls(&["/tmp/a\0b".into()]).is_err());
}

#[test]
fn oversized_dimensions_are_rejected_from_the_header() {
    let mut png = one_pixel_png();
    png[16..20].copy_from_slice(&100_000_u32.to_be_bytes());
    png[20..24].copy_from_slice(&100_000_u32.to_be_bytes());

    let error = prepare_image(&png).expect_err("pixel bomb metadata must be rejected");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

fn one_pixel_png() -> [u8; 68] {
    [
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4,
        0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5,
        1, 1, 39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]
}
