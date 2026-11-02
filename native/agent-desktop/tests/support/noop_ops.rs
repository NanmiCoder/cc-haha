use agent_desktop_core::{ActionOps, InputOps, ObservationOps, SystemOps};

/// Blanket-default `PlatformAdapter` test double: implements the four
/// capability supertraits with zero overrides, so every call surfaces that
/// trait's own `not_supported()` default. Shared by any test that needs
/// "some adapter" without exercising a live capability. Single source of
/// truth included via `#[path]` from every call site — the different
/// crates it's compiled into (the `agent-desktop` binary's own unit tests
/// and the standalone `conformance` integration-test crate) cannot share a
/// Rust module across a crate boundary, but they can share this file.
pub(crate) struct NoopAdapter;

impl ObservationOps for NoopAdapter {}
impl ActionOps for NoopAdapter {}
impl InputOps for NoopAdapter {}
impl SystemOps for NoopAdapter {}
