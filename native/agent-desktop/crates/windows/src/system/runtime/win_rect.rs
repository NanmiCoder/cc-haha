//! A Win32 `RECT` as the `Rect` the rest of the product speaks.
//!
//! The two describe the same box differently: `RECT` names its far edges,
//! `Rect` names its size. Converting means a subtraction on each axis, and
//! three separate readers had each written that subtraction out. They are the
//! kind of expression that reads correct while being wrong - a swapped pair or
//! a `left` where a `top` belongs still compiles, still produces a rectangle,
//! and produces one nothing downstream can tell from a real measurement.

#[cfg(target_os = "windows")]
pub(crate) use imp::rect_of;

#[cfg(target_os = "windows")]
mod imp {
    use agent_desktop_core::Rect;
    use windows_sys::Win32::Foundation::RECT;

    /// Width and height are derived rather than assumed non-negative: an
    /// inverted `RECT` is a read that went wrong, and answering a negative
    /// size says so downstream instead of quietly clamping it to nothing.
    pub(crate) fn rect_of(rect: &RECT) -> Rect {
        Rect {
            x: f64::from(rect.left),
            y: f64::from(rect.top),
            width: f64::from(rect.right - rect.left),
            height: f64::from(rect.bottom - rect.top),
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "win_rect_tests.rs"]
mod tests;
