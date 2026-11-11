use agent_desktop_core::{ErrorCode, ImageFormat, MAX_PNG_INPUT_BYTES, parse_png_dimensions};

use super::*;

fn decode(data: &[u8]) -> (png::OutputInfo, Vec<u8>) {
    let mut reader = png::Decoder::new(std::io::Cursor::new(data))
        .read_info()
        .unwrap();
    let mut out = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut out).unwrap();
    (info, out)
}

#[test]
fn encoded_pixels_decode_back_with_the_given_size_and_signature() {
    let rgb: Vec<u8> = (0..24).map(|n| n * 9).collect();
    let image = encode_png(&rgb, 4, 2, 2.0).unwrap();
    assert_eq!(&image.data[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(parse_png_dimensions(&image.data), Some((4, 2)));
    assert!(matches!(image.format, ImageFormat::Png));
    assert_eq!((image.width, image.height, image.scale_factor), (4, 2, 2.0));
    let (info, pixels) = decode(&image.data);
    assert_eq!(info.color_type, png::ColorType::Rgb);
    assert_eq!(info.bit_depth, png::BitDepth::Eight);
    assert_eq!(pixels, rgb);
}

#[test]
fn zero_width_or_height_is_refused() {
    assert!(encode_png(&[], 0, 2, 1.0).is_err());
    assert!(encode_png(&[], 2, 0, 1.0).is_err());
}

#[test]
fn one_pixel_over_the_limit_is_refused_and_the_limit_itself_passes() {
    assert_eq!(check_pixels(67_108_864, 1).unwrap(), 67_108_864);
    assert_eq!(check_pixels(8_192, 8_192).unwrap(), 67_108_864);
    let error = check_pixels(67_108_865, 1).unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(encode_png(&[], 67_108_865, 1, 1.0).is_err());
    assert!(check_pixels(65_000_000, 1).is_ok());
}

#[test]
fn the_encoded_size_limit_is_enforced_at_the_byte() {
    assert!(check_encoded(MAX_PNG_INPUT_BYTES).is_ok());
    assert!(check_encoded(MAX_PNG_INPUT_BYTES + 1).is_err());
}

#[test]
fn bytes_that_do_not_match_the_size_are_refused() {
    assert!(encode_png(&[0; 11], 2, 2, 1.0).is_err());
    assert!(encode_png(&[0; 13], 2, 2, 1.0).is_err());
}

struct Broken;

impl std::io::Write for Broken {
    fn write(&mut self, _bytes: &[u8]) -> std::io::Result<usize> {
        Err(std::io::Error::other("the sink is broken"))
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Err(std::io::Error::other("the sink is broken"))
    }
}

#[test]
fn an_encoder_failure_is_internal_and_a_refusal_is_not() {
    let error = write_png(&[0; 12], 2, 2, Broken).unwrap_err();
    assert_eq!(error.code, ErrorCode::Internal);
    let refusal = encode_png(&[0; 11], 2, 2, 1.0).unwrap_err();
    assert_eq!(refusal.code, ErrorCode::ActionFailed);
}
