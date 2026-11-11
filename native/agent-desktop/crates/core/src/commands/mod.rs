pub mod batch;
pub mod check;
pub mod clear;
pub mod click;
pub mod clipboard_clear;
pub mod clipboard_get;
pub mod clipboard_set;
pub mod close_app;
pub mod collapse;
pub(crate) mod combo;
pub mod cursor_overlay;
pub mod dismiss_all_notifications;
pub mod dismiss_notification;
pub mod double_click;
pub mod drag;
pub mod execute_by_ref;
pub mod expand;
pub mod find;
pub mod focus;
pub mod focus_window;
pub mod get;
pub mod helpers;
pub mod hover;
mod input_hold_policy;
pub mod is_check;
pub mod key_down;
pub mod key_up;
pub mod launch;
pub mod list_apps;
pub mod list_displays;
#[cfg(test)]
mod list_displays_tests;
pub mod list_notifications;
pub mod list_surfaces;
pub mod list_windows;
pub mod maximize;
pub mod minimize;
pub mod mouse_click;
pub mod mouse_down;
pub mod mouse_move;
pub mod mouse_up;
pub mod mouse_wheel;
pub mod move_window;
pub mod notification_action;
pub(crate) mod notification_identity;
pub(crate) mod notification_policy;
pub mod open_system_surface;
pub(crate) mod operation_response;
pub mod permissions;
pub(crate) mod point_resolve;
pub(crate) mod pointer_action;
pub mod press;
pub mod query;
pub mod resize_window;
pub mod restore;
pub mod right_click;
pub mod screenshot;
#[cfg(test)]
mod screenshot_tests;
pub mod scroll;
pub mod scroll_to;
pub mod select;
pub mod session;
pub mod set_value;
pub mod skills;
pub mod snapshot;
pub mod status;
pub(crate) mod surface_scope;
pub mod toggle;
pub mod trace;
pub mod triple_click;
pub mod type_text;
mod type_text_interval;
mod type_text_interval_verify;
pub mod uncheck;
pub mod version;
pub mod wait;
pub(crate) mod wait_element;
pub(crate) mod wait_event;
pub(crate) mod wait_event_filter;
pub(crate) mod wait_event_input;
pub(crate) mod wait_mode;
pub(crate) mod wait_notification;
pub(crate) mod wait_predicate;
pub(crate) mod wait_scheduler;
pub mod wait_selector;
pub mod wait_surface;
pub(crate) mod wait_text_match;
pub(crate) mod wait_timeout;

#[cfg(test)]
mod wait_wakeup_tests;
mod window_target;

#[cfg(test)]
mod pointer_capability_tests;

#[cfg(test)]
mod ref_policy_tests;

#[cfg(test)]
mod stale_retry_test_support;

#[cfg(test)]
mod operation_passthrough_tests;
