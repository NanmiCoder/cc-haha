mod adapter;
pub(crate) mod ax_element;
pub(crate) mod build_context;
pub(crate) mod child_labels;
pub(crate) mod element_bounds;
pub(crate) mod element_dedupe;
pub(crate) mod element_name;
pub(crate) mod hit_test;
pub(crate) mod locator_deadline;
pub(crate) mod observation_usage;
pub(crate) mod properties;
pub(crate) mod query;
#[cfg(target_os = "macos")]
pub(crate) mod read_recovery;
pub(crate) mod renderer_probe;
pub(crate) mod resolve;
pub(crate) mod roles;
pub(crate) mod state_reader;
pub(crate) mod surface_inventory;
pub(crate) mod surface_read;
pub(crate) mod surfaces;
pub(crate) mod window_surface;

pub(crate) use ax_element::AXElement;
pub(crate) use build_context::TreeBuildContext;
pub(crate) use properties::attributes::{copy_bool_attr, copy_value_typed};
pub(crate) use properties::capabilities::same_element;
pub(crate) use properties::element::element_for_pid;
pub(crate) use properties::node_attrs::NodeAttrs;
