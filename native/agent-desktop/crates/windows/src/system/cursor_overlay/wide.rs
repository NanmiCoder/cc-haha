//! A Rust string as the null-terminated UTF-16 the Win32 `W` entry points
//! read, plus the `GetLastError`-to-`AdapterError` conversion every
//! `cursor_overlay` call site otherwise re-derives.
//!
//! Every call in this module that names a pipe, a window class or a font face
//! needs the same conversion, and each had grown its own copy. The terminator
//! is the part that matters: a `W` function reads until it finds one, so a
//! buffer without it is read past its end.

/// Borrows nothing back to the caller. The returned buffer owns the
/// terminator, so it has to outlive the call it is passed to - a temporary
/// built inside an argument list is freed before the call returns on some
/// paths, which is why every caller binds it first.
pub(crate) fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The last Win32 error, read here rather than at each call site, folded
/// into an internal `AdapterError` naming what failed. `message` describes
/// the failed operation; the code itself lands in the platform detail.
pub(crate) fn win32_error(message: &str) -> agent_desktop_core::AdapterError {
    let code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
    agent_desktop_core::AdapterError::internal(message)
        .with_platform_detail(format!("Win32 error {code}"))
}

#[cfg(test)]
#[path = "wide_tests.rs"]
mod tests;
