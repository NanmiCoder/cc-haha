use super::{
    LengthUnit, TextUnitError, code_point_to_utf16, insert_length, length_as_i32, utf8_len,
};

const MIXED: &str = "a\u{1F600}e\u{301}b";

#[test]
fn a_code_point_offset_converts_to_a_utf16_offset() {
    assert_eq!(code_point_to_utf16(MIXED, 0), Some(0));
    assert_eq!(code_point_to_utf16(MIXED, 1), Some(1));
    assert_eq!(code_point_to_utf16(MIXED, 2), Some(3));
    assert_eq!(code_point_to_utf16(MIXED, 4), Some(5));
    assert_eq!(code_point_to_utf16(MIXED, 5), Some(6));
}

#[test]
fn a_code_point_offset_past_the_end_is_rejected() {
    assert_eq!(code_point_to_utf16(MIXED, 6), None);
}

#[test]
fn the_utf8_length_counts_bytes_not_points() {
    assert_eq!(utf8_len("\u{1F600}"), Ok(4));
    assert_eq!(utf8_len(MIXED), Ok(9));
    assert_eq!(utf8_len(""), Ok(0));
}

#[test]
fn a_length_above_i32_max_is_rejected() {
    let limit = i32::MAX as usize;
    assert_eq!(length_as_i32(limit), Ok(i32::MAX));
    assert_eq!(length_as_i32(limit + 1), Err(TextUnitError::TooLong));
}

#[test]
fn the_insert_length_follows_the_unit_the_toolkit_counts_in() {
    assert_eq!(insert_length("\u{e9}", LengthUnit::Utf8Bytes), Ok(2));
    assert_eq!(insert_length("\u{e9}", LengthUnit::Utf16Units), Ok(1));
    assert_eq!(insert_length("\u{1F600}", LengthUnit::Utf8Bytes), Ok(4));
    assert_eq!(insert_length("\u{1F600}", LengthUnit::Utf16Units), Ok(2));
    assert_eq!(insert_length("e\u{301}", LengthUnit::Utf16Units), Ok(2));
}
