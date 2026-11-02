//! An off-screen 32-bit surface GDI can draw into, and the teardown that goes
//! with it.
//!
//! Both the layered-window present and the label's glyph pass need the same
//! thing: a screen DC, a memory DC compatible with it, and a top-down 32bpp
//! DIB section selected into that memory DC. Each had its own copy, including
//! its own copy of the release sequence - restore the previously selected
//! bitmap, delete the bitmap, delete the memory DC, release the screen DC - in
//! an order that leaks GDI handles if it is got wrong, and leaks them silently.
//! Holding it once means there is one order to be right about.
//!
//! That release is not covered by a test, and the reason is worth stating so
//! nobody adds one that only appears to cover it. Three oracles were tried and
//! measured here: a loop of a few hundred surfaces cannot fail, because leaking
//! two objects a round stays inside the ten thousand a process may hold;
//! `GetGuiResources` answers zero for this process, through a real handle as
//! well as the pseudo one; and `GetObjectType` on the handles after a correct
//! release already reports live objects, because GDI reuses handle values
//! immediately, so a freed handle cannot be told from a reissued one. What
//! guards the release now is that there is one of it instead of two.
//!
//! The height is negative on purpose. A positive height gives a bottom-up DIB,
//! which draws the whole surface mirrored; the rasterizer here works top-down,
//! as does every rectangle it is handed.

#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS,
    DeleteDC, DeleteObject, GetDC, HBITMAP, HDC, HGDIOBJ, ReleaseDC, SelectObject,
};

#[cfg(target_os = "windows")]
pub(crate) struct Dib {
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u32,
    count: usize,
}

#[cfg(target_os = "windows")]
impl Dib {
    /// `None` when the surface could not be made, with every handle taken
    /// so far already released. A caller that reads this as "draw nothing"
    /// is correct; a caller that reads it as a reason to clean up is not,
    /// because there is nothing left to clean up.
    pub(crate) fn create(width: i32, height: i32) -> Option<Self> {
        if width <= 0 || height <= 0 {
            return None;
        }
        let screen = unsafe { GetDC(std::ptr::null_mut()) };
        let memory = unsafe { CreateCompatibleDC(screen) };
        let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bitmap = unsafe {
            CreateDIBSection(
                memory,
                &info,
                DIB_RGB_COLORS,
                &mut bits,
                std::ptr::null_mut(),
                0,
            )
        };
        if bitmap.is_null() || bits.is_null() {
            unsafe {
                DeleteDC(memory);
                ReleaseDC(std::ptr::null_mut(), screen);
            }
            return None;
        }
        let previous = unsafe { SelectObject(memory, bitmap) };
        Some(Self {
            screen,
            memory,
            bitmap,
            previous,
            bits: bits.cast::<u32>(),
            count: (width as usize) * (height as usize),
        })
    }

    /// The DC drawing calls target.
    pub(crate) fn dc(&self) -> HDC {
        self.memory
    }

    /// The screen DC the memory one was made compatible with, which the
    /// layered-window present needs as its destination.
    pub(crate) fn screen_dc(&self) -> HDC {
        self.screen
    }

    /// The bitmap's own storage, as pixels.
    ///
    /// Borrowed from `self` rather than handed out raw, so it cannot
    /// outlive the bitmap it points into.
    pub(crate) fn pixels(&mut self) -> &mut [u32] {
        unsafe { std::slice::from_raw_parts_mut(self.bits, self.count) }
    }
}

#[cfg(target_os = "windows")]
impl Drop for Dib {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.memory, self.previous);
            DeleteObject(self.bitmap);
            DeleteDC(self.memory);
            ReleaseDC(std::ptr::null_mut(), self.screen);
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "dib_tests.rs"]
mod tests;
