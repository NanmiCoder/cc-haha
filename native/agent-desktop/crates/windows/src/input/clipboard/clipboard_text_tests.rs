use super::{decode_utf16_text, encode_utf16_text};
use crate::input::clipboard::clipboard_bytes::utf16_le;
use agent_desktop_core::ErrorCode;

#[test]
fn text_round_trips_table() {
    let cases = [
        ("", "empty"),
        ("hello", "ascii"),
        ("line\nbreak", "embedded_newline"),
        ("line\r\nbreak", "crlf"),
        ("a\r\nb\r\n", "repeated_and_trailing_crlf"),
        ("emoji \u{1F600}", "non_bmp"),
        ("café", "bmp_non_ascii"),
    ];
    for (text, label) in cases {
        let encoded = encode_utf16_text(text).unwrap_or_else(|error| {
            panic!("encode failed for {label}: {error:?}");
        });
        assert!(
            encoded.ends_with(&[0, 0]),
            "{label} must end with a UTF-16 NUL"
        );
        let decoded = decode_utf16_text(&encoded).unwrap_or_else(|error| {
            panic!("decode failed for {label}: {error:?}");
        });
        assert_eq!(decoded, text, "{label}");
    }
}

#[test]
fn missing_terminator_decodes_full_buffer() {
    let bytes = utf16_le(&[b'a' as u16, b'b' as u16, b'c' as u16]);
    let decoded = decode_utf16_text(&bytes).expect("missing terminator is accepted");
    assert_eq!(decoded, "abc");
}

#[test]
fn trailing_bytes_after_terminator_are_ignored() {
    let mut bytes = utf16_le(&[b'h' as u16, b'i' as u16, 0, b'x' as u16, b'y' as u16]);
    bytes.extend_from_slice(&[0xFF, 0xFF]);
    let decoded = decode_utf16_text(&bytes).expect("trailing bytes after NUL are ignored");
    assert_eq!(decoded, "hi");
}

#[test]
fn unpaired_surrogates_do_not_panic() {
    let bytes = utf16_le(&[0xD800, b'!' as u16, 0]);
    let decoded = decode_utf16_text(&bytes).expect("unpaired high surrogate");
    assert!(decoded.contains('\u{FFFD}'));
    assert!(decoded.contains('!'));

    let bytes = utf16_le(&[0xDC00, 0]);
    let decoded = decode_utf16_text(&bytes).expect("unpaired low surrogate");
    assert_eq!(decoded, "\u{FFFD}");
}

#[test]
fn odd_length_payload_is_rejected() {
    let error = decode_utf16_text(&[0x61]).expect_err("odd length");
    assert_eq!(error.code, ErrorCode::ActionFailed);
}

#[test]
fn oversized_decode_is_rejected() {
    let mut units = vec![b'a' as u16; 1_000_001];
    units.push(0);
    let error = decode_utf16_text(&utf16_le(&units)).expect_err("oversized");
    assert_eq!(error.code, ErrorCode::ActionFailed);
}

#[test]
fn oversized_encode_is_rejected() {
    let text = "a".repeat(1_000_001);
    let error = encode_utf16_text(&text).expect_err("oversized encode");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn embedded_nul_encode_is_rejected() {
    let error = encode_utf16_text("a\0b").expect_err("embedded NUL");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}
