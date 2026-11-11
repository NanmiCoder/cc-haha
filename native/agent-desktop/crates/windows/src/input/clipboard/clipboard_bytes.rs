//! Shared little-endian field readers and clipboard decode/argument errors.

use agent_desktop_core::{AdapterError, ErrorCode};

pub(crate) fn read_u16(bytes: &[u8], offset: usize, field: &str) -> Result<u16, AdapterError> {
    let end = offset
        .checked_add(2)
        .ok_or_else(|| payload_error(&format!("{field} offset overflowed")))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| payload_error(&format!("{field} is truncated")))?;
    let array: [u8; 2] = slice
        .try_into()
        .map_err(|_| payload_error(&format!("{field} is truncated")))?;
    Ok(u16::from_le_bytes(array))
}

pub(crate) fn read_u32(bytes: &[u8], offset: usize, field: &str) -> Result<u32, AdapterError> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| payload_error(&format!("{field} offset overflowed")))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| payload_error(&format!("{field} is truncated")))?;
    let array: [u8; 4] = slice
        .try_into()
        .map_err(|_| payload_error(&format!("{field} is truncated")))?;
    Ok(u32::from_le_bytes(array))
}

pub(crate) fn read_i32(bytes: &[u8], offset: usize, field: &str) -> Result<i32, AdapterError> {
    Ok(read_u32(bytes, offset, field)? as i32)
}

pub(crate) fn read_utf16_units(bytes: &[u8]) -> Vec<u16> {
    bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect()
}

pub(crate) fn payload_error(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::ActionFailed, message)
}

pub(crate) fn argument_error(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, message)
}

/// Shared UTF-16LE test fixture builder for the wire-format decode tests
/// (`clipboard_text_tests.rs`, `clipboard_files_tests.rs`).
#[cfg(test)]
pub(crate) fn utf16_le(units: &[u16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(units.len() * 2);
    for unit in units {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}
