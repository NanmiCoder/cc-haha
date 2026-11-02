use super::*;

#[test]
fn image_io_accepts_complete_png() {
    assert!(is_complete_png(&one_pixel_png()));
}

#[test]
fn image_io_rejects_truncated_png() {
    let png = one_pixel_png();

    assert!(!is_complete_png(&png[..png.len() - 12]));
}

#[test]
fn image_io_rejects_corrupted_png() {
    let mut png = one_pixel_png();
    png[45] ^= 0xff;

    assert!(!is_complete_png(&png));
}

fn one_pixel_png() -> [u8; 68] {
    [
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4,
        0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5,
        1, 1, 39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]
}
