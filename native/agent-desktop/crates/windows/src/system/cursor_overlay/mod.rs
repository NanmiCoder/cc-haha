//! The Windows cursor overlay: a detached renderer this process can reach.
//!
//! The CLI is stateless per invocation, so the thing that draws has to outlive
//! the process that asked for it. The shape is the one macOS already uses — a
//! detached child of the same binary, reached over a local transport, holding
//! a click-through window it repaints as controls arrive.
//!
//! Split by responsibility rather than by size: the pipe's name, the control
//! framing and the frame schedule are pure and answer on any host, while the
//! window and its paint need a desktop. Keeping the first group free of Win32
//! is what lets a mixed-DPI arrangement this rig cannot present be covered by
//! a test.

pub(crate) mod animation;
#[cfg(target_os = "windows")]
pub(crate) mod caret_mark;
pub(crate) mod child;
pub(crate) mod cursor_image;
#[cfg(target_os = "windows")]
pub(crate) mod dib;
#[cfg(target_os = "windows")]
pub(crate) mod discover;
pub(crate) mod display_probe;
pub(crate) mod fade;
pub(crate) mod framing;
pub(crate) mod geometry;
pub(crate) mod image_identity;
pub(crate) mod label;
pub(crate) mod monitors;
#[cfg(target_os = "windows")]
pub(crate) mod parked_flush;
pub(crate) mod peer;
pub(crate) mod pipe_name;
pub(crate) mod presentation;
pub(crate) mod raster;
pub(crate) mod render;
pub(crate) mod retire;
pub(crate) mod reveal;
pub(crate) mod rounded;
pub(crate) mod schedule;
pub(crate) mod server;
pub(crate) mod session_state;
pub(crate) mod spawn;
#[cfg(target_os = "windows")]
pub(crate) mod surface_host;
pub(crate) mod text;
pub(crate) mod topology;
pub(crate) mod transport;
#[cfg(target_os = "windows")]
pub(crate) mod wide;
#[cfg(target_os = "windows")]
pub(crate) mod window;
