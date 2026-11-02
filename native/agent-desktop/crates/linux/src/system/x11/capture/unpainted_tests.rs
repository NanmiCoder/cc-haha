use super::*;
use crate::system::capture::pixels::VisualFormat;

fn raw(width: u32, height: u32, fill: impl Fn(u32, u32) -> [u8; 3]) -> Raw {
    let mut data = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let [a, b, c] = fill(x, y);
            data.extend_from_slice(&[a, b, c, 0]);
        }
    }
    Raw {
        data,
        width,
        height,
        stride: width as usize * PIXEL_BYTES,
        format: VisualFormat {
            red_mask: 0xff0000,
            green_mask: 0xff00,
            blue_mask: 0xff,
            bits_per_pixel: 32,
            depth: 24,
            scanline_pad: 32,
            msb_first: false,
        },
    }
}

const WHOLE: Region = Region {
    x: 0,
    y: 0,
    width: 4,
    height: 3,
};

#[test]
fn one_pixel_equal_to_the_screen_in_the_region_is_not_proven() {
    let screen = raw(4, 3, |_, _| [1, 2, 3]);
    let pixmap = raw(4, 3, |x, y| {
        if (x, y) == (2, 1) {
            [1, 2, 3]
        } else {
            [9, 9, 9]
        }
    });
    assert!(!differs_everywhere(&screen, &pixmap, &[WHOLE]));
}

#[test]
fn a_difference_outside_every_region_is_not_looked_at() {
    let screen = raw(4, 3, |_, _| [1, 2, 3]);
    let pixmap = raw(4, 3, |x, _| if x == 0 { [1, 2, 3] } else { [9, 9, 9] });
    let content = Region {
        x: 1,
        y: 0,
        width: 3,
        height: 3,
    };
    assert!(differs_everywhere(&screen, &pixmap, &[content]));
}

#[test]
fn the_padding_byte_is_not_compared() {
    let screen = raw(4, 3, |_, _| [1, 2, 3]);
    let mut pixmap = raw(4, 3, |_, _| [1, 2, 3]);
    pixmap.data[3] = 0xff;
    assert!(!differs_everywhere(&screen, &pixmap, &[WHOLE]));
}

#[test]
fn a_region_with_no_pixel_inside_the_images_proves_nothing() {
    let screen = raw(4, 3, |_, _| [1, 2, 3]);
    let pixmap = raw(4, 3, |_, _| [9, 9, 9]);
    let outside = Region {
        x: 10,
        y: 10,
        width: 5,
        height: 5,
    };
    assert!(!differs_everywhere(&screen, &pixmap, &[outside]));
    assert!(!differs_everywhere(&screen, &pixmap, &[]));
}

#[test]
fn a_region_reaching_past_the_images_is_clipped() {
    let screen = raw(4, 3, |_, _| [1, 2, 3]);
    let pixmap = raw(4, 3, |_, _| [9, 9, 9]);
    let past = Region {
        x: -2,
        y: -2,
        width: 100,
        height: 100,
    };
    assert!(differs_everywhere(&screen, &pixmap, &[past]));
}

#[test]
fn a_missing_screen_read_with_no_covering_repaint_is_unproven() {
    let pixmap = raw(4, 3, |_, _| [9, 9, 9]);
    assert!(!is_proven(false, None, &pixmap, &[WHOLE]));
}

#[test]
fn a_partly_differing_pixmap_with_no_covering_repaint_is_unproven() {
    let screen = raw(4, 3, |_, _| [1, 2, 3]);
    let pixmap = raw(4, 3, |x, _| if x == 3 { [9, 9, 9] } else { [1, 2, 3] });
    assert!(!is_proven(false, Some(&screen), &pixmap, &[WHOLE]));
}

#[test]
fn a_covering_repaint_proves_the_pixmap_without_a_screen() {
    let pixmap = raw(4, 3, |_, _| [9, 9, 9]);
    assert!(is_proven(true, None, &pixmap, &[WHOLE]));
}

#[test]
fn a_pixmap_that_differs_everywhere_is_proven_without_a_repaint() {
    let screen = raw(4, 3, |_, _| [1, 2, 3]);
    let pixmap = raw(4, 3, |_, _| [9, 9, 9]);
    assert!(is_proven(false, Some(&screen), &pixmap, &[WHOLE]));
}
