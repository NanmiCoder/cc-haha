use super::{decode_png_to_bgra, encode_bgra_to_png};
use agent_desktop_core::{ErrorCode, MAX_PNG_INPUT_BYTES, parse_png_dimensions};
use std::fs;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_ENV_LOCK: Mutex<()> = Mutex::new(());

use crate::system::fixture::test_time::deadline;

fn pattern_bgra(width: u32, height: u32, stride: u32) -> Vec<u8> {
    let mut pixels = vec![0u8; (stride * height) as usize];
    for y in 0..height {
        for x in 0..width {
            let offset = (y * stride + x * 4) as usize;
            let i = (y * width + x) as usize;
            pixels[offset] = (i.wrapping_mul(17) % 256) as u8;
            pixels[offset + 1] = (i.wrapping_mul(31) % 256) as u8;
            pixels[offset + 2] = (i.wrapping_mul(47) % 256) as u8;
            pixels[offset + 3] = 255;
        }
    }
    pixels
}

fn packed_from_strided(pixels: &[u8], width: u32, height: u32, stride: u32) -> Vec<u8> {
    let row = (width * 4) as usize;
    let mut packed = Vec::with_capacity(row * height as usize);
    for y in 0..height {
        let start = (y * stride) as usize;
        packed.extend_from_slice(&pixels[start..start + row]);
    }
    packed
}

#[test]
fn known_bgra_encodes_with_dimensions_core_accepts() {
    crate::tree::fixture::bootstrap();
    let width = 5;
    let height = 4;
    let stride = width * 4;
    let pixels = pattern_bgra(width, height, stride);

    let png = encode_bgra_to_png(&pixels, width, height, stride, deadline(5_000))
        .expect("encode a known BGRA buffer");

    assert_eq!(parse_png_dimensions(&png), Some((width, height)));
}

#[test]
fn encode_decode_round_trips_non_square_and_padded_stride() {
    crate::tree::fixture::bootstrap();
    let cases = [(7u32, 3u32, 28u32), (3u32, 5u32, 16u32), (1u32, 1u32, 4u32)];
    for (width, height, stride) in cases {
        let pixels = pattern_bgra(width, height, stride);
        let expected = packed_from_strided(&pixels, width, height, stride);

        let png = encode_bgra_to_png(&pixels, width, height, stride, deadline(5_000))
            .expect("encode should succeed");
        let (decoded, out_w, out_h) =
            decode_png_to_bgra(&png, deadline(5_000)).expect("decode should succeed");

        assert_eq!((out_w, out_h), (width, height));
        assert_eq!(decoded, expected, "{width}x{height} stride={stride}");
    }
}

#[test]
fn thin_strip_round_trips() {
    crate::tree::fixture::bootstrap();
    let width = 2048;
    let height = 1;
    let stride = width * 4;
    let pixels = pattern_bgra(width, height, stride);

    let png = encode_bgra_to_png(&pixels, width, height, stride, deadline(5_000))
        .expect("encode a thin strip");
    let (decoded, out_w, out_h) =
        decode_png_to_bgra(&png, deadline(5_000)).expect("decode a thin strip");

    assert_eq!((out_w, out_h), (width, height));
    assert_eq!(decoded, pixels);
}

#[test]
fn zero_dimensions_rejected_before_com() {
    crate::tree::fixture::bootstrap();
    let pixels = [0u8; 4];

    let zero_width = encode_bgra_to_png(&pixels, 0, 1, 4, deadline(5_000)).expect_err("zero width");
    assert_eq!(zero_width.code, ErrorCode::InvalidArgs);
    assert!(
        zero_width.platform_detail.is_none(),
        "zero width must fail before COM: {:?}",
        zero_width.platform_detail
    );

    let zero_height =
        encode_bgra_to_png(&pixels, 1, 0, 4, deadline(5_000)).expect_err("zero height");
    assert_eq!(zero_height.code, ErrorCode::InvalidArgs);
    assert!(
        zero_height.platform_detail.is_none(),
        "zero height must fail before COM: {:?}",
        zero_height.platform_detail
    );
}

