use agent_desktop_core::{
    AdapterError, Deadline, DisplayInfo, ErrorCode, ImageBuffer, ImageFormat, WindowInfo,
    parse_png_dimensions,
};

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::ffi::OsString;
    use std::io::Read;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    const SCREENCAPTURE: &str = "/usr/sbin/screencapture";
    const MAX_PNG_BYTES: u64 = 64 * 1024 * 1024;
    const MAX_IMAGE_PIXELS: u64 = 100_000_000;
    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    fn capture(
        scale_factor: f64,
        deadline: Deadline,
        arguments: impl FnOnce(&Path) -> Result<Vec<OsString>, AdapterError>,
    ) -> Result<ImageBuffer, AdapterError> {
        deadline.ensure_remaining()?;
        let temp = TempPng::new()?;
        let mut command = Command::new(SCREENCAPTURE);
        command.args(arguments(temp.path())?);
        let output = run_screencapture(&mut command, deadline)?;
        if !output.status.success() {
            return Err(map_screencapture_error(&output));
        }
        let mut buffer = read_png(temp.path(), deadline)?;
        buffer.scale_factor = scale_factor;
        Ok(buffer)
    }

    fn base_args() -> Vec<OsString> {
        vec![
            OsString::from("-x"),
            OsString::from("-t"),
            OsString::from("png"),
        ]
    }

    pub(super) fn display_args(index: usize, output: &Path) -> Result<Vec<OsString>, AdapterError> {
        let display_number = index.checked_add(1).ok_or_else(|| {
            AdapterError::new(ErrorCode::InvalidArgs, "display index is too large")
        })?;
        let mut args = base_args();
        args.push(OsString::from("-D"));
        args.push(OsString::from(display_number.to_string()));
        args.push(output.as_os_str().to_owned());
        Ok(args)
    }

    pub(super) fn window_args(window_id: u32, output: &Path) -> Vec<OsString> {
        let mut args = base_args();
        args.push(OsString::from("-l"));
        args.push(OsString::from(window_id.to_string()));
        args.push(output.as_os_str().to_owned());
        args
    }

    pub fn capture_screen(index: usize, deadline: Deadline) -> Result<ImageBuffer, AdapterError> {
        deadline.ensure_remaining()?;
        let expected = crate::system::display::display_at(index, deadline)?;
        deadline.ensure_remaining()?;
        capture_display(index, &expected, deadline)
    }

    pub fn capture_display(
        index: usize,
        expected: &DisplayInfo,
        deadline: Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        deadline.ensure_remaining()?;
        let (raw_index, current) = crate::system::display::capture_selection(expected, deadline)?;
        deadline.ensure_remaining()?;
        verify_display_identity(index, expected, &current)?;
        let captured = capture(current.scale, deadline, |path| {
            display_args(raw_index, path)
        })?;
        deadline.ensure_remaining()?;
        let after = crate::system::display::display_at_capture_index(raw_index, deadline)?;
        deadline.ensure_remaining()?;
        verify_display_identity(index, &current, &after)?;
        Ok(captured)
    }

    pub fn capture_window(
        window: &WindowInfo,
        deadline: Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        capture_window_options(window, deadline, false)
    }

    pub fn capture_window_frame(
        window: &WindowInfo,
        deadline: Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        capture_window_options(window, deadline, true)
    }

    fn capture_window_options(
        window: &WindowInfo,
        deadline: Deadline,
        omit_shadow: bool,
    ) -> Result<ImageBuffer, AdapterError> {
        if window.process_instance.is_none() {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                "Exact window screenshot requires a process instance token",
            )
            .with_suggestion("Refresh the target with 'list-windows', then retry"));
        }
        let verified = crate::system::window::window_resolve::resolve_capture_window(
            window,
            deadline_instant(deadline)?,
        )?;
        let window_id = parse_window_id(&verified.id)?;
        let scale = crate::system::display::scale_for_bounds(verified.bounds, deadline)?;
        deadline.ensure_remaining()?;
        let captured = capture(scale, deadline, |path| {
            let mut args = window_args(window_id, path);
            if omit_shadow {
                args.insert(0, OsString::from("-o"));
            }
            Ok(args)
        })?;
        crate::system::window::window_resolve::resolve_capture_window(
            &verified,
            deadline_instant(deadline)?,
        )?;
        Ok(captured)
    }

    struct TempPng {
        dir: PathBuf,
        path: PathBuf,
    }

    impl TempPng {
        fn new() -> Result<Self, AdapterError> {
            let mut dir = std::env::temp_dir();
            dir.push(format!(
                "agent-desktop-screenshot-{}-{}",
                std::process::id(),
                NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&dir)
                .map_err(|error| {
                    AdapterError::internal(format!("create screenshot temp dir: {error}"))
                })?;
            let path = dir.join("capture.png");
            Ok(Self { dir, path })
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempPng {
        fn drop(&mut self) {
            if let Err(error) = std::fs::remove_file(&self.path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                tracing::debug!("screenshot file cleanup failed");
            }
            if let Err(error) = std::fs::remove_dir(&self.dir)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                tracing::debug!("screenshot directory cleanup failed");
            }
        }
    }

    pub(super) fn run_screencapture(
        command: &mut Command,
        deadline: Deadline,
    ) -> Result<Output, AdapterError> {
        crate::system::process::run_with_deadline(
            command,
            "screencapture",
            deadline_instant(deadline)?,
        )
    }

    fn read_png(path: &Path, deadline: Deadline) -> Result<ImageBuffer, AdapterError> {
        deadline.ensure_remaining()?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path)
            .map_err(|error| AdapterError::internal(format!("open screenshot: {error}")))?;
        let metadata = file
            .metadata()
            .map_err(|error| AdapterError::internal(format!("stat screenshot: {error}")))?;
        if !metadata.file_type().is_file() {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "screencapture output is not a regular file",
            ));
        }
        validate_png_size(metadata.len())?;
        let capacity = usize::try_from(metadata.len())
            .map_err(|_| AdapterError::new(ErrorCode::ActionFailed, "screenshot is too large"))?;
        let mut data = Vec::new();
        data.try_reserve_exact(capacity).map_err(|_| {
            AdapterError::new(ErrorCode::ActionFailed, "screenshot allocation failed")
        })?;
        file.take(MAX_PNG_BYTES + 1)
            .read_to_end(&mut data)
            .map_err(|error| AdapterError::internal(format!("read screenshot: {error}")))?;
        validate_png_size(data.len() as u64)?;
        deadline.ensure_remaining()?;
        let (width, height) = parse_png_dimensions(&data).ok_or_else(|| {
            AdapterError::new(
                ErrorCode::ActionFailed,
                "screencapture returned an invalid PNG payload",
            )
        })?;
        validate_pixel_count(width, height)?;
        Ok(ImageBuffer {
            data,
            format: ImageFormat::Png,
            width,
            height,
            scale_factor: 1.0,
        })
    }

    pub(super) fn validate_png_size(bytes: u64) -> Result<(), AdapterError> {
        if (24..=MAX_PNG_BYTES).contains(&bytes) {
            Ok(())
        } else {
            Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "screenshot PNG size is outside the supported 24-byte to 64-MiB range",
            ))
        }
    }

    pub(super) fn validate_pixel_count(width: u32, height: u32) -> Result<(), AdapterError> {
        let pixels = u64::from(width)
            .checked_mul(u64::from(height))
            .ok_or_else(|| AdapterError::new(ErrorCode::ActionFailed, "pixel count overflowed"))?;
        if width > 0 && height > 0 && pixels <= MAX_IMAGE_PIXELS {
            Ok(())
        } else {
            Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "screenshot exceeds the 100-megapixel image budget",
            ))
        }
    }

    pub(super) fn map_screencapture_error(output: &Output) -> AdapterError {
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        let lower = combined.to_lowercase();
        if lower.contains("screen recording")
            || lower.contains("not authorized")
            || lower.contains("permission")
            || lower.contains("denied")
        {
            return AdapterError::new(ErrorCode::PermDenied, "Screen Recording permission denied")
                .with_suggestion(
                    "Run agent-desktop permissions --guide. It opens System Settings > Privacy & Security > Screen Recording with a guide that shows which app to add.",
                )
                .with_platform_detail(combined.trim());
        }
        let detail = combined.trim();
        AdapterError::internal("screencapture exited with error").with_platform_detail(
            if detail.is_empty() {
                "screencapture produced no diagnostic output"
            } else {
                detail
            },
        )
    }

    pub(super) fn verify_display_identity(
        index: usize,
        expected: &DisplayInfo,
        current: &DisplayInfo,
    ) -> Result<(), AdapterError> {
        if expected.id == current.id {
            return Ok(());
        }
        Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            format!(
                "Display at index {index} changed from '{}' to '{}'",
                expected.id, current.id
            ),
        )
        .with_suggestion("Run 'list-displays' to refresh display indexes, then retry."))
    }

    fn parse_window_id(id: &str) -> Result<u32, AdapterError> {
        crate::system::window::window_resolve::parse_window_number(id)
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                AdapterError::new(ErrorCode::InvalidArgs, format!("Invalid window id: '{id}'"))
            })
    }

    fn deadline_instant(deadline: Deadline) -> Result<Instant, AdapterError> {
        let remaining = deadline.remaining();
        if remaining.is_zero() {
            return Err(deadline.timeout_error());
        }
        Instant::now()
            .checked_add(remaining)
            .ok_or_else(|| AdapterError::new(ErrorCode::InvalidArgs, "deadline is out of range"))
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    pub fn capture_screen(_index: usize, _deadline: Deadline) -> Result<ImageBuffer, AdapterError> {
        Err(AdapterError::not_supported("capture_screen"))
    }

    pub fn capture_display(
        _index: usize,
        _expected: &DisplayInfo,
        _deadline: Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        Err(AdapterError::not_supported("capture_display"))
    }

    pub fn capture_window(
        _window: &WindowInfo,
        _deadline: Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        Err(AdapterError::not_supported("capture_window"))
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) use imp::capture_window as capture_window_frame;
#[cfg(target_os = "macos")]
pub(crate) use imp::capture_window_frame;
pub(crate) use imp::{capture_display, capture_screen, capture_window};

#[cfg(all(test, target_os = "macos"))]
#[path = "screenshot_tests.rs"]
mod tests;
