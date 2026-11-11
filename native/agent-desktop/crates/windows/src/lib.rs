#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

mod actions;
mod adapter;
mod input;
mod notifications;
mod system;
pub mod tree;

pub use adapter::WindowsAdapter;
#[cfg(target_os = "windows")]
pub use system::private_file::WindowsPrivateFile;
#[cfg(target_os = "windows")]
pub use system::runtime::com_runtime::bootstrap_hosted_library;
pub use system::runtime::com_runtime::{
    ensure_hosted_library_mta_and_dpi, ensure_owned_process_mta_and_dpi,
    is_mta_established_for_new_threads,
};

/// The argv token the overlay's renderer carries.
///
/// Published because recognising that process is necessarily out-of-process
/// work: it is detached, holds no console and no window this crate can be
/// asked about, so anything reaping a stray one enumerates command lines from
/// outside this crate entirely. A second copy of the string would drift in
/// silence, and the way it would announce itself is a reaper that matches
/// nothing and leaves a topmost overlay on screen.
pub use system::cursor_overlay::pipe_name::CHILD_ARGV_FLAG as CURSOR_OVERLAY_CHILD_FLAG;
