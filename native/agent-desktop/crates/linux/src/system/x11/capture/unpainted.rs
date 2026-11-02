use super::grab::Raw;

const PIXEL_BYTES: usize = 4;

/// A rectangle inside a grabbed area, in the area's own coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::system::x11) struct Region {
    pub(in crate::system::x11) x: i32,
    pub(in crate::system::x11) y: i32,
    pub(in crate::system::x11) width: i32,
    pub(in crate::system::x11) height: i32,
}

fn pixel_at(raw: &Raw, x: usize, y: usize) -> Option<[u8; 3]> {
    let start = y * raw.stride + x * PIXEL_BYTES;
    let bytes = raw.data.get(start..start + 3)?;
    Some([bytes[0], bytes[1], bytes[2]])
}

/// Whether no pixel of the regions that lies inside both images is the same
/// in the two. A pixel equal to the screen's can be the screen's copy, which
/// can be the pixels of whatever covers the window, so only a region that
/// differs everywhere is the window's own paint. A grab with no pixel to
/// compare proves nothing.
pub(in crate::system::x11) fn differs_everywhere(
    screen: &Raw,
    pixmap: &Raw,
    regions: &[Region],
) -> bool {
    let width = screen.width.min(pixmap.width) as i32;
    let height = screen.height.min(pixmap.height) as i32;
    let mut compared = 0usize;
    for region in regions {
        let left = region.x.max(0);
        let top = region.y.max(0);
        let right = (region.x + region.width).min(width);
        let bottom = (region.y + region.height).min(height);
        for y in top..bottom {
            for x in left..right {
                let (x, y) = (x as usize, y as usize);
                if pixel_at(screen, x, y) == pixel_at(pixmap, x, y) {
                    return false;
                }
                compared += 1;
            }
        }
    }
    compared > 0
}

/// Whether a redirected pixmap is proven to hold the window's own paint over
/// the whole target: the repaint reports covered it, or the screen was read
/// and the pixmap differs from it everywhere. A missing screen read, a partial
/// repaint report and a partly differing pixmap are all unproven.
pub(in crate::system::x11) fn is_proven(
    damage_covered: bool,
    screen: Option<&Raw>,
    pixmap: &Raw,
    regions: &[Region],
) -> bool {
    damage_covered || screen.is_some_and(|shown| differs_everywhere(shown, pixmap, regions))
}

#[cfg(test)]
#[path = "unpainted_tests.rs"]
mod tests;
