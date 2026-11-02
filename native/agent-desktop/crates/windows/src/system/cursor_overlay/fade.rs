//! Dimming an already-composed region of the surface.
//!
//! macOS fades by animating a window's layer opacity and letting the
//! compositor do the work. There is no equivalent here: the overlay is one
//! layered window presented with `UpdateLayeredWindow`, so a fade has to be
//! in the pixels.
//!
//! It runs **after** everything else, and that ordering is the whole reason
//! this is a separate pass rather than an opacity threaded through the
//! rasterizer. GDI draws the label's text with no alpha at all, so the text
//! may only be written where the card beneath it is already opaque; fading
//! the card first would leave the glyphs to be drawn onto transparency and
//! then forced back to opaque, which is the card reappearing at full strength
//! with only its border faded. Draw at full strength, then dim what was
//! drawn.

use super::raster::Surface;
use agent_desktop_core::Rect;

/// Multiplies every channel of every pixel in `rect` by `factor`.
///
/// The surface is premultiplied, so alpha and colour scale together and a
/// uniform multiply is the correct dim - scaling alpha alone would leave the
/// colour too strong and the region would darken as it faded rather than
/// receding.
pub(crate) fn dim_region(surface: &mut Surface, rect: &Rect, factor: f64) {
    if factor >= 1.0 {
        return;
    }
    let factor = factor.clamp(0.0, 1.0);
    let left = rect.x.floor().max(0.0) as i32;
    let top = rect.y.floor().max(0.0) as i32;
    let right = (rect.x + rect.width).ceil().min(f64::from(surface.width)) as i32;
    let bottom = (rect.y + rect.height).ceil().min(f64::from(surface.height)) as i32;

    for y in top..bottom {
        for x in left..right {
            let index = (y as usize) * (surface.width as usize) + (x as usize);
            let Some(pixel) = surface.pixels.get(index).copied() else {
                continue;
            };
            surface.pixels[index] = dim_pixel(pixel, factor);
        }
    }
}

/// The whole surface, for the fade the overlay plays when it rests.
pub(crate) fn dim_surface(surface: &mut Surface, factor: f64) {
    let bounds = Rect {
        x: 0.0,
        y: 0.0,
        width: f64::from(surface.width),
        height: f64::from(surface.height),
    };
    dim_region(surface, &bounds, factor);
}

fn dim_pixel(pixel: u32, factor: f64) -> u32 {
    let scale = |shift: u32| {
        let channel = f64::from(((pixel >> shift) & 0xFF) as u8);
        ((channel * factor).round().clamp(0.0, 255.0) as u32) << shift
    };
    scale(24) | scale(16) | scale(8) | scale(0)
}

#[cfg(test)]
#[path = "fade_tests.rs"]
mod tests;
