use agent_desktop_core::Rect;

/// Screen-space extents as the toolkit reports them. Zero and negative
/// values are reported values, not errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Extents {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
}

impl From<Extents> for Rect {
    fn from(extents: Extents) -> Self {
        Self {
            x: f64::from(extents.x),
            y: f64::from(extents.y),
            width: f64::from(extents.width),
            height: f64::from(extents.height),
        }
    }
}
