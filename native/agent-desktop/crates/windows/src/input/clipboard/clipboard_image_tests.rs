use super::{
    BI_BITFIELDS, BI_RGB, BITMAPINFOHEADER_SIZE, BITMAPV5HEADER_SIZE, bgra_to_dib,
    decode_dib_clipboard, decode_png_clipboard, dib_to_bgra, encode_dib_from_png,
    pixel_array_offset, png_bytes_for_clipboard,
};
use crate::system::fixture::test_time::deadline;
use agent_desktop_core::{ErrorCode, ImageBuffer, ImageFormat, parse_png_dimensions};

fn pattern_bgra(width: u32, height: u32) -> Vec<u8> {
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    for y in 0..height {
        for x in 0..width {
            let offset = ((y * width + x) * 4) as usize;
            let i = (y * width + x) as usize;
            pixels[offset] = (i.wrapping_mul(17) % 256) as u8;
            pixels[offset + 1] = (i.wrapping_mul(31) % 256) as u8;
            pixels[offset + 2] = (i.wrapping_mul(47) % 256) as u8;
            pixels[offset + 3] = 255;
        }
    }
    pixels
}

fn write_u16(buf: &mut [u8], offset: usize, value: u16) {
    buf[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_u32(buf: &mut [u8], offset: usize, value: u32) {
    buf[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_i32(buf: &mut [u8], offset: usize, value: i32) {
    write_u32(buf, offset, value as u32);
}

fn dib_stride(width: u32, bit_count: u16) -> u32 {
    let bits = u64::from(width) * u64::from(bit_count);
    bits.div_ceil(32).saturating_mul(4) as u32
}

fn build_dib(
    width: u32,
    height_signed: i32,
    bit_count: u16,
    compression: u32,
    header_size: u32,
    top_left_bgra: [u8; 4],
) -> Vec<u8> {
    let height = height_signed.unsigned_abs();
    let stride = dib_stride(width, bit_count);
    let mask_bytes = if compression == BI_BITFIELDS && header_size == BITMAPINFOHEADER_SIZE {
        12usize
    } else {
        0
    };
    let pixel_offset = header_size as usize + mask_bytes;
    let mut dib = vec![0u8; pixel_offset + stride as usize * height as usize];
    write_u32(&mut dib, 0, header_size);
    write_i32(&mut dib, 4, width as i32);
    write_i32(&mut dib, 8, height_signed);
    write_u16(&mut dib, 12, 1);
    write_u16(&mut dib, 14, bit_count);
    write_u32(&mut dib, 16, compression);
    write_u32(&mut dib, 20, stride * height);
    if mask_bytes == 12 {
        write_u32(&mut dib, 40, 0x00FF0000);
        write_u32(&mut dib, 44, 0x0000FF00);
        write_u32(&mut dib, 48, 0x000000FF);
    }
    if header_size == BITMAPV5HEADER_SIZE {
        write_u32(&mut dib, 40, 0x00FF0000);
        write_u32(&mut dib, 44, 0x0000FF00);
        write_u32(&mut dib, 48, 0x000000FF);
        write_u32(&mut dib, 52, 0xFF000000);
    }

    let top_down = height_signed < 0;
    for y in 0..height {
        let image_y = if top_down { y } else { height - 1 - y };
        let row = pixel_offset + y as usize * stride as usize;
        for x in 0..width as usize {
            let src = if image_y == 0 && x == 0 {
                top_left_bgra
            } else {
                [0, 0, 0, 255]
            };
            let dst = row + x * (bit_count as usize / 8);
            dib[dst] = src[0];
            dib[dst + 1] = src[1];
            dib[dst + 2] = src[2];
            if bit_count == 32 {
                dib[dst + 3] = src[3];
            }
        }
    }
    dib
}

#[test]
fn png_passthrough_preserves_bytes_and_metadata() {
    crate::tree::fixture::bootstrap();
    let bgra = pattern_bgra(3, 2);
    let png =
        crate::system::capture::png_codec::encode_bgra_to_png(&bgra, 3, 2, 12, deadline(5_000))
            .expect("encode fixture PNG");
    let image = decode_png_clipboard(&png).expect("decode PNG clipboard");
    assert_eq!(image.data, png);
    assert!(matches!(image.format, ImageFormat::Png));
    assert_eq!((image.width, image.height), (3, 2));
    assert_eq!(image.scale_factor, 1.0);
}

#[test]
fn twenty_four_bit_stride_padding_decodes_correct_pixels() {
    let width = 5u32;
    let height = 2u32;
    let bit_count = 24u16;
    let stride = dib_stride(width, bit_count);
    assert_ne!(stride, width * 3, "fixture must exercise padding");
    let dib = build_dib(
        width,
        height as i32,
        bit_count,
        BI_RGB,
        BITMAPINFOHEADER_SIZE,
        [10, 20, 30, 255],
    );
    let (bgra, out_w, out_h) = dib_to_bgra(&dib).expect("decode padded 24-bit DIB");
    assert_eq!((out_w, out_h), (width, height));
    assert_eq!(&bgra[..4], &[10, 20, 30, 255]);
}

#[test]
fn bottom_up_and_top_down_decode_to_same_image() {
    let marker = [1, 2, 3, 255];
    let bottom_up = build_dib(2, 2, 32, BI_RGB, BITMAPINFOHEADER_SIZE, marker);
    let top_down = build_dib(2, -2, 32, BI_RGB, BITMAPINFOHEADER_SIZE, marker);
    let (a, aw, ah) = dib_to_bgra(&bottom_up).expect("bottom-up");
    let (b, bw, bh) = dib_to_bgra(&top_down).expect("top-down");
    assert_eq!((aw, ah), (bw, bh));
    assert_eq!(a, b);
    assert_eq!(&a[..4], &marker);
}

#[test]
fn twenty_four_and_thirty_two_bit_both_decode() {
    let marker = [9, 8, 7, 255];
    let dib24 = build_dib(2, 2, 24, BI_RGB, BITMAPINFOHEADER_SIZE, marker);
    let dib32 = build_dib(2, 2, 32, BI_RGB, BITMAPINFOHEADER_SIZE, marker);
    let (a, _, _) = dib_to_bgra(&dib24).expect("24-bit");
    let (b, _, _) = dib_to_bgra(&dib32).expect("32-bit");
    assert_eq!(&a[..4], &marker);
    assert_eq!(&b[..4], &marker);
}

#[test]
fn bitmapv5_mask_section_uses_header_size_for_pixel_offset() {
    let offset = pixel_array_offset(BITMAPV5HEADER_SIZE, BI_BITFIELDS, 32, 0).expect("V5 offset");
    assert_eq!(offset, BITMAPV5HEADER_SIZE as usize);
    assert_ne!(offset, BITMAPINFOHEADER_SIZE as usize);

    let marker = [4, 5, 6, 7];
    let dib = build_dib(2, 2, 32, BI_BITFIELDS, BITMAPV5HEADER_SIZE, marker);
    let (bgra, _, _) = dib_to_bgra(&dib).expect("V5 decode");
    assert_eq!(&bgra[..4], &marker);
}

#[test]
fn png_dib_png_round_trips_pixels() {
    crate::tree::fixture::bootstrap();
    let width = 5u32;
    let height = 3u32;
    let bgra = pattern_bgra(width, height);
    let png = crate::system::capture::png_codec::encode_bgra_to_png(
        &bgra,
        width,
        height,
        width * 4,
        deadline(5_000),
    )
    .expect("encode source PNG");
    let dib = encode_dib_from_png(&png, deadline(5_000)).expect("PNG to DIB");
    assert_eq!(
        u32::from_le_bytes(dib[0..4].try_into().unwrap()),
        BITMAPINFOHEADER_SIZE
    );
    assert_eq!(
        i32::from_le_bytes(dib[8..12].try_into().unwrap()),
        height as i32
    );
    let image = decode_dib_clipboard(&dib, deadline(5_000)).expect("DIB to PNG");
    assert!(matches!(image.format, ImageFormat::Png));
    assert_eq!(image.scale_factor, 1.0);
    assert_eq!(parse_png_dimensions(&image.data), Some((width, height)));
    let (decoded, out_w, out_h) =
        crate::system::capture::png_codec::decode_png_to_bgra(&image.data, deadline(5_000))
            .expect("decode PNG");
    assert_eq!((out_w, out_h), (width, height));
    assert_eq!(decoded, bgra);
}

#[test]
fn write_helpers_preserve_original_png_bytes() {
    crate::tree::fixture::bootstrap();
    let bgra = pattern_bgra(2, 2);
    let png =
        crate::system::capture::png_codec::encode_bgra_to_png(&bgra, 2, 2, 8, deadline(5_000))
            .expect("encode");
    let image = ImageBuffer {
        data: png.clone(),
        format: ImageFormat::Png,
        width: 2,
        height: 2,
        scale_factor: 1.0,
    };
    let out = png_bytes_for_clipboard(&image).expect("png bytes");
    assert_eq!(out, png);
}

#[test]
fn truncated_dib_is_rejected() {
    let dib = build_dib(2, 2, 32, BI_RGB, BITMAPINFOHEADER_SIZE, [1, 2, 3, 4]);
    let error = dib_to_bgra(&dib[..dib.len() - 1]).expect_err("truncated pixels");
    assert_eq!(error.code, ErrorCode::ActionFailed);
}

#[test]
fn truncated_png_is_rejected() {
    let error = decode_png_clipboard(b"\x89PNG\r\n\x1a\n").expect_err("truncated PNG");
    assert_eq!(error.code, ErrorCode::ActionFailed);
}

#[test]
fn bgra_to_dib_is_bottom_up_cf_dib() {
    let bgra = [1u8, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255];
    let dib = bgra_to_dib(&bgra, 2, 2).expect("encode DIB");
    assert_eq!(
        u32::from_le_bytes(dib[0..4].try_into().unwrap()),
        BITMAPINFOHEADER_SIZE
    );
    assert_eq!(i32::from_le_bytes(dib[8..12].try_into().unwrap()), 2);
    let first_file_row = &dib[BITMAPINFOHEADER_SIZE as usize..];
    assert_eq!(&first_file_row[..4], &[7, 8, 9, 255]);
}
