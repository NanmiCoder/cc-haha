#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

pub(crate) mod actionability;
pub mod actions;
pub mod adapter;
pub mod commands;
pub mod context;
pub mod cursor_overlay;
mod input;
pub(crate) mod locator;
mod notifications;
pub mod ref_action;
pub mod refs;
pub mod response;
pub mod session;
pub mod snapshot;
mod storage;
pub mod system;
pub mod trace;
pub mod tree;
mod wait;

pub use actions::action::Action;
pub use actions::action_request::ActionRequest;
pub use actions::action_result::ActionResult;
pub use actions::action_step::ActionStep;
pub use actions::action_step_outcome::ActionStepOutcome;
pub use actions::delivery_semantics::DeliverySemantics;
pub use actions::headed_requirement::HeadedRequirement;
pub use actions::interaction_policy::InteractionPolicy;
pub use actions::post_action::execute_verified_action;
pub use actions::step_mechanism::StepMechanism;
pub use adapter::PlatformAdapter;
pub use adapter::actions::ActionOps;
pub use adapter::adapter_session::AdapterSession;
pub use adapter::hit_test::HitTestResult;
pub use adapter::input::InputOps;
pub use adapter::live_element::LiveElement;
pub use adapter::live_identity::LiveIdentity;
pub use adapter::native_handle::NativeHandle;
pub use adapter::observation::ObservationOps;
pub use adapter::system::SystemOps;
pub use context::{CommandContext, WaitSelector};
pub use cursor_overlay::{
    CURSOR_ARRIVAL_TIMEOUT_MS, CURSOR_HIGHLIGHT_HOLD_MS, CURSOR_IDLE_REST_MS,
    CURSOR_LABEL_REVEAL_MS, CURSOR_MOTION_BUDGET_MS, CURSOR_OVERLAY_GREETING, CURSOR_REST_FADE_MS,
    CURSOR_SAME_POINT, CursorImage, CursorImages, CursorMotion, CursorMotionProfile,
    CursorOverlayConfig, CursorOverlayControl, CursorOverlayInstruction, CursorOverlayStyle,
    CursorPhase, CursorPose, LABEL_FONT_POINTS, LABEL_PILL_HEIGHT, LABEL_PILL_MAX_WIDTH,
    LABEL_PILL_PADDING, LABEL_SHADOW_BLUR, LABEL_SHADOW_OFFSET, LABEL_SHADOW_OPACITY, LabelPill,
    MAX_CURSOR_IMAGE_BYTES, MAX_CURSOR_IMAGE_PATH_BYTES, MAX_CURSOR_IMAGE_PIXELS,
    MAX_CURSOR_LABEL_BYTES, MAX_CURSOR_LABEL_WORDS, PRODUCT_CURSOR_ARROW, PRODUCT_CURSOR_HEIGHT,
    PRODUCT_CURSOR_OUTLINE, PRODUCT_CURSOR_WIDTH, place_label,
};
pub use input::clipboard_content::ClipboardContent;
pub use input::clipboard_format::ClipboardFormat;
pub use input::direction::Direction;
pub use input::drag_params::{
    DragParams, MAX_DRAG_DROP_DELAY_MS, MAX_DRAG_DURATION_MS, MAX_DRAG_STEPS,
};
pub use input::key_combo::KeyCombo;
pub use input::modifier::Modifier;
pub use input::mouse_button::MouseButton;
pub use input::mouse_click_count::{MAX_MOUSE_CLICK_COUNT, validate_mouse_click_count};
pub use input::mouse_event::MouseEvent;
pub use input::mouse_event_kind::MouseEventKind;
pub use input::pointer_observation::PointerObservation;
pub use locator::containment_predicate::ContainmentPredicate;
pub use locator::identity_predicate::IdentityPredicate;
pub use locator::live_locator::{
    EvidenceRequirements, IdentifierEvidence, LocatorCardinality, LocatorEvidence, LocatorField,
    LocatorIdentifierStats, LocatorLimitStats, LocatorMaterialization, LocatorReadCounts,
    LocatorReadHealth, LocatorReadStats, LocatorRefEvidence, LocatorResolution,
    LocatorResolveRequest, LocatorSelection, LocatorSemanticReadStats, LocatorStats,
    LocatorTraversalStats, ObservationBudget, ObservationMode, ObservationRequest, ObservationRoot,
    ObservationSource, ObservedSubtree, ObservedTree, classify_query_result, evaluate_locator_tree,
    require_unique, resolve_query,
};
pub use locator::state_predicate::StatePredicate;
pub use locator::{
    LocatorQuery, accessibility_node_matches, node_context, node_matches, role_matches,
};
pub use notifications::dismiss_all_notifications_request::DismissAllNotificationsRequest;
pub use notifications::dismiss_notification_request::DismissNotificationRequest;
pub use notifications::notification_action_request::NotificationActionRequest;
pub use notifications::notification_filter::NotificationFilter;
pub use notifications::notification_identity::NotificationIdentity;
pub use notifications::notification_identity_check::verify_notification_identity;
pub use notifications::notification_info::NotificationInfo;
pub use refs::RefMap;
pub use refs::ref_capabilities::RefCapabilities;
pub use refs::ref_entry::RefEntry;
pub use refs::ref_entry_identity::RefEntryIdentity;
pub use refs::ref_geometry::RefGeometry;
pub use refs::ref_identity_match::IdentityMatch;
pub use refs::ref_process::RefProcess;
pub use refs::ref_scope::RefScope;
pub use refs::ref_source::RefSource;
pub use refs::refs_store::RefStore;
pub use response::adapter_error::AdapterError;
pub use response::app_error::AppError;
pub use response::delivery_disposition::DeliveryDisposition;
pub use response::error_code::ErrorCode;
pub use response::output::{ErrorPayload, Response};
pub use response::recovery_hint::RecoveryHint;
pub use response::retry_disposition::RetryDisposition;
pub use session::interaction_lease::InteractionLease;
#[cfg(unix)]
pub use session::interaction_lease::{
    INTERACTION_LEASE_FD_ENV, acquire_unix_interaction_lease,
    adopt_inherited_unix_interaction_lease,
};
pub use session::process_lease_guard::ProcessLeaseGuard;
pub use session::session_affinity::SessionAffinity;
pub use snapshot::snapshot_surface::SnapshotSurface;
pub use storage::file_lock::FileLock;
pub use storage::private_file_ops::{
    PrivateFileOps, bounded_read, install_private_file_ops, temporary_file_name,
};
pub use storage::state_root::validate_state_root_env;
pub use system::app_info::{AppInfo, AppPresentation, app_name_matches};
pub use system::app_inventory::AppInventory;
pub use system::app_inventory_query::AppInventoryQuery;
pub use system::display_info::DisplayInfo;
pub use system::image_buffer::{ImageBuffer, MAX_PNG_INPUT_BYTES, parse_png_dimensions};
pub use system::image_format::ImageFormat;
pub use system::operation_report::OperationReport;
pub use system::operation_target::OperationTarget;
pub use system::permission_report::PermissionReport;
pub use system::permission_state::PermissionState;
pub use system::process_id::ProcessId;
pub use system::process_identity::ProcessIdentity;
pub use system::screenshot_target::ScreenshotTarget;
pub use system::surface_info::SurfaceInfo;
pub use system::window_filter::WindowFilter;
pub use system::window_info::WindowInfo;
pub use system::window_op::WindowOp;
pub use system::window_readback::WindowReadback;
pub use system::window_state::WindowState;
pub use trace::trace_sanitize::sanitize_trace_value;
pub use tree::accname::{compute_description, compute_name, resolve_description, resolve_name};
pub use tree::bounds_space::BoundsSpace;
pub use tree::element_identifier::ElementIdentifier;
pub use tree::element_state::ElementState;
pub use tree::identifier_kind::IdentifierKind;
pub use tree::name_evidence::NameEvidence;
pub use tree::name_slot_status::{NameSlotStatus, SlotStatus};
pub use tree::node::AccessibilityNode;
pub use tree::node_descriptor::NodeDescriptor;
pub use tree::node_identity::NodeIdentity;
pub use tree::node_match_context::NodeMatchContext;
pub use tree::node_presentation::NodePresentation;
pub use tree::point::Point;
pub use tree::rect::Rect;
pub use tree::renderer_kind::RendererKind;
pub use tree::role::Role;
pub use tree::tree_options::TreeOptions;
pub use tree::value_matches::value_matches;
pub use wait::deadline::{DEFAULT_OPERATION_TIMEOUT_MS, Deadline};
pub use wait::event_kind::EventKind;
pub use wait::signal_baseline::SignalBaseline;
pub use wait::signal_completeness::SignalCompleteness;
pub use wait::signal_filter::SignalFilter;
pub use wait::signals::diff_signals;
pub use wait::surface_signal::SurfaceSignal;
pub use wait::ui_event::UiEvent;
pub use wait::wait_budget::{MAX_WAIT_TIMEOUT_MS, wait_timeout_duration};
pub use wait::wait_wakeup::WaitWakeup;
