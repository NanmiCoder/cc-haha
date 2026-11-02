#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

//! # agent-desktop FFI
//!
//! C-ABI surface over `PlatformAdapter`. Exposes
//! `libagent_desktop_ffi.{dylib,so,dll}` to Python / Swift / Go / Node /
//! C++ consumers.
//!
//! ## Thread safety
//!
//! Adapters are safe to call from multiple host threads. Native element handles
//! are thread-affine registry capabilities and must be used and released on the
//! thread that resolved them. Desktop mutations are serialized by the adapter's
//! cross-process interaction lease.
//!
//! ## Build profile
//!
//! The cdylib must be built with the workspace's `release-ffi` profile:
//!
//! ```text
//! cargo build --profile release-ffi -p agent-desktop-ffi
//! ```
//!
//! The workspace `release` profile keeps `panic = "abort"` to hold the
//! CLI under its size budget; the cdylib needs `panic = "unwind"` so the
//! `trap_panic` boundary actually catches. Both profiles coexist.
//!
//! ## Error model
//!
//! Every `AdResult`-returning fn sets thread-local last-error details on
//! failure. The pointer returned by `ad_last_error_message()` survives
//! any number of subsequent successful calls on the same thread; only
//! the next *failing* call rotates it. Matches POSIX `errno` semantics.

#[cfg(panic = "abort")]
compile_error!(
    "agent-desktop-ffi requires panic=unwind; build with --profile release-ffi, not --release"
);

pub(crate) mod abi_version;
pub(crate) mod actions;
pub(crate) mod adapter;
pub(crate) mod apps;
pub(crate) mod commands;
pub(crate) mod convert;
pub(crate) mod displays;
pub(crate) mod enum_validation;
pub mod error;
pub(crate) mod ffi_try;
pub(crate) mod input;
pub(crate) mod log_callback;
pub(crate) mod notifications;
pub(crate) mod observation;
pub(crate) mod opaque_id;
pub(crate) mod operation;
#[cfg(feature = "panic-injection")]
pub(crate) mod panic_injection;
pub(crate) mod pointer_guard;
pub(crate) mod resource;
pub(crate) mod screenshot;
pub(crate) mod session_lease;
pub(crate) mod surfaces;
pub(crate) mod tree;
pub(crate) mod types;
pub(crate) mod windows;

