//! Shared `#[cfg(test)]` `Deadline` and headed-`InteractionPolicy`
//! constructors.
//!
//! Every fixture and live test module across this crate grew its own
//! one-line wrapper around `Deadline::after` and `InteractionPolicy::headed`,
//! some parameterized by a millisecond budget, some closed over a single
//! hard-coded literal. Neither wrapper touches a Windows API, so nothing
//! about them is test-module-specific; centralizing both here means a call
//! site's budget is still exactly the literal it always was, passed at the
//! call rather than baked into a same-shaped function redefined once per
//! file.

use agent_desktop_core::{Deadline, InteractionPolicy};

pub(crate) fn deadline(ms: u64) -> Deadline {
    Deadline::after(ms).expect("deadline")
}

pub(crate) fn headed() -> InteractionPolicy {
    InteractionPolicy::headed()
}
