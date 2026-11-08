//! Modern capture via `Windows.Graphics.Capture` (WGC).
//!
//! Availability is `GraphicsCaptureSession::IsSupported` only — never a build
//! number (A22-1). One frame is taken against the caller's deadline; expiry is
//! a backend failure so precedence can fall back to Legacy.

use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, ImageBuffer, ImageFormat};
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

use super::capture_d3d::{self, CaptureDevice, resource_balance};
use super::png_codec::encode_bgra_to_png;
use crate::system::display::display_at;
use crate::system::window::window_enum::WindowHandle;

const FRAME_POLL_SLICE: Duration = Duration::from_millis(10);

/// Same support predicate production capture and `probe_capture_availability` use.
pub(crate) fn modern_is_supported() -> bool {
    GraphicsCaptureSession::IsSupported().unwrap_or(false)
}

pub(crate) fn capture_window(
    handle: WindowHandle,
    scale_factor: f64,
    deadline: Deadline,
) -> Result<ImageBuffer, AdapterError> {
    deadline.ensure_remaining()?;
    ensure_supported()?;
    let item = item_for_window(handle)?;
    capture_item(item, scale_factor, deadline)
}

pub(crate) fn capture_display(
    index: usize,
    deadline: Deadline,
) -> Result<ImageBuffer, AdapterError> {
    deadline.ensure_remaining()?;
    ensure_supported()?;
    let display = display_at(index, deadline)?;
    let monitor = monitor_handle_from_id(&display.id)?;
    let item = item_for_monitor(monitor)?;
    capture_item(item, display.scale, deadline)
}

fn ensure_supported() -> Result<(), AdapterError> {
    if modern_is_supported() {
        Ok(())
    } else {
        Err(AdapterError::new(
            ErrorCode::ActionNotSupported,
            "modern capture is not available in this session",
        ))
    }
}

fn capture_item(
    item: GraphicsCaptureItem,
    scale_factor: f64,
    deadline: Deadline,
) -> Result<ImageBuffer, AdapterError> {
    deadline.ensure_remaining()?;
    let size = item
        .Size()
        .map_err(|error| wgc_error(error.code().0, "read the capture item size"))?;
    if size.Width <= 0 || size.Height <= 0 {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "capture item has a zero-sized frame",
        ));
    }

    let device = CaptureDevice::create()?;
    deadline.ensure_remaining()?;
    let pool = PoolGuard::create(&device.winrt, size)?;
    let session = SessionGuard::create(&pool, &item)?;
    let _ = session.0.SetIsCursorCaptureEnabled(false);
    let _ = session.0.SetIsBorderRequired(false);
    session
        .0
        .StartCapture()
        .map_err(|error| wgc_error(error.code().0, "start the capture session"))?;

    #[cfg(test)]
    if fail_after_start::is_active() {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "modern capture forced failure after session start",
        ));
    }

    let frame = wait_for_frame(&pool, deadline)?;
    let content = frame
        .0
        .ContentSize()
        .map_err(|error| wgc_error(error.code().0, "read the frame content size"))?;
    let width = content.Width.max(0) as u32;
    let height = content.Height.max(0) as u32;
    let surface = frame
        .0
        .Surface()
        .map_err(|error| wgc_error(error.code().0, "read the frame surface"))?;
    let texture = capture_d3d::texture_from_surface(&surface)?;
    resource_balance::acquire();
    let _texture_guard = TextureGuard;
    let pixels = capture_d3d::read_texture_bgra(&device, &texture, width, height)?;
    let stride = width
        .checked_mul(4)
        .ok_or_else(|| AdapterError::internal("modern capture stride overflowed"))?;
    let png = encode_bgra_to_png(&pixels, width, height, stride, deadline)?;
    Ok(ImageBuffer {
        data: png,
        format: ImageFormat::Png,
        width,
        height,
        scale_factor,
    })
}

fn wait_for_frame(pool: &PoolGuard, deadline: Deadline) -> Result<FrameGuard, AdapterError> {
    #[cfg(test)]
    if let Some(budget) = hold_frames::budget() {
        return hold_frames_until(deadline, budget);
    }
    loop {
        deadline.ensure_remaining()?;
        match pool.0.TryGetNextFrame() {
            Ok(frame) => return Ok(FrameGuard::new(frame)),
            Err(_) => {
                let slice = deadline.remaining_slice(FRAME_POLL_SLICE)?;
                if slice.is_zero() {
                    return Err(deadline.timeout_error());
                }
                std::thread::sleep(slice);
            }
        }
    }
}

#[cfg(test)]
fn hold_frames_until(deadline: Deadline, budget: Duration) -> Result<FrameGuard, AdapterError> {
    let held = Deadline::from_duration(budget)?;
    loop {
        deadline.ensure_remaining()?;
        std::thread::sleep(held.remaining_slice(FRAME_POLL_SLICE)?);
    }
}

