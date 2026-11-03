use std::path::PathBuf;
use std::time::SystemTime;

use agent_desktop_core::{
    AdapterError, Deadline, DisplayInfo, ErrorCode, ImageBuffer, ImageFormat, ScreenshotTarget,
    parse_png_dimensions,
};

use super::display::select;
use super::wayland_crop::{crop_png, pixel_rect};
use super::wayland_file::{path_of_uri, take_file};
use super::wayland_portal_bus::connect;
use super::wayland_portal_call::{PortalWire, screenshot_uri};

type Connect<'a> = &'a dyn Fn(Deadline) -> Result<Box<dyn PortalWire>, AdapterError>;
type Displays<'a> = &'a dyn Fn(Deadline) -> Result<Vec<DisplayInfo>, AdapterError>;

fn window_unsupported() -> AdapterError {
    AdapterError::new(
        ErrorCode::PlatformNotSupported,
        "A single window cannot be captured on a Wayland session",
    )
    .with_suggestion("Capture the screen instead, or run the application in an X11 session")
}

fn not_a_png() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The portal's screenshot is not a PNG this tool can use",
    )
}

fn layout_changed() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The display layout changed while the screenshot was being allowed",
    )
    .with_suggestion("Run 'list-displays' again, then capture the display once more")
}

fn allowed_directories() -> Vec<PathBuf> {
    let mut roots = vec![std::env::temp_dir()];
    for name in ["XDG_RUNTIME_DIR", "HOME"] {
        if let Some(dir) = std::env::var_os(name).filter(|value| !value.is_empty()) {
            roots.push(PathBuf::from(dir));
        }
    }
    roots
}

fn token() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("ad{}x{nanos}", std::process::id())
}

fn image_of(bytes: Vec<u8>) -> Result<ImageBuffer, AdapterError> {
    let (width, height) = parse_png_dimensions(&bytes).ok_or_else(not_a_png)?;
    Ok(ImageBuffer {
        data: bytes,
        format: ImageFormat::Png,
        width,
        height,
        scale_factor: 1.0,
    })
}

pub(crate) fn capture_with(
    target: &ScreenshotTarget,
    deadline: Deadline,
    connect: Connect<'_>,
    roots: &[PathBuf],
    displays: Displays<'_>,
) -> Result<ImageBuffer, AdapterError> {
    let chosen = match target {
        ScreenshotTarget::FullScreen => {
            let all = displays(deadline).unwrap_or_default();
            if !all.is_empty() {
                let (_, display) = select(&all, target)?;
                Some((display, all))
            } else {
                None
            }
        }
        ScreenshotTarget::Screen(_) | ScreenshotTarget::Display { .. } => {
            let all = displays(deadline)?;
            let (_, display) = select(&all, target)?;
            Some((display, all))
        }
        ScreenshotTarget::ExactWindow(_) => return Err(window_unsupported()),
    };
    let started = SystemTime::now();
    let wire = connect(deadline)?;
    let uri = screenshot_uri(wire.as_ref(), &token(), deadline)?;
    let path = path_of_uri(&uri)?;
    let uid = rustix::process::getuid().as_raw();
    let whole = image_of(take_file(&path, roots, uid, started)?)?;
    let Some((display, all)) = chosen else {
        return Ok(whole);
    };
    if displays(deadline)? != all {
        return Err(layout_changed());
    }
    if all.len() == 1 && matches!(target, ScreenshotTarget::FullScreen) {
        return Ok(whole);
    }
    let rect = pixel_rect(&display, &all, (whole.width, whole.height))?;
    crop_png(&whole.data, rect, display.scale)
}

/// Captures the whole desktop through the desktop portal's `Screenshot` call.
/// The portal asks a person to allow it, so the call waits for that answer
/// until the deadline.
pub(crate) fn capture_wayland(
    target: &ScreenshotTarget,
    deadline: Deadline,
) -> Result<ImageBuffer, AdapterError> {
    capture_with(
        target,
        deadline,
        &connect,
        &allowed_directories(),
        &crate::system::list_wayland_displays,
    )
}

#[cfg(test)]
#[path = "wayland_portal_tests.rs"]
mod tests;
