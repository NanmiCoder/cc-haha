use agent_desktop_core::Rect;

use super::*;

fn display(id: &str, x: f64, y: f64, width: f64, height: f64, scale: f64) -> DisplayInfo {
    DisplayInfo {
        id: id.into(),
        bounds: Rect {
            x,
            y,
            width,
            height,
        },
        is_primary: x == 0.0,
        scale,
    }
}

fn rect(x: u32, y: u32, width: u32, height: u32) -> PixelRect {
    PixelRect {
        x,
        y,
        width,
        height,
    }
}

#[test]
fn logical_rectangles_with_one_common_scale_are_multiplied() {
    let all = [display("a", 0.0, 0.0, 1280.0, 800.0, 2.0)];
    assert_eq!(
        pixel_rect(&all[0], &all, (2560, 1600)).expect("a rect"),
        rect(0, 0, 2560, 1600)
    );
}

#[test]
fn rectangles_already_in_image_pixels_win_with_mixed_scales() {
    let all = [
        display("a", 0.0, 0.0, 2560.0, 1600.0, 2.0),
        display("b", 2560.0, 0.0, 800.0, 600.0, 1.0),
    ];
    assert_eq!(
        pixel_rect(&all[1], &all, (3360, 1600)).expect("a rect"),
        rect(2560, 0, 800, 600)
    );
}

#[test]
fn an_origin_that_is_not_zero_is_removed() {
    let all = [
        display("a", -1280.0, 0.0, 1280.0, 800.0, 1.0),
        display("b", 0.0, 0.0, 800.0, 600.0, 1.0),
    ];
    assert_eq!(
        pixel_rect(&all[0], &all, (2080, 800)).expect("a rect"),
        rect(0, 0, 1280, 800)
    );
}

#[test]
fn an_image_that_fits_no_hypothesis_is_refused() {
    let all = [
        display("a", 0.0, 0.0, 1280.0, 800.0, 2.0),
        display("b", 1280.0, 0.0, 800.0, 600.0, 1.0),
    ];
    let error = pixel_rect(&all[0], &all, (2000, 1000)).expect_err("no mapping");
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
}

#[test]
fn mixed_logical_scales_that_the_image_does_not_confirm_are_refused() {
    let all = [
        display("a", 0.0, 0.0, 1280.0, 800.0, 2.0),
        display("b", 1280.0, 0.0, 800.0, 600.0, 1.0),
    ];
    assert!(pixel_rect(&all[0], &all, (2080, 800)).is_ok());
    assert!(pixel_rect(&all[0], &all, (2560, 1600)).is_err());
}

fn gradient(width: u32, height: u32, alpha: bool) -> Vec<u8> {
    let channels = if alpha { 4 } else { 3 };
    let mut data = Vec::new();
    for y in 0..height {
        for x in 0..width {
            data.extend_from_slice(&[x as u8, y as u8, (x + y) as u8]);
            if alpha {
                data.push(255);
            }
        }
    }
    assert_eq!(data.len(), (width * height) as usize * channels);
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(if alpha {
        ColorType::Rgba
    } else {
        ColorType::Rgb
    });
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().expect("a header");
    writer.write_image_data(&data).expect("pixels");
    writer.finish().expect("done");
    out
}

fn pixels_of(image: &ImageBuffer) -> Vec<u8> {
    let mut reader = Decoder::new(Cursor::new(&image.data))
        .read_info()
        .expect("png");
    let mut frame = vec![0; reader.output_buffer_size().expect("size")];
    let info = reader.next_frame(&mut frame).expect("frame");
    frame[..info.buffer_size()].to_vec()
}

#[test]
fn a_crop_returns_exactly_the_pixels_of_its_rectangle() {
    for alpha in [false, true] {
        let cut = crop_png(&gradient(40, 30, alpha), rect(10, 5, 8, 6), 2.0).expect("a crop");
        assert_eq!((cut.width, cut.height, cut.scale_factor), (8, 6, 2.0));
        let mut want = Vec::new();
        for y in 5..11u32 {
            for x in 10..18u32 {
                want.extend_from_slice(&[x as u8, y as u8, (x + y) as u8]);
            }
        }
        assert_eq!(pixels_of(&cut), want, "alpha={alpha}");
    }
}

#[test]
fn a_rectangle_past_the_image_is_refused() {
    assert!(crop_png(&gradient(40, 30, false), rect(35, 0, 10, 5), 1.0).is_err());
    assert!(crop_png(b"not a png", rect(0, 0, 1, 1), 1.0).is_err());
}
