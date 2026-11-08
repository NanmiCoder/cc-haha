//! Pure clipboard image marshalling: registered PNG passthrough and CF_DIB/CF_DIBV5 ↔ PNG.

use agent_desktop_core::{
    AdapterError, Deadline, ImageBuffer, ImageFormat, MAX_PNG_INPUT_BYTES, parse_png_dimensions,
};
use std::borrow::Cow;

use super::clipboard_bytes::{argument_error, payload_error, read_i32, read_u16, read_u32};

const BITMAPINFOHEADER_SIZE: u32 = 40;
const BITMAPV5HEADER_SIZE: u32 = 124;
const BI_RGB: u32 = 0;
const BI_BITFIELDS: u32 = 3;
const MAX_IMAGE_PIXELS: u64 = 64 * 1024 * 1024;

pub(crate) fn decode_png_clipboard(png: &[u8]) -> Result<ImageBuffer, AdapterError> {
    let (width, height) = validate_png_payload(png, false)?;
    Ok(ImageBuffer {
        data: png.to_vec(),
        format: ImageFormat::Png,
        width,
        height,
        scale_factor: 1.0,
    })
}

pub(crate) fn decode_dib_clipboard(
    dib: &[u8],
    deadline: Deadline,
) -> Result<ImageBuffer, AdapterError> {
    let (bgra, width, height) = dib_to_bgra(dib)?;
    let stride = width
        .checked_mul(4)
        .ok_or_else(|| payload_error("DIB width overflows the BGRA stride budget"))?;
    let png = crate::system::capture::png_codec::encode_bgra_to_png(
        &bgra, width, height, stride, deadline,
    )?;
    Ok(ImageBuffer {
        data: png,
        format: ImageFormat::Png,
        width,
        height,
        scale_factor: 1.0,
    })
}

type PreparedPng<'a> = (Cow<'a, [u8]>, (u32, u32));

pub(crate) fn prepare_clipboard_png(bytes: &[u8]) -> Result<PreparedPng<'_>, AdapterError> {
    let dimensions = validate_png_payload(bytes, true)?;
    Ok((Cow::Borrowed(bytes), dimensions))
}

pub(crate) fn png_bytes_for_clipboard(image: &ImageBuffer) -> Result<Vec<u8>, AdapterError> {
    let (prepared, dimensions) = prepare_clipboard_png(&image.data)?;
    if !matches!(image.format, ImageFormat::Png)
        || dimensions != (image.width, image.height)
        || !image.scale_factor.is_finite()
        || image.scale_factor <= 0.0
    {
        return Err(argument_error(
            "Clipboard image metadata does not match its PNG payload",
        ));
    }
    Ok(prepared.into_owned())
}

pub(crate) fn encode_dib_from_png(png: &[u8], deadline: Deadline) -> Result<Vec<u8>, AdapterError> {
    let (_, _) = validate_png_payload(png, true)?;
    let (bgra, width, height) =
        crate::system::capture::png_codec::decode_png_to_bgra(png, deadline)?;
    bgra_to_dib(&bgra, width, height)
}

