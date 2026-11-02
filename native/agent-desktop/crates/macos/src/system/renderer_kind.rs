use agent_desktop_core::RendererKind;
use std::ffi::CStr;
use std::path::{Path, PathBuf};

/// Exact framework bundle names that mark an app as Chromium-based. Matched
/// against `Contents/Frameworks` entries, not against the app name, so
/// nothing here hardcodes a particular application.
const CHROMIUM_FRAMEWORK_MARKERS: [&str; 2] = [
    "Electron Framework.framework",
    "Chromium Embedded Framework.framework",
];

/// Best-effort: any failure resolving the executable path, the bundle root,
/// or reading `Contents/Frameworks` reports "not detected" rather than
/// failing the launch that asked for it. Costs at most one `readdir`.
#[cfg(target_os = "macos")]
pub(crate) fn detect_chromium(pid: i32) -> Option<RendererKind> {
    let executable = executable_path(pid)?;
    let bundle_root = bundle_root_from_executable(&executable)?;
    chromium_marker_in_bundle(&bundle_root).then_some(RendererKind::Chromium)
}

/// Scans `Contents/Frameworks` under `bundle_root` for a Chromium marker
/// framework. Isolated from `detect_chromium` so the scan can be tested
/// directly against a fixture bundle instead of a live process.
fn chromium_marker_in_bundle(bundle_root: &Path) -> bool {
    let frameworks = bundle_root.join("Contents/Frameworks");
    let Ok(entries) = std::fs::read_dir(frameworks) else {
        return false;
    };
    entries
        .filter_map(Result::ok)
        .any(|entry| is_chromium_framework_marker(&entry.file_name().to_string_lossy()))
}

fn is_chromium_framework_marker(entry_name: &str) -> bool {
    CHROMIUM_FRAMEWORK_MARKERS.contains(&entry_name)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn detect_chromium(_pid: i32) -> Option<RendererKind> {
    None
}

#[cfg(target_os = "macos")]
pub(crate) fn executable_path(pid: i32) -> Option<PathBuf> {
    let mut buffer = [0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let capacity = u32::try_from(buffer.len()).ok()?;
    let written = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), capacity) };
    if written <= 0 {
        return None;
    }
    let bytes = &buffer[..usize::try_from(written).ok()?];
    let path = CStr::from_bytes_until_nul(bytes)
        .ok()
        .map(CStr::to_string_lossy)
        .unwrap_or_else(|| String::from_utf8_lossy(bytes));
    Some(PathBuf::from(path.into_owned()))
}

/// An app bundle's executable always lives at `<Name>.app/Contents/MacOS/<exe>`;
/// this walks back up exactly that shape and refuses anything looser, so a
/// non-bundled executable (a bare binary, a symlink farm) yields no root
/// rather than a guess.
fn bundle_root_from_executable(executable: &Path) -> Option<PathBuf> {
    let macos_dir = executable.parent()?;
    if macos_dir.file_name()?.to_str()? != "MacOS" {
        return None;
    }
    let contents_dir = macos_dir.parent()?;
    if contents_dir.file_name()?.to_str()? != "Contents" {
        return None;
    }
    let bundle_root = contents_dir.parent()?;
    if bundle_root.extension()?.to_str()? != "app" {
        return None;
    }
    Some(bundle_root.to_path_buf())
}

#[cfg(test)]
#[path = "renderer_kind_tests.rs"]
mod tests;