pub use abi_version::AD_ABI_VERSION_MAJOR;
pub use adapter::AdAdapter;
pub use error::AdResult;
pub use types::action::{AD_ACTION_SIZE, AdAction, ad_action_size};
pub use types::action_kind::AdActionKind;
pub use types::action_result::{AD_ACTION_RESULT_SIZE, AdActionResult, ad_action_result_size};
pub use types::action_step::{AD_ACTION_STEP_SIZE, AdActionStep, ad_action_step_size};
pub use types::app_info::AdAppInfo;
pub use types::app_list::AdAppList;
pub use types::delivery_disposition::AdDeliveryDisposition;
pub use types::delivery_semantics::{AD_DELIVERY_SEMANTICS_SIZE, AdDeliverySemantics};
pub use types::direction::AdDirection;
pub use types::display_info::{
    AD_DISPLAY_INFO_SIZE, AD_DISPLAY_INFO_VERSION, AdDisplayInfo, ad_display_info_size,
};
pub use types::display_list::AdDisplayList;
pub use types::drag_params::{AD_DRAG_PARAMS_SIZE, AdDragParams, ad_drag_params_size};
pub use types::element_state::{AD_ELEMENT_STATE_SIZE, AdElementState, ad_element_state_size};
pub use types::exact_ref_entry::{
    AD_EXACT_REF_ENTRY_SIZE, AD_EXACT_REF_ENTRY_VERSION, AdExactRefEntry, ad_exact_ref_entry_size,
};
pub use types::exact_surface_info::{
    AD_EXACT_SURFACE_INFO_SIZE, AD_EXACT_SURFACE_INFO_VERSION, AdExactSurfaceInfo,
    ad_exact_surface_info_size,
};
pub use types::exact_surface_list::AdExactSurfaceList;
pub use types::exact_window_info::{
    AD_EXACT_WINDOW_INFO_SIZE, AD_EXACT_WINDOW_INFO_VERSION, AdExactWindowInfo,
    ad_exact_window_info_size,
};
pub use types::exact_window_list::AdExactWindowList;
pub use types::find_control::{AD_FIND_CONTROL_SIZE, AdFindControl};
pub use types::find_filter::{AD_FIND_FILTER_SIZE, AdFindFilter};
pub use types::find_identity::{AD_FIND_IDENTITY_SIZE, AdFindIdentity};
pub use types::find_query::{AD_FIND_QUERY_SIZE, AD_FIND_QUERY_VERSION, AdFindQuery};
pub use types::find_selection::{AD_FIND_SELECTION_SIZE, AdFindSelection};
pub use types::find_selection_kind::AdFindSelectionKind;
pub use types::find_state_predicate::{AD_FIND_STATE_PREDICATE_SIZE, AdFindStatePredicate};
pub use types::find_state_slice::{AD_FIND_STATE_SLICE_SIZE, AdFindStateSlice};
pub use types::identifier_kind::AdIdentifierKind;
pub use types::image_buffer::AdImageBuffer;
pub use types::image_format::AdImageFormat;
pub use types::key_combo::AdKeyCombo;
pub use types::modifier::{AD_MODIFIER_CMD, AdModifier};
pub use types::mouse_button::AdMouseButton;
pub use types::mouse_event::AdMouseEvent;
pub use types::mouse_event_kind::AdMouseEventKind;
pub use types::native_handle::AdNativeHandle;
pub use types::node::{AD_NODE_SIZE, AdNode};
pub use types::node_content::{AD_NODE_CONTENT_SIZE, AdNodeContent};
pub use types::node_presentation::{AD_NODE_PRESENTATION_SIZE, AdNodePresentation};
pub use types::node_relation::{AD_NODE_RELATION_SIZE, AdNodeRelation};
pub use types::node_tree::AdNodeTree;
pub use types::notification_action_request::{
    AD_NOTIFICATION_ACTION_REQUEST_SIZE, AdNotificationActionRequest,
};
pub use types::notification_filter::AdNotificationFilter;
pub use types::notification_identity::{AD_NOTIFICATION_IDENTITY_SIZE, AdNotificationIdentity};
pub use types::notification_info::AdNotificationInfo;
pub use types::notification_list::AdNotificationList;
pub use types::optional_u64::{AD_OPTIONAL_U64_SIZE, AdOptionalU64};
pub use types::optional_usize::{AD_OPTIONAL_USIZE_SIZE, AdOptionalUsize};
pub use types::point::AdPoint;
pub use types::policy_kind::AdPolicyKind;
pub use types::rect::AdRect;
pub use types::ref_capabilities::{AD_REF_CAPABILITIES_SIZE, AdRefCapabilities};
pub use types::ref_entry::{
    AD_MAX_REF_ACTIONS, AD_MAX_REF_PATH_DEPTH, AD_MAX_REF_STATES, AD_REF_ENTRY_SIZE, AdRefEntry,
    ad_ref_entry_size,
};
pub use types::ref_geometry::{
    AD_BOUNDS_SPACE_SCREEN, AD_BOUNDS_SPACE_UNKNOWN, AD_BOUNDS_SPACE_WINDOW, AD_REF_GEOMETRY_SIZE,
    AdRefGeometry,
};
pub use types::ref_identity::{AD_REF_IDENTITY_SIZE, AdRefIdentity};
pub use types::ref_process::{AD_REF_PROCESS_SIZE, AdRefProcess};
pub use types::ref_scope::{AD_REF_SCOPE_SIZE, AdRefScope};
pub use types::ref_source::{AD_REF_SOURCE_SIZE, AdRefSource};
pub use types::retry_disposition::AdRetryDisposition;
pub use types::screenshot_kind::AdScreenshotKind;
pub use types::screenshot_target::AdScreenshotTarget;
pub use types::scroll_params::AdScrollParams;
pub use types::snapshot_surface::AdSnapshotSurface;
pub use types::step_mechanism::AdStepMechanism;
pub use types::string_slice::{AD_STRING_SLICE_SIZE, AdStringSlice};
pub use types::surface_info::AdSurfaceInfo;
pub use types::tree_options::AdTreeOptions;
pub use types::wait_args::{AD_WAIT_ARGS_SIZE, AdWaitArgs, ad_wait_args_size};
pub use types::wait_mode::{AD_WAIT_MODE_SIZE, AdWaitMode};
pub use types::wait_predicate::{AD_WAIT_PREDICATE_SIZE, AdWaitPredicate};
pub use types::wait_scope::{AD_WAIT_SCOPE_SIZE, AdWaitScope};
pub use types::wait_surface_modes::{AD_WAIT_SURFACE_MODES_SIZE, AdWaitSurfaceModes};
pub use types::window_info::AdWindowInfo;
pub use types::window_op::AdWindowOp;
pub use types::window_op_kind::AdWindowOpKind;
