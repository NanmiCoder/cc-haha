/// A browser engine family whose accessibility tree fills in after launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WebFamily {
    Chromium,
    Gecko,
}
