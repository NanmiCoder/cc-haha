pub(crate) mod action_call;
pub(crate) mod chain;
pub(crate) mod click;
pub(crate) mod context;
pub(crate) mod disclosure;
pub(crate) mod dispatch;
pub(crate) mod focus;
pub(crate) mod live;
pub(crate) mod native_menu;
pub(crate) mod physical_target;
mod popup_verify;
mod process_check;
pub(crate) mod scroll;
pub(crate) mod select;
pub(crate) mod toggle_state;
pub(crate) mod write;

pub(crate) use dispatch::execute_action;
pub(crate) use scroll::scroll_into_view::{before_pointer, scroll_into_view};

#[cfg(test)]
mod action_scan_tests;
