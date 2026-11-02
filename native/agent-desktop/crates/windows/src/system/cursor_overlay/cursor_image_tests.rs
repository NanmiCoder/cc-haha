use super::*;

#[test]
fn an_opaque_sample_keeps_its_colour_and_a_clear_one_vanishes() {
    assert_eq!(premultiplied(&[255, 174, 0, 255]), 0xFF_FF_AE_00);
    assert_eq!(premultiplied(&[255, 255, 255, 0]), 0);
}

#[test]
fn a_half_transparent_sample_is_premultiplied() {
    assert_eq!(premultiplied(&[255, 0, 0, 128]), 0x80_80_00_00);
}

#[test]
fn the_image_hangs_from_its_hotspot_at_the_style_size() {
    let image = CursorImage::new(
        if cfg!(windows) {
            "C:\\cursor.png"
        } else {
            "/cursor.png"
        }
        .into(),
        Point { x: 18.0, y: 16.0 },
    )
    .expect("valid image");
    let decoded = DecodedImage {
        width: 200,
        height: 100,
        pixels: vec![0; 20_000],
    };
    let rect = image_rect(&Point { x: 100.0, y: 50.0 }, &image, &decoded, 0.5);
    assert_eq!(
        (rect.x, rect.y, rect.width, rect.height),
        (91.0, 42.0, 100.0, 50.0)
    );
}

#[test]
fn compositing_over_a_transparent_surface_copies_the_source() {
    let mut surface = Surface::try_transparent(2, 1).expect("surface");
    composite(&mut surface, 1, 0, 0x80_40_20_10);
    assert_eq!(surface.pixels, vec![0, 0x80_40_20_10]);
}

fn write_png(path: &std::path::Path, width: u32, height: u32) {
    let file = std::fs::File::create(path).expect("png file");
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let pixels = vec![255u8; (width * height * 4) as usize];
    encoder
        .write_header()
        .expect("png header")
        .write_image_data(&pixels)
        .expect("png pixels");
}

fn scratch_png(name: &str) -> std::path::PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "agent-desktop-cursor-image-{}-{name}",
        std::process::id()
    ));
    std::fs::create_dir_all(&directory).expect("scratch directory");
    directory.join("cursor.png")
}

fn image_at(path: &std::path::Path) -> CursorImage {
    CursorImage::new(
        path.to_str().expect("utf-8 path").into(),
        Point { x: 0.0, y: 0.0 },
    )
    .expect("valid image")
}

/// Replacing the PNG at the same path, then enabling again with it, has to
/// draw the new art rather than the decode cached for the old file.
#[test]
fn a_replaced_png_is_decoded_again() {
    let path = scratch_png("replaced");
    write_png(&path, 4, 4);
    let image = image_at(&path);
    assert_eq!(decoded(&image).expect("decodes").width, 4);

    write_png(&path, 8, 6);

    let refreshed = decoded(&image).expect("decodes the new file");
    assert_eq!((refreshed.width, refreshed.height), (8, 6));
    let _ = std::fs::remove_file(&path);
}

/// A file that failed to decode is not written off for good: once it is
/// fixed it is drawn.
#[test]
fn a_png_that_failed_to_decode_is_retried_once_it_changes() {
    let path = scratch_png("retried");
    std::fs::write(&path, b"not a png").expect("broken file");
    let image = image_at(&path);
    assert!(decoded(&image).is_none());

    write_png(&path, 5, 5);

    assert_eq!(decoded(&image).expect("decodes once fixed").width, 5);
    let _ = std::fs::remove_file(&path);
}
