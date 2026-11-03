use crate::ImageFormat;

#[derive(Debug)]
pub struct ImageBuffer {
    pub data: Vec<u8>,
    pub format: ImageFormat,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

pub const MAX_PNG_INPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_PNG_PIXELS: u64 = 64 * 1024 * 1024;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const PNG_HEADER_BYTES: usize = 33;

pub fn parse_png_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < PNG_HEADER_BYTES || data.len() > MAX_PNG_INPUT_BYTES {
        return None;
    }
    if data.get(..PNG_SIGNATURE.len())? != PNG_SIGNATURE {
        return None;
    }
    if read_u32(data, 8)? != 13 || data.get(12..16)? != b"IHDR" {
        return None;
    }
    let width = read_u32(data, 16)?;
    let height = read_u32(data, 20)?;
    let depth = *data.get(24)?;
    let color = *data.get(25)?;
    valid_png_header(width, height, depth, color, data.get(26..29)?).then_some((width, height))
}

fn read_u32(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        data.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn valid_png_header(width: u32, height: u32, depth: u8, color: u8, tail: &[u8]) -> bool {
    let valid_depth = match color {
        0 => matches!(depth, 1 | 2 | 4 | 8 | 16),
        2 | 4 | 6 => matches!(depth, 8 | 16),
        3 => matches!(depth, 1 | 2 | 4 | 8),
        _ => false,
    };
    let pixels = u64::from(width).checked_mul(u64::from(height));
    width > 0
        && height > 0
        && pixels.is_some_and(|pixels| pixels <= MAX_PNG_PIXELS)
        && valid_depth
        && matches!(tail, [0, 0, 0 | 1])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one_pixel_png() -> Vec<u8> {
        vec![
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15,
            0, 1, 5, 1, 1, 39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ]
    }

    #[test]
    fn decodes_valid_png_before_returning_dimensions() {
        let bytes = one_pixel_png();

        assert_eq!(parse_png_dimensions(&bytes), Some((1, 1)));
    }

    #[test]
    fn accepts_adam7_interlaced_png_header() {
        let mut bytes = one_pixel_png();
        bytes[28] = 1;

        assert_eq!(parse_png_dimensions(&bytes), Some((1, 1)));
    }

    #[test]
    fn rejects_unknown_png_interlace_method() {
        let mut bytes = one_pixel_png();
        bytes[28] = 2;

        assert_eq!(parse_png_dimensions(&bytes), None);
    }

    #[test]
    fn rejects_undersized_buffer() {
        assert_eq!(parse_png_dimensions(&[1, 2, 3]), None);
    }

    #[test]
    fn rejects_buffer_with_wrong_signature() {
        let mut bytes = one_pixel_png();
        bytes[0] = 0x00;

        assert_eq!(parse_png_dimensions(&bytes), None);
    }

    #[test]
    fn metadata_parse_does_not_duplicate_platform_payload_validation() {
        let mut bytes = one_pixel_png();
        bytes[45] ^= 0xff;

        assert_eq!(parse_png_dimensions(&bytes), Some((1, 1)));
    }

    #[test]
    fn rejects_header_only_png() {
        let bytes = one_pixel_png();

        assert_eq!(parse_png_dimensions(&bytes[..24]), None);
    }
}
