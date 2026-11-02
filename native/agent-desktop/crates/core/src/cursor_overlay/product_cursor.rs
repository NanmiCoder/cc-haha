//! Product arrow geometry shared by the Windows and X11 renderers.

pub const PRODUCT_CURSOR_WIDTH: f64 = 14.0;
pub const PRODUCT_CURSOR_HEIGHT: f64 = 22.0;
pub const PRODUCT_CURSOR_OUTLINE: f64 = 1.5;
pub const PRODUCT_CURSOR_ARROW: [(f64, f64); 7] = [
    (0.0, 0.0),
    (0.0, 16.5 * 22.0 / 19.0),
    (4.0 * 22.0 / 19.0, 12.7 * 22.0 / 19.0),
    (6.6 * 22.0 / 19.0, 18.5 * 22.0 / 19.0),
    (9.2 * 22.0 / 19.0, 17.4 * 22.0 / 19.0),
    (6.6 * 22.0 / 19.0, 11.6 * 22.0 / 19.0),
    (11.6 * 22.0 / 19.0, 11.2 * 22.0 / 19.0),
];

#[cfg(test)]
#[path = "product_cursor_tests.rs"]
mod tests;
