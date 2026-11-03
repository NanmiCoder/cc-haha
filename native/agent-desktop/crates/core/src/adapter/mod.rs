pub(crate) mod actions;
pub(crate) mod adapter_session;
pub mod hit_test;
pub(crate) mod input;
pub mod live_element;
pub(crate) mod live_identity;
pub mod native_handle;
pub(crate) mod observation;
pub(crate) mod system;
#[cfg(test)]
mod test_support;

pub(crate) use actions::ActionOps;
pub(crate) use input::InputOps;
pub(crate) use observation::ObservationOps;
pub(crate) use observation::optional_live_read;
pub(crate) use system::SystemOps;
#[cfg(test)]
pub(crate) use test_support::{
    NoopAdapter, complete_live_observation, exact_window_focus, guarded_interaction_lease,
    live_identity, minimal_accessibility_node, minimal_ref_entry, observed_tree,
    recorded_action_state, test_report,
};

pub(crate) use crate::adapter::live_element::LiveElement;
pub(crate) use crate::adapter::native_handle::NativeHandle;
pub(crate) use crate::snapshot::snapshot_surface::SnapshotSurface;
pub(crate) use crate::system::screenshot_target::ScreenshotTarget;
pub(crate) use crate::system::window_filter::WindowFilter;
pub(crate) use crate::tree::tree_options::TreeOptions;

pub trait PlatformAdapter: ObservationOps + ActionOps + InputOps + SystemOps {}

impl<T: ObservationOps + ActionOps + InputOps + SystemOps> PlatformAdapter for T {}