fn dib_to_bgra(dib: &[u8]) -> Result<(Vec<u8>, u32, u32), AdapterError> {
    if dib.len() < BITMAPINFOHEADER_SIZE as usize {
        return Err(payload_error(
            "DIB payload is shorter than BITMAPINFOHEADER",
        ));
    }
    let header_size = read_u32(dib, 0, "DIB header size")?;
    if header_size != BITMAPINFOHEADER_SIZE && header_size != BITMAPV5HEADER_SIZE {
        return Err(payload_error(
            "DIB header size is not BITMAPINFOHEADER or BITMAPV5HEADER",
        ));
    }
    if dib.len() < header_size as usize {
        return Err(payload_error(
            "DIB payload is shorter than its declared header",
        ));
    }
    let width_i = read_i32(dib, 4, "DIB biWidth")?;
    let height_i = read_i32(dib, 8, "DIB biHeight")?;
    let planes = read_u16(dib, 12, "DIB biPlanes")?;
    let bit_count = read_u16(dib, 14, "DIB biBitCount")?;
    let compression = read_u32(dib, 16, "DIB biCompression")?;
    let clr_used = read_u32(dib, 32, "DIB biClrUsed")?;
    if planes != 1 {
        return Err(payload_error("DIB biPlanes must be 1"));
    }
    if bit_count != 24 && bit_count != 32 {
        return Err(payload_error("DIB biBitCount must be 24 or 32"));
    }
    if compression != BI_RGB && compression != BI_BITFIELDS {
        return Err(payload_error(
            "DIB compression must be BI_RGB or BI_BITFIELDS",
        ));
    }
    if width_i <= 0 {
        return Err(payload_error("DIB biWidth must be positive"));
    }
    if height_i == 0 {
        return Err(payload_error("DIB biHeight must be non-zero"));
    }
    let width = width_i as u32;
    let top_down = height_i < 0;
    let height = height_i.unsigned_abs();
    validate_dimensions(width, height, false)?;

    let pixel_offset = pixel_array_offset(header_size, compression, bit_count, clr_used)?;
    let stride = dib_stride_bytes(width, bit_count)?;
    let needed = (stride as u64)
        .checked_mul(u64::from(height))
        .and_then(|pixels| (pixel_offset as u64).checked_add(pixels))
        .ok_or_else(|| payload_error("DIB pixel buffer size overflowed"))?;
    if needed > dib.len() as u64 {
        return Err(payload_error("DIB pixel array is truncated"));
    }
    let pixels = &dib[pixel_offset..pixel_offset + stride as usize * height as usize];
    let bgra = expand_dib_pixels(pixels, width, height, bit_count, stride, top_down)?;
    Ok((bgra, width, height))
}

fn bgra_to_dib(bgra: &[u8], width: u32, height: u32) -> Result<Vec<u8>, AdapterError> {
    validate_dimensions(width, height, true)?;
    let stride = dib_stride_bytes(width, 32)?;
    let row_bytes = (width as usize)
        .checked_mul(4)
        .ok_or_else(|| argument_error("BGRA width overflows"))?;
    let needed = row_bytes
        .checked_mul(height as usize)
        .ok_or_else(|| argument_error("BGRA buffer size overflows"))?;
    if bgra.len() < needed {
        return Err(argument_error(
            "BGRA buffer is shorter than width times height times four",
        ));
    }
    let mut out = vec![0u8; BITMAPINFOHEADER_SIZE as usize + stride as usize * height as usize];
    write_bitmapinfoheader(
        &mut out[..BITMAPINFOHEADER_SIZE as usize],
        width,
        height,
        stride,
    );
    for y in 0..height {
        let src_y = height - 1 - y;
        let src = src_y as usize * row_bytes;
        let dst = BITMAPINFOHEADER_SIZE as usize + y as usize * stride as usize;
        out[dst..dst + row_bytes].copy_from_slice(&bgra[src..src + row_bytes]);
    }
    Ok(out)
}

fn pixel_array_offset(
    header_size: u32,
    compression: u32,
    bit_count: u16,
    clr_used: u32,
) -> Result<usize, AdapterError> {
    let mut offset = header_size as usize;
    if compression == BI_BITFIELDS && header_size == BITMAPINFOHEADER_SIZE {
        offset = offset
            .checked_add(12)
            .ok_or_else(|| payload_error("DIB bitfields mask section overflowed"))?;
    }
    let palette_entries = if bit_count <= 8 {
        if clr_used == 0 {
            1u32 << bit_count
        } else {
            clr_used
        }
    } else if clr_used > 0 {
        clr_used
    } else {
        0
    };
    let palette_bytes = (palette_entries as usize)
        .checked_mul(4)
        .ok_or_else(|| payload_error("DIB palette size overflowed"))?;
    offset
        .checked_add(palette_bytes)
        .ok_or_else(|| payload_error("DIB pixel offset overflowed"))
}

fn dib_stride_bytes(width: u32, bit_count: u16) -> Result<u32, AdapterError> {
    let bits = (width as u64)
        .checked_mul(u64::from(bit_count))
        .ok_or_else(|| payload_error("DIB row bit width overflowed"))?;
    let stride = bits
        .checked_add(31)
        .and_then(|value| value.checked_div(32))
        .and_then(|value| value.checked_mul(4))
        .ok_or_else(|| payload_error("DIB row stride overflowed"))?;
    u32::try_from(stride).map_err(|_| payload_error("DIB row stride does not fit in u32"))
}

