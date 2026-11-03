#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TextUnitError {
    TooLong,
}

fn length_as_i32(length: usize) -> Result<i32, TextUnitError> {
    i32::try_from(length).map_err(|_| TextUnitError::TooLong)
}

/// The UTF-8 byte length of `text`, the length `InsertText` takes. A length
/// above `i32::MAX` cannot be sent and is refused.
pub(crate) fn utf8_len(text: &str) -> Result<i32, TextUnitError> {
    length_as_i32(text.len())
}

/// The unit a toolkit counts the `length` argument of `InsertText` in. ATK
/// counts bytes, which GTK follows; Qt's bridge reads the argument as UTF-16
/// units and reads past the text when it is larger, so it needs its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LengthUnit {
    Utf8Bytes,
    Utf16Units,
}

/// The `InsertText` length of `text` in `unit`.
pub(crate) fn insert_length(text: &str, unit: LengthUnit) -> Result<i32, TextUnitError> {
    match unit {
        LengthUnit::Utf8Bytes => utf8_len(text),
        LengthUnit::Utf16Units => length_as_i32(text.encode_utf16().count()),
    }
}

/// The UTF-16 offset of the code point at `offset`, or `None` past the end.
/// An offset equal to the code-point count is the end of the text.
pub(crate) fn code_point_to_utf16(text: &str, offset: usize) -> Option<usize> {
    let mut units = 0;
    let mut points = text.chars();
    for _ in 0..offset {
        units += points.next()?.len_utf16();
    }
    Some(units)
}

#[cfg(test)]
#[path = "text_units_tests.rs"]
mod tests;
