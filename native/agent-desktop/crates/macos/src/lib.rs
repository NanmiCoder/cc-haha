#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

mod actions;
mod adapter;
mod input;
mod notifications;
mod system;
mod tree;

pub use adapter::MacOSAdapter;
pub use input::clipboard::helper_entry_from_env as clipboard_helper_from_env;
pub use system::cocoa_runtime::ensure_cocoa_multithreaded;
pub use system::permissions::permission_guide::entry_from_env as permission_guide_from_env;
pub use system::permissions::permission_helper::entry_from_env as permission_prompt_helper_from_env;
pub use tree::resolve::retained::RetainedRefSession;