fn expand_dib_pixels(
    pixels: &[u8],
    width: u32,
    height: u32,
    bit_count: u16,
    stride: u32,
    top_down: bool,
) -> Result<Vec<u8>, AdapterError> {
    let out_stride = (width as usize)
        .checked_mul(4)
        .ok_or_else(|| payload_error("BGRA output stride overflowed"))?;
    let mut out = vec![
        0u8;
        out_stride
            .checked_mul(height as usize)
            .ok_or_else(|| payload_error("BGRA output size overflowed"))?
    ];
    let src_bpp = (bit_count / 8) as usize;
    for y in 0..height {
        let src_y = if top_down { y } else { height - 1 - y };
        let src_row = src_y as usize * stride as usize;
        let dst_row = y as usize * out_stride;
        for x in 0..width as usize {
            let src = src_row + x * src_bpp;
            let dst = dst_row + x * 4;
            let b = *pixels
                .get(src)
                .ok_or_else(|| payload_error("DIB pixel row is truncated"))?;
            let g = *pixels
                .get(src + 1)
                .ok_or_else(|| payload_error("DIB pixel row is truncated"))?;
            let r = *pixels
                .get(src + 2)
                .ok_or_else(|| payload_error("DIB pixel row is truncated"))?;
            let a = if bit_count == 32 {
                *pixels
                    .get(src + 3)
                    .ok_or_else(|| payload_error("DIB pixel row is truncated"))?
            } else {
                255
            };
            out[dst] = b;
            out[dst + 1] = g;
            out[dst + 2] = r;
            out[dst + 3] = a;
        }
    }
    Ok(out)
}

fn write_bitmapinfoheader(dst: &mut [u8], width: u32, height: u32, stride: u32) {
    dst[0..4].copy_from_slice(&BITMAPINFOHEADER_SIZE.to_le_bytes());
    dst[4..8].copy_from_slice(&(width as i32).to_le_bytes());
    dst[8..12].copy_from_slice(&(height as i32).to_le_bytes());
    dst[12..14].copy_from_slice(&1u16.to_le_bytes());
    dst[14..16].copy_from_slice(&32u16.to_le_bytes());
    dst[16..20].copy_from_slice(&BI_RGB.to_le_bytes());
    dst[20..24].copy_from_slice(&(stride.saturating_mul(height)).to_le_bytes());
    dst[24..28].copy_from_slice(&0i32.to_le_bytes());
    dst[28..32].copy_from_slice(&0i32.to_le_bytes());
    dst[32..36].copy_from_slice(&0u32.to_le_bytes());
    dst[36..40].copy_from_slice(&0u32.to_le_bytes());
}

fn validate_png_payload(png: &[u8], argument: bool) -> Result<(u32, u32), AdapterError> {
    if png.is_empty() {
        return Err(if argument {
            argument_error("Clipboard PNG payload is empty")
        } else {
            payload_error("Clipboard PNG payload is empty")
        });
    }
    if png.len() > MAX_PNG_INPUT_BYTES {
        return Err(if argument {
            argument_error(&format!(
                "Image exceeds the {} MiB encoded-data budget",
                MAX_PNG_INPUT_BYTES / (1024 * 1024)
            ))
        } else {
            payload_error(&format!(
                "Clipboard image exceeds the {} MiB encoded-data budget",
                MAX_PNG_INPUT_BYTES / (1024 * 1024)
            ))
        });
    }
    let dimensions = parse_png_dimensions(png).ok_or_else(|| {
        if argument {
            argument_error("Clipboard images must be complete, valid PNG payloads")
        } else {
            payload_error("Clipboard PNG payload failed complete validation")
        }
    })?;
    validate_dimensions(dimensions.0, dimensions.1, argument)?;
    Ok(dimensions)
}

fn validate_dimensions(width: u32, height: u32, argument: bool) -> Result<(), AdapterError> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| payload_error("Image pixel count overflowed"))?;
    if width > 0 && height > 0 && pixels <= MAX_IMAGE_PIXELS {
        return Ok(());
    }
    Err(if argument {
        argument_error("Image exceeds the decoded-image budget")
    } else {
        payload_error("Clipboard image exceeds the decoded-image budget")
    })
}

#[cfg(test)]
#[path = "clipboard_image_tests.rs"]
mod tests;
