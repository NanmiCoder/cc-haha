use std::sync::mpsc::Sender;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BeginPaint, BitBlt, CreateCompatibleDC, CreateDIBSection,
    CreateSolidBrush, DIB_RGB_COLORS, DeleteDC, DeleteObject, EndPaint, FillRect, GetDC, HDC,
    InvalidateRect, PAINTSTRUCT, ReleaseDC, SRCCOPY, SelectObject, UpdateWindow,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetClientRect, PostMessageW, PostQuitMessage,
    SW_SHOWNOACTIVATE, SendMessageW, ShowWindow, WM_DESTROY, WM_PAINT, WM_PRINTCLIENT, WS_POPUP,
};

use super::{PATTERN_HEIGHT, PATTERN_WIDTH, PatternColors, PatternExpectation};
use crate::tree::fixture::fixture_window;

pub(super) const WM_PATTERN_READY: u32 = 0x0400 + 3;
const WM_PATTERN_PAINT_NOW: u32 = 0x0400 + 4;
const PRF_CLIENT: usize = 0x0000_0004;

fn colorref(rgb: [u8; 3]) -> u32 {
    u32::from(rgb[0]) | (u32::from(rgb[1]) << 8) | (u32::from(rgb[2]) << 16)
}

fn paint_pattern(hdc: HDC, width: i32, height: i32, colors: PatternColors) {
    let mid_x = width / 2;
    let mid_y = height / 2;
    fill_rect(hdc, 0, 0, mid_x, mid_y, colors.top_left);
    fill_rect(hdc, mid_x, 0, width, mid_y, colors.top_right);
    fill_rect(hdc, 0, mid_y, mid_x, height, colors.bottom_left);
    fill_rect(hdc, mid_x, mid_y, width, height, colors.bottom_right);
}

fn fill_rect(hdc: HDC, left: i32, top: i32, right: i32, bottom: i32, rgb: [u8; 3]) {
    let brush = unsafe { CreateSolidBrush(colorref(rgb)) };
    if brush.is_null() {
        return;
    }
    let rect = RECT {
        left,
        top,
        right,
        bottom,
    };
    unsafe { FillRect(hdc, &rect, brush) };
    unsafe { DeleteObject(brush) };
}

