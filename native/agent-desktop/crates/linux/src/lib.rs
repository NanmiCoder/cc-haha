#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

mod actions;
mod adapter;
mod input;
mod notifications;
mod system;
mod tree;

pub use adapter::LinuxAdapter;
pub use input::clipboard::owner::owner_entry::run_from_env as clipboard_owner_from_env;
pub use input::wayland::kept_session::end as end_input_session;
pub use input::x11::signal_release::enable as release_input_on_signals;
