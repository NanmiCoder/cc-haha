use crate::snapshot::snapshot_surface::SnapshotSurface;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TreeOptions {
    pub max_depth: u8,
    pub include_bounds: bool,
    pub interactive_only: bool,
    pub compact: bool,
    pub surface: SnapshotSurface,
    pub skeleton: bool,
    /// Whether the observation should assume Chromium renderer accessibility
    /// is (or will be) forced - the observation-mode hint surfaced as the
    /// `--force-electron-a11y` CLI flag.
    pub force_renderer_accessibility: bool,
}

impl Default for TreeOptions {
    fn default() -> Self {
        Self {
            max_depth: 10,
            include_bounds: false,
            interactive_only: false,
            compact: false,
            surface: SnapshotSurface::Window,
            skeleton: false,
            force_renderer_accessibility: false,
        }
    }
}

impl TreeOptions {
    pub(crate) fn with_ref_identity_bounds(mut self) -> Self {
        self.include_bounds = true;
        self
    }
}