unsafe extern "system" fn pattern_window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let hdc = unsafe { BeginPaint(window, &mut paint) };
            if !hdc.is_null() {
                let (width, height) = client_size(window);
                paint_pattern(hdc, width, height, PatternColors::standard());
                unsafe { EndPaint(window, &paint) };
            }
            0
        }
        WM_PRINTCLIENT => {
            let hdc = wparam as HDC;
            if !hdc.is_null() {
                let (width, height) = client_size(window);
                paint_pattern(hdc, width, height, PatternColors::standard());
            }
            0
        }
        WM_PATTERN_PAINT_NOW => {
            let hdc = unsafe { GetDC(window) };
            if !hdc.is_null() {
                let (width, height) = client_size(window);
                paint_pattern(hdc, width, height, PatternColors::standard());
                unsafe { ReleaseDC(window, hdc) };
            }
            unsafe { InvalidateRect(window, std::ptr::null(), 0) };
            unsafe { UpdateWindow(window) };
            0
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

pub(super) fn client_size(window: HWND) -> (i32, i32) {
    let mut rect = RECT::default();
    if unsafe { GetClientRect(window, &mut rect) } == 0 {
        return (PATTERN_WIDTH, PATTERN_HEIGHT);
    }
    (rect.right - rect.left, rect.bottom - rect.top)
}

pub(super) fn host_pattern_window(
    class_name: &str,
    ready: Sender<Result<fixture_window::PumpHandle, String>>,
    left: i32,
    top: i32,
) {
    if let Err(error) = fixture_window::register_class_with_proc(class_name, pattern_window_proc) {
        let _ = ready.send(Err(error));
        return;
    }
    let name = fixture_window::wide(class_name);
    let title = fixture_window::wide("agent-desktop pattern fixture");
    let window = unsafe {
        CreateWindowExW(
            0,
            name.as_ptr(),
            title.as_ptr(),
            WS_POPUP,
            left,
            top,
            PATTERN_WIDTH,
            PATTERN_HEIGHT,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    };
    if window.is_null() {
        let _ = ready.send(Err("CreateWindowExW produced no pattern window".into()));
        return;
    }
    unsafe { ShowWindow(window, SW_SHOWNOACTIVATE) };
    unsafe { PostMessageW(window, WM_PATTERN_READY, 0, 0) };
    fixture_window::pump_until_destroyed(window as isize, ready, WM_PATTERN_READY);
}

pub(super) fn force_paint(handle: isize) -> Result<(), String> {
    unsafe { SendMessageW(handle as HWND, WM_PATTERN_PAINT_NOW, 0, 0) };
    Ok(())
}

struct DibCapture {
    window: HWND,
    window_dc: HDC,
    memory_dc: HDC,
    bitmap: *mut std::ffi::c_void,
    previous: *mut std::ffi::c_void,
    bits: *mut u8,
    width: i32,
    height: i32,
}

impl DibCapture {
    fn from_window_blit(handle: isize) -> Result<Self, String> {
        let window = handle as HWND;
        let (width, height) = client_size(window);
        let capture = Self::allocate(window, width, height)?;
        if unsafe {
            BitBlt(
                capture.memory_dc,
                0,
                0,
                width,
                height,
                capture.window_dc,
                0,
                0,
                SRCCOPY,
            )
        } == 0
        {
            return Err(String::from("BitBlt failed against the pattern window"));
        }
        Ok(capture)
    }

    fn from_printclient(handle: isize) -> Result<Self, String> {
        let window = handle as HWND;
        let (width, height) = client_size(window);
        let capture = Self::allocate(std::ptr::null_mut(), width, height)?;
        unsafe {
            SendMessageW(
                window,
                WM_PRINTCLIENT,
                capture.memory_dc as usize,
                PRF_CLIENT as isize,
            )
        };
        Ok(capture)
    }

    fn allocate(window: HWND, width: i32, height: i32) -> Result<Self, String> {
        if width <= 0 || height <= 0 {
            return Err(String::from("pattern client area is empty"));
        }
        let window_dc = unsafe { GetDC(window) };
        if window_dc.is_null() {
            return Err(String::from("GetDC failed"));
        }
        let memory_dc = unsafe { CreateCompatibleDC(window_dc) };
        if memory_dc.is_null() {
            unsafe { ReleaseDC(window, window_dc) };
            return Err(String::from("CreateCompatibleDC failed"));
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits_ptr = std::ptr::null_mut();
        let bitmap = unsafe {
            CreateDIBSection(
                memory_dc,
                &info,
                DIB_RGB_COLORS,
                &mut bits_ptr,
                std::ptr::null_mut(),
                0,
            )
        };
        if bitmap.is_null() || bits_ptr.is_null() {
            unsafe {
                DeleteDC(memory_dc);
                ReleaseDC(window, window_dc);
            }
            return Err(String::from("CreateDIBSection failed"));
        }
        let previous = unsafe { SelectObject(memory_dc, bitmap) };
        Ok(Self {
            window,
            window_dc,
            memory_dc,
            bitmap,
            previous,
            bits: bits_ptr.cast(),
            width,
            height,
        })
    }

    fn sample_rgb(&self, x: i32, y: i32) -> Result<[u8; 3], String> {
        if x < 0 || y < 0 || x >= self.width || y >= self.height {
            return Err(String::from("sample point is outside the client area"));
        }
        let offset = ((y * self.width + x) * 4) as usize;
        let b = unsafe { *self.bits.add(offset) };
        let g = unsafe { *self.bits.add(offset + 1) };
        let r = unsafe { *self.bits.add(offset + 2) };
        Ok([r, g, b])
    }

    fn samples_for(self, expectation: PatternExpectation) -> Result<[[u8; 3]; 4], String> {
        let mut samples = [[0u8; 3]; 4];
        for (index, point) in expectation.sample_points().into_iter().enumerate() {
            samples[index] = self.sample_rgb(point.x, point.y)?;
        }
        Ok(samples)
    }
}

impl Drop for DibCapture {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.memory_dc, self.previous);
            DeleteObject(self.bitmap);
            DeleteDC(self.memory_dc);
            ReleaseDC(self.window, self.window_dc);
        }
    }
}

pub(super) fn blit_client_samples(
    handle: isize,
    expectation: PatternExpectation,
) -> Result<[[u8; 3]; 4], String> {
    force_paint(handle)?;
    DibCapture::from_window_blit(handle)?.samples_for(expectation)
}

pub(super) fn printclient_samples(
    handle: isize,
    expectation: PatternExpectation,
) -> Result<[[u8; 3]; 4], String> {
    DibCapture::from_printclient(handle)?.samples_for(expectation)
}
