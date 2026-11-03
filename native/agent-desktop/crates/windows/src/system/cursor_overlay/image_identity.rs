//! Whether an image on disk is this tool's own binary.
//!
//! Two guards have to agree on that answer. The spawn guard refuses to fork a
//! renderer from anything but the CLI's own image, and a client refuses to
//! hand controls to a pipe server that is not one. A stem that counted for the
//! one and not the other would either fork a renderer out of a host process or
//! feed cursor coordinates and label text to a stranger that can answer the
//! acknowledgement byte, so both read their answer here.
//!
//! The comparison is against the stem alone, never against the caller's own
//! `current_exe()`: an FFI host legitimately runs under another image and must
//! still be able to reach the renderer it started.

use std::path::Path;

/// The file stem every image of this tool carries, with or without `.exe`.
pub(crate) const IMAGE_STEM: &str = "agent-desktop";

/// Windows paths are case-insensitive, so `AGENT-DESKTOP.EXE` names the same
/// image as `agent-desktop.exe` and has to pass the same guards. Only the
/// final component counts: a build tree whose directories are named after the
/// project is not itself the project's binary.
pub(crate) fn is_agent_desktop_image(path: &Path) -> bool {
    image_stem(path).is_some_and(|stem| stem.eq_ignore_ascii_case(IMAGE_STEM))
}

/// The stem a refusal names, so a reader is told what was found and not only
/// what was wanted.
pub(crate) fn image_stem(path: &Path) -> Option<&str> {
    path.file_stem().and_then(std::ffi::OsStr::to_str)
}

#[cfg(test)]
#[path = "image_identity_tests.rs"]
mod tests;
