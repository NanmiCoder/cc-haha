use std::ffi::c_void;

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowTextLengthW, IsWindowVisible,
};

/// What the operator asked to capture.
pub struct Options {
    pub class_name: String,
    pub variant: String,
    pub output: String,
    pub max_depth: u8,
}

impl Options {
    pub fn from_args() -> Result<Self, String> {
        let mut class_name = None;
        let mut variant = None;
        let mut output = None;
        let mut max_depth = 24_u8;
        let mut args = std::env::args().skip(1);
        while let Some(flag) = args.next() {
            let mut value = || args.next().ok_or_else(|| format!("{flag} needs a value"));
            match flag.as_str() {
                "--class" => class_name = Some(value()?),
                "--variant" => variant = Some(value()?),
                "--out" => output = Some(value()?),
                "--max-depth" => {
                    max_depth = value()?
                        .parse()
                        .map_err(|_| String::from("--max-depth needs a number"))?;
                }
                other => return Err(format!("unrecognised argument {other}")),
            }
        }
        Ok(Self {
            class_name: class_name
                .ok_or_else(|| String::from("--class names the window class to capture"))?,
            variant: variant.ok_or_else(|| {
                String::from("--variant records which build of the target this is, per C-9")
            })?,
            output: output.ok_or_else(|| String::from("--out names the capture file"))?,
            max_depth,
        })
    }
}

struct Search {
    wanted: Vec<u16>,
    found: isize,
}

fn class_of(window: HWND) -> Vec<u16> {
    let mut buffer = [0_u16; 256];
    let read = unsafe { GetClassNameW(window, buffer.as_mut_ptr(), buffer.len() as i32) };
    if read <= 0 {
        return Vec::new();
    }
    buffer[..read as usize].to_vec()
}

unsafe extern "system" fn visit(
    window: HWND,
    state: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::core::BOOL {
    let search = unsafe { &mut *(state as *mut Search) };
    if unsafe { IsWindowVisible(window) } == 0 {
        return 1;
    }
    if unsafe { GetWindowTextLengthW(window) } == 0 {
        return 1;
    }
    if class_of(window) != search.wanted {
        return 1;
    }
    search.found = window as isize;
    0
}

/// Finds one visible, titled top-level window of the requested class.
///
/// A target that is not running is reported as skipped by the caller rather
/// than dumped as an empty tree: a capture that silently contains nothing is
/// worse than no capture, because it reads as evidence.
pub fn find_window(options: &Options) -> Result<isize, String> {
    let mut search = Search {
        wanted: options.class_name.encode_utf16().collect(),
        found: 0,
    };
    unsafe {
        EnumWindows(
            Some(visit),
            &mut search as *mut Search as *mut c_void as isize,
        )
    };
    if search.found == 0 {
        return Err(format!(
            "no visible top-level window of class {} is running",
            options.class_name
        ));
    }
    Ok(search.found)
}
