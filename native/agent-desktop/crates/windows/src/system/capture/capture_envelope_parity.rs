//! Screenshot and clipboard command `data` envelope parity with core/macOS.
//!
//! Pins field names, types, `found: false`, and image-path shapes through
//! `WindowsAdapter` + core command execute. Also verifies the private versus
//! user write-path asymmetry via `WindowsPrivateFile` observables (TokenOwner
//! / reparse rejection), never via ACL assertions.

#[cfg(all(test, target_os = "windows"))]
#[path = "capture_envelope_parity_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "capture_routing_parity_tests.rs"]
mod routing;

#[cfg(all(test, target_os = "windows"))]
#[path = "capture_live_breadth_tests.rs"]
mod live;
