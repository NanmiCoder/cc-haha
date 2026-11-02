pub(super) mod monitor_fault;
pub(super) mod monitor_reader;
pub(super) mod monitor_source;

use crate::tree::Extents;

/// One RandR monitor as the X server reports it: the monitor's own name, the
/// names of the outputs that drive it (the connectors Mutter names), its
/// screen-space bounds and whether it is the primary.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct X11Monitor {
    pub(crate) name: String,
    pub(crate) connectors: Vec<String>,
    pub(crate) bounds: Extents,
    pub(crate) primary: bool,
}