#[test]
fn malformed_png_returns_classified_error() {
    crate::tree::fixture::bootstrap();
    let width = 2;
    let height = 2;
    let stride = width * 4;
    let pixels = pattern_bgra(width, height, stride);
    let mut png = encode_bgra_to_png(&pixels, width, height, stride, deadline(5_000))
        .expect("encode a valid PNG to corrupt");
    for byte in &mut png[8..] {
        *byte ^= 0xff;
    }

    let error = decode_png_to_bgra(&png, deadline(5_000)).expect_err("corrupt PNG must fail");
    assert!(
        matches!(
            error.code,
            ErrorCode::InvalidArgs | ErrorCode::Internal | ErrorCode::ActionFailed
        ),
        "unexpected code {:?}",
        error.code
    );
    assert!(
        error.platform_detail.is_some(),
        "malformed PNG must carry a classified platform_detail"
    );
}

#[test]
fn wrong_signature_png_returns_classified_error() {
    crate::tree::fixture::bootstrap();
    let mut png = vec![1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    png.extend_from_slice(b"not-a-png-payload");

    let error = decode_png_to_bgra(&png, deadline(5_000)).expect_err("wrong signature must fail");
    assert_ne!(error.code, ErrorCode::Timeout);
    assert!(error.platform_detail.is_some() || error.code == ErrorCode::InvalidArgs);
}

#[test]
fn oversized_encode_rejected_before_allocation() {
    crate::tree::fixture::bootstrap();
    let tiny = [0u8; 4];
    let error = encode_bgra_to_png(&tiny, 1 << 15, 1 << 15, 1 << 17, deadline(5_000))
        .expect_err("pixel-ceiling violation must fail");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(error.platform_detail.is_none());

    let over_bytes = encode_bgra_to_png(&tiny, 4097, 4096, 4097 * 4, deadline(5_000))
        .expect_err("byte-ceiling violation must fail");
    assert_eq!(over_bytes.code, ErrorCode::InvalidArgs);
    assert!(over_bytes.platform_detail.is_none());
}

#[test]
fn oversized_decode_rejected_before_allocation() {
    crate::tree::fixture::bootstrap();
    let oversized = vec![0u8; MAX_PNG_INPUT_BYTES + 1];
    let error =
        decode_png_to_bgra(&oversized, deadline(5_000)).expect_err("oversize PNG must fail");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(error.platform_detail.is_none());
}

#[test]
fn encoding_creates_no_temp_files() {
    crate::tree::fixture::bootstrap();
    let _guard = TEMP_ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let sandbox = std::env::temp_dir().join(format!(
        "agent-desktop-png-codec-sandbox-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    fs::create_dir_all(&sandbox).expect("create private temp sandbox");
    let previous_tmp = std::env::var_os("TMP");
    let previous_temp = std::env::var_os("TEMP");
    unsafe {
        std::env::set_var("TMP", &sandbox);
        std::env::set_var("TEMP", &sandbox);
    }

    let width = 6;
    let height = 4;
    let stride = width * 4;
    let pixels = pattern_bgra(width, height, stride);
    let png = encode_bgra_to_png(&pixels, width, height, stride, deadline(5_000));

    let leftover: Vec<_> = fs::read_dir(&sandbox)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok().map(|e| e.path()))
                .collect()
        })
        .unwrap_or_default();
    match previous_tmp {
        Some(value) => unsafe { std::env::set_var("TMP", value) },
        None => unsafe { std::env::remove_var("TMP") },
    }
    match previous_temp {
        Some(value) => unsafe { std::env::set_var("TEMP", value) },
        None => unsafe { std::env::remove_var("TEMP") },
    }
    let _ = fs::remove_dir_all(&sandbox);

    let png = png.expect("encode must stay in memory");
    assert!(!png.is_empty());
    assert!(
        leftover.is_empty(),
        "encode must not create temp files, leftover: {leftover:?}"
    );
}
