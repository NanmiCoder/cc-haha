//! Lifecycle `AdapterError` / `ProcessState` wire-shape parity pins.
//!
//! Shared failures match the macOS code+disposition pair for the same
//! condition. Platform-only failures are asserted against the envelope
//! contract (existing `ErrorCode`, disposition relative to the native write)
//! and labelled class-(b) so they are never mistaken for macOS parity.
//!
//! Hot-path cost baseline: captures under
//! `probes/windows/21-system-lifecycle/captures/lifecycle-cost-{devbox,ci}.json`
//! (min-of-seven discard warm-up per A15-13 / A20-6).

#[cfg(test)]
#[path = "lifecycle_envelope_parity_tests.rs"]
mod tests;
