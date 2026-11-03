pub(crate) mod activation_effect;
mod adapter;
pub(crate) mod ax_helpers;
#[cfg(target_os = "macos")]
pub(crate) mod ax_mutation;
pub(crate) mod ax_perform;
pub(crate) mod chain;
pub(crate) mod delivery_tracker;
pub(crate) mod dispatch;
pub(crate) mod extras;
mod physical_click;
mod physical_keyboard;
mod physical_target;
pub(crate) mod post_state;
pub(crate) mod scroll;
pub(crate) mod scroll_into_view;
mod scroll_read;
pub(crate) mod select;
pub(crate) mod toggle_state;
pub(crate) mod type_text;

pub(crate) use delivery_tracker::DeliveryTracker;
pub(crate) use dispatch::perform_action;
