use super::FrameExtents;

const CARDINAL_BYTES: usize = 4;
const THIRTY_TWO_BITS: u8 = 32;
const EIGHT_BITS: u8 = 8;

/// The 32-bit values of a property in the byte order the connection uses. A
/// property of another width, or one that ends inside a value, is rejected
/// instead of being read short.
pub(crate) fn decode_cardinals(format: u8, bytes: &[u8]) -> Option<Vec<u32>> {
    if format != THIRTY_TWO_BITS || !bytes.len().is_multiple_of(CARDINAL_BYTES) {
        return None;
    }
    Some(
        bytes
            .chunks_exact(CARDINAL_BYTES)
            .map(|chunk| u32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect(),
    )
}

/// `_NET_FRAME_EXTENTS`: left, right, top, bottom.
pub(crate) fn decode_frame_extents(format: u8, bytes: &[u8]) -> Option<FrameExtents> {
    match decode_cardinals(format, bytes)?.as_slice() {
        [left, right, top, bottom] => Some(FrameExtents {
            left: *left,
            right: *right,
            top: *top,
            bottom: *bottom,
        }),
        _ => None,
    }
}

/// `_GTK_FRAME_EXTENTS` as left, top, right, bottom; zero where the window has
/// no client-side shadow or the property is unreadable.
pub(crate) fn decode_shadow(format: u8, bytes: &[u8]) -> (i32, i32, i32, i32) {
    decode_frame_extents(format, bytes).map_or((0, 0, 0, 0), |extents| {
        let side = |value: u32| i32::try_from(value).unwrap_or(0);
        (
            side(extents.left),
            side(extents.top),
            side(extents.right),
            side(extents.bottom),
        )
    })
}

/// A window title from `_NET_WM_NAME` (UTF-8) or, when that is absent or
/// empty, `WM_NAME` (Latin-1). Invalid UTF-8 is replaced, never an error.
pub(crate) fn decode_title(utf8: Option<(u8, &[u8])>, latin1: Option<(u8, &[u8])>) -> String {
    let wide = utf8
        .filter(|(format, bytes)| *format == EIGHT_BITS && !bytes.is_empty())
        .map(|(_, bytes)| String::from_utf8_lossy(bytes).into_owned());
    wide.or_else(|| {
        latin1
            .filter(|(format, _)| *format == EIGHT_BITS)
            .map(|(_, bytes)| bytes.iter().map(|byte| char::from(*byte)).collect())
    })
    .unwrap_or_default()
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