/// Activation of the HWND/HMONITOR interop factory. Distinct from
/// [`modern_is_supported`]: A22-1 measured `IsSupported == true` on build
/// 17763 while this QI still returns `E_NOINTERFACE`.
#[cfg(test)]
pub(crate) fn interop_is_available() -> bool {
    item_interop().is_ok()
}

fn item_for_window(handle: WindowHandle) -> Result<GraphicsCaptureItem, AdapterError> {
    let interop = item_interop()?;
    unsafe {
        interop
            .CreateForWindow::<GraphicsCaptureItem>(HWND(handle))
            .map_err(|error| wgc_error(error.code().0, "CreateForWindow"))
    }
}

fn item_for_monitor(monitor: HMONITOR) -> Result<GraphicsCaptureItem, AdapterError> {
    let interop = item_interop()?;
    unsafe {
        interop
            .CreateForMonitor::<GraphicsCaptureItem>(monitor)
            .map_err(|error| wgc_error(error.code().0, "CreateForMonitor"))
    }
}

fn item_interop() -> Result<IGraphicsCaptureItemInterop, AdapterError> {
    windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
        .map_err(|error| wgc_error(error.code().0, "activate IGraphicsCaptureItemInterop"))
}

fn monitor_handle_from_id(id: &str) -> Result<HMONITOR, AdapterError> {
    let raw = id
        .strip_prefix("monitor-")
        .and_then(|rest| rest.parse::<usize>().ok())
        .ok_or_else(|| {
            AdapterError::new(
                ErrorCode::Internal,
                "display id is not a monitor handle token",
            )
        })?;
    Ok(HMONITOR(raw as *mut core::ffi::c_void))
}

fn wgc_error(hresult: i32, context: &str) -> AdapterError {
    crate::system::runtime::hresult::hresult_error("WGC", hresult, context)
}

struct PoolGuard(Direct3D11CaptureFramePool);

impl PoolGuard {
    fn create(
        device: &windows::Graphics::DirectX::Direct3D11::IDirect3DDevice,
        size: SizeInt32,
    ) -> Result<Self, AdapterError> {
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        )
        .map_err(|error| wgc_error(error.code().0, "create a free-threaded frame pool"))?;
        resource_balance::acquire();
        Ok(Self(pool))
    }
}

impl Drop for PoolGuard {
    fn drop(&mut self) {
        let _ = self.0.Close();
        resource_balance::release();
    }
}

struct SessionGuard(GraphicsCaptureSession);

impl SessionGuard {
    fn create(pool: &PoolGuard, item: &GraphicsCaptureItem) -> Result<Self, AdapterError> {
        let session = pool
            .0
            .CreateCaptureSession(item)
            .map_err(|error| wgc_error(error.code().0, "create a capture session"))?;
        resource_balance::acquire();
        Ok(Self(session))
    }
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        let _ = self.0.Close();
        resource_balance::release();
    }
}

struct FrameGuard(Direct3D11CaptureFrame);

impl FrameGuard {
    fn new(frame: Direct3D11CaptureFrame) -> Self {
        resource_balance::acquire();
        Self(frame)
    }
}

impl Drop for FrameGuard {
    fn drop(&mut self) {
        let _ = self.0.Close();
        resource_balance::release();
    }
}

struct TextureGuard;

impl Drop for TextureGuard {
    fn drop(&mut self) {
        resource_balance::release();
    }
}

#[cfg(test)]
pub(in crate::system) mod fail_after_start {
    use std::cell::Cell;

    thread_local! {
        static ACTIVE: Cell<bool> = const { Cell::new(false) };
    }

    pub(super) fn is_active() -> bool {
        ACTIVE.with(Cell::get)
    }

    pub(super) fn with<R>(run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_flag(&ACTIVE, true, run)
    }
}

#[cfg(test)]
pub(in crate::system) mod hold_frames {
    use std::cell::Cell;
    use std::time::Duration;

    thread_local! {
        static BUDGET_MS: Cell<usize> = const { Cell::new(0) };
    }

    /// The frame-wait budget armed for this thread, if frames are being held.
    ///
    /// The budget is a fresh deadline started inside the frame wait, after the
    /// capture session exists, so expiry is decided there and never by how long
    /// the setup before it took.
    pub(super) fn budget() -> Option<Duration> {
        match BUDGET_MS.with(Cell::get) {
            0 => None,
            millis => Some(Duration::from_millis(millis as u64)),
        }
    }

    pub(super) fn with<R>(budget_ms: usize, run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_usize_flag(&BUDGET_MS, budget_ms, run)
    }
}

#[cfg(test)]
#[path = "capture_modern_tests.rs"]
mod tests;
