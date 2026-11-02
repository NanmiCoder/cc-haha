use super::{dim_region, dim_surface};
use crate::system::cursor_overlay::raster::Surface;
use agent_desktop_core::Rect;

fn opaque(width: i32, height: i32, pixel: u32) -> Surface {
    Surface {
        width,
        height,
        pixels: vec![pixel; (width as usize) * (height as usize)],
    }
}

const WHITE: u32 = 0xFFFF_FFFF;

fn alpha_of(surface: &Surface, x: i32, y: i32) -> u8 {
    let index = (y as usize) * (surface.width as usize) + (x as usize);
    (surface.pixels[index] >> 24) as u8
}

/// The surface is premultiplied, so a fade has to scale colour with alpha. If
/// only alpha moved, a white card at half opacity would keep full-strength
/// colour behind a half-strength alpha and read as a grey card rather than a
/// receding one.
#[test]
fn every_channel_scales_together_rather_than_alpha_alone() {
    let mut surface = opaque(2, 2, WHITE);

    dim_surface(&mut surface, 0.5);

    for pixel in &surface.pixels {
        for shift in [24, 16, 8, 0] {
            assert_eq!(
                (pixel >> shift) & 0xFF,
                128,
                "channel at {shift} did not scale with the rest: {pixel:#010x}"
            );
        }
    }
}

#[test]
fn a_full_factor_leaves_the_surface_exactly_as_it_was() {
    let mut surface = opaque(3, 3, 0x8040_2010);
    let before = surface.pixels.clone();

    dim_surface(&mut surface, 1.0);

    assert_eq!(surface.pixels, before);
}

#[test]
fn a_zero_factor_clears_the_region_completely() {
    let mut surface = opaque(2, 2, WHITE);

    dim_surface(&mut surface, 0.0);

    assert!(surface.pixels.iter().all(|pixel| *pixel == 0));
}

/// The card fades on its own while the cursor beside it does not, so the
/// region has to be respected rather than the whole surface dimmed.
#[test]
fn a_region_fade_leaves_the_pixels_outside_it_untouched() {
    let mut surface = opaque(4, 4, WHITE);

    dim_region(
        &mut surface,
        &Rect {
            x: 0.0,
            y: 0.0,
            width: 2.0,
            height: 2.0,
        },
        0.25,
    );

    assert_eq!(alpha_of(&surface, 0, 0), 64, "inside the region fades");
    assert_eq!(alpha_of(&surface, 1, 1), 64, "inside the region fades");
    assert_eq!(alpha_of(&surface, 3, 3), 255, "outside it does not");
    assert_eq!(alpha_of(&surface, 0, 3), 255, "outside it does not");
}

/// A rectangle that runs past the surface must dim what overlaps and not
/// index past the buffer.
#[test]
fn a_region_overhanging_the_surface_dims_only_what_overlaps() {
    let mut surface = opaque(3, 3, WHITE);

    dim_region(
        &mut surface,
        &Rect {
            x: 1.0,
            y: 1.0,
            width: 99.0,
            height: 99.0,
        },
        0.0,
    );

    assert_eq!(alpha_of(&surface, 0, 0), 255);
    assert_eq!(alpha_of(&surface, 2, 2), 0);
}

/// A negative origin is the other half of the same guard.
#[test]
fn a_region_starting_before_the_surface_is_clamped() {
    let mut surface = opaque(3, 3, WHITE);

    dim_region(
        &mut surface,
        &Rect {
            x: -50.0,
            y: -50.0,
            width: 51.0,
            height: 51.0,
        },
        0.0,
    );

    assert_eq!(alpha_of(&surface, 0, 0), 0, "the overlapping corner dims");
    assert_eq!(alpha_of(&surface, 2, 2), 255, "the rest is untouched");
}
