use agent_desktop_core::{AdapterError, ErrorCode, ImageBuffer, ImageFormat, MAX_PNG_INPUT_BYTES};
use png::{BitDepth, ColorType, Compression, Encoder};

use super::pixels::MAX_PIXELS;

const ENCODED_SHARE: usize = 4;

fn refused(reason: impl Into<String>) -> AdapterError {
    AdapterError::new(ErrorCode::ActionFailed, reason)
}

fn check_pixels(width: u32, height: u32) -> Result<u64, AdapterError> {
    let pixels = u64::from(width) * u64::from(height);
    if pixels == 0 {
        return Err(refused("The capture has no pixels"));
    }
    if pixels > MAX_PIXELS {
        return Err(refused(format!(
            "The capture is {width}x{height}, larger than the {MAX_PIXELS} pixel limit"
        )));
    }
    Ok(pixels)
}

fn check_encoded(length: usize) -> Result<(), AdapterError> {
    if length > MAX_PNG_INPUT_BYTES {
        return Err(refused("The encoded capture is larger than the size limit"));
    }
    Ok(())
}

fn broken(what: &str, error: impl std::fmt::Display) -> AdapterError {
    AdapterError::internal(format!("{what}: {error}"))
}

fn write_png(
    rgb: &[u8],
    width: u32,
    height: u32,
    sink: impl std::io::Write,
) -> Result<(), AdapterError> {
    let mut encoder = Encoder::new(sink, width, height);
    encoder.set_color(ColorType::Rgb);
    encoder.set_depth(BitDepth::Eight);
    encoder.set_compression(Compression::Balanced);
    let mut writer = encoder
        .write_header()
        .map_err(|error| broken("The PNG header could not be written", error))?;
    writer
        .write_image_data(rgb)
        .and_then(|()| writer.finish())
        .map_err(|error| broken("The PNG could not be encoded", error))
}

pub(crate) fn encode_png(
    rgb: &[u8],
    width: u32,
    height: u32,
    scale_factor: f64,
) -> Result<ImageBuffer, AdapterError> {
    let pixels = check_pixels(width, height)?;
    if rgb.len() as u64 != pixels * 3 {
        return Err(refused("The capture bytes do not match its size"));
    }
    let mut data = Vec::with_capacity(rgb.len() / ENCODED_SHARE);
    write_png(rgb, width, height, &mut data)?;
    check_encoded(data.len())?;
    Ok(ImageBuffer {
        data,
        format: ImageFormat::Png,
        width,
        height,
        scale_factor,
    })
}

#[cfg(test)]
#[path = "png_encode_tests.rs"]
mod tests;
