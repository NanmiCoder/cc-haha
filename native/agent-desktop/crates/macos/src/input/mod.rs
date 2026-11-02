mod adapter;
pub(crate) mod blocked_combo;
pub(crate) mod clipboard;
#[cfg(all(test, target_os = "macos", feature = "interactive-tests"))]
mod interactive_test;
pub(crate) mod keyboard;
pub(crate) mod mouse;
pub(crate) mod pointer_report;
