use super::*;
use agent_desktop_core::ImageFormat;

fn image() -> ImageBuffer {
    ImageBuffer {
        data: vec![0; 4],
        format: ImageFormat::Png,
        width: 1,
        height: 1,
        scale_factor: 1.0,
    }
}

#[test]
fn image_validation_distinguishes_dimensions_scale_and_bytes() {
    let mut invalid_dimensions = image();
    invalid_dimensions.width = 0;
    let dimensions = validate_image(&invalid_dimensions).unwrap_err();
    assert!(dimensions.message.contains("dimensions"));

    let mut invalid_scale = image();
    invalid_scale.scale_factor = f64::NAN;
    let scale = validate_image(&invalid_scale).unwrap_err();
    assert!(scale.message.contains("scale factor"));

    let bytes = validate_image_parts(MAX_FFI_IMAGE_BYTES + 1, 1, 1, 1.0).unwrap_err();
    assert!(bytes.message.contains("byte limit"));
}
