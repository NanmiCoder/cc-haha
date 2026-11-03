use agent_desktop_core::{AdapterError, ErrorCode};

pub(crate) const MAX_PIXELS: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VisualFormat {
    pub(crate) red_mask: u32,
    pub(crate) green_mask: u32,
    pub(crate) blue_mask: u32,
    pub(crate) bits_per_pixel: u8,
    pub(crate) depth: u8,
    pub(crate) scanline_pad: u8,
    pub(crate) msb_first: bool,
}

impl VisualFormat {
    fn describe(&self) -> String {
        format!(
            "depth {} with {} bits per pixel and masks {:#x}/{:#x}/{:#x}",
            self.depth, self.bits_per_pixel, self.red_mask, self.green_mask, self.blue_mask
        )
    }

    fn channels(&self) -> Option<[u32; 3]> {
        Some([
            byte_channel(self.red_mask)?,
            byte_channel(self.green_mask)?,
            byte_channel(self.blue_mask)?,
        ])
    }
}

fn byte_channel(mask: u32) -> Option<u32> {
    let shift = mask.trailing_zeros();
    (mask != 0 && mask >> shift == 0xff).then_some(shift)
}

fn unsupported(format: &VisualFormat) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!(
            "The screen format is not supported for capture: {}",
            format.describe()
        ),
    )
    .with_suggestion("Capture needs a 24 or 32 bit TrueColor visual with 8 bits per channel")
}

fn malformed(reason: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!("The captured pixels are unusable: {reason}"),
    )
}

fn word(bytes: &[u8], msb_first: bool) -> u32 {
    let join = |value: u32, byte: &u8| (value << 8) | u32::from(*byte);
    if msb_first {
        bytes.iter().fold(0, join)
    } else {
        bytes.iter().rev().fold(0, join)
    }
}

pub(crate) fn to_rgb(
    format: &VisualFormat,
    data: &[u8],
    width: u32,
    height: u32,
    stride: usize,
) -> Result<Vec<u8>, AdapterError> {
    let bytes_per_pixel = match format.bits_per_pixel {
        24 => 3,
        32 => 4,
        _ => return Err(unsupported(format)),
    };
    let channels = format.channels().ok_or_else(|| unsupported(format))?;
    if width == 0 || height == 0 {
        return Err(malformed("the image has no pixels"));
    }
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(malformed("the image is larger than the pixel limit"));
    }
    let row = width as usize * bytes_per_pixel;
    let needed = stride
        .checked_mul(height as usize - 1)
        .and_then(|rows| rows.checked_add(row));
    if stride < row || needed.is_none_or(|needed| data.len() < needed) {
        return Err(malformed("the rows are shorter than the image size says"));
    }
    let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
    for line in data.chunks(stride).take(height as usize) {
        for pixel in line[..row].chunks_exact(bytes_per_pixel) {
            let value = word(pixel, format.msb_first);
            for &shift in &channels {
                rgb.push((value >> shift) as u8);
            }
        }
    }
    Ok(rgb)
}

#[cfg(test)]
#[path = "pixels_tests.rs"]
mod tests;
