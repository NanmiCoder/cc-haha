use super::grab_rect::GrabRect;

/// The bounding box of the damage reports seen on one window, in the
/// window's own coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::system::x11) struct DamageBounds {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl DamageBounds {
    pub(in crate::system::x11) fn of(x: i16, y: i16, width: u16, height: u16) -> Self {
        Self {
            left: i32::from(x),
            top: i32::from(y),
            right: i32::from(x) + i32::from(width),
            bottom: i32::from(y) + i32::from(height),
        }
    }

    pub(in crate::system::x11) fn merged(self, other: Self) -> Self {
        Self {
            left: self.left.min(other.left),
            top: self.top.min(other.top),
            right: self.right.max(other.right),
            bottom: self.bottom.max(other.bottom),
        }
    }

    pub(in crate::system::x11) fn covers(self, rect: GrabRect) -> bool {
        rect.width > 0
            && rect.height > 0
            && self.left <= i32::from(rect.x)
            && self.top <= i32::from(rect.y)
            && self.right >= i32::from(rect.x) + i32::from(rect.width)
            && self.bottom >= i32::from(rect.y) + i32::from(rect.height)
    }
}

#[cfg(test)]
#[path = "damage_bounds_tests.rs"]
mod tests;
