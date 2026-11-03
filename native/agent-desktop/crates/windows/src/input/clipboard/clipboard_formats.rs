//! Standard and registered Win32 clipboard format identifiers.

use windows_sys::Win32::System::DataExchange::RegisterClipboardFormatW;

pub(crate) const CF_UNICODETEXT: u32 = 13;
pub(crate) const CF_DIB: u32 = 8;
pub(crate) const CF_DIBV5: u32 = 17;
pub(crate) const CF_HDROP: u32 = 15;

pub(crate) fn registered_png_format() -> Option<u32> {
    let name: Vec<u16> = "PNG".encode_utf16().chain(std::iter::once(0)).collect();
    let format = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
    (format != 0).then_some(format)
}
