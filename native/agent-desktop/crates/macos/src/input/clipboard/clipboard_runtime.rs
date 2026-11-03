use agent_desktop_core::{AdapterError, ErrorCode};
use std::ffi::c_void;

pub(crate) type Pasteboard = *mut c_void;
type Class = *mut c_void;
type Sel = *mut c_void;

const PASTEBOARD_ACCESS_ALWAYS_DENY: isize = 3;

unsafe extern "C" {
    fn objc_getClass(name: *const core::ffi::c_char) -> Class;
    fn sel_registerName(name: *const core::ffi::c_char) -> Sel;
    fn objc_msgSend(receiver: Pasteboard, sel: Sel, ...) -> Pasteboard;
}

pub(crate) struct AutoreleasePool {
    pool: Pasteboard,
}

impl AutoreleasePool {
    pub(crate) fn new() -> Result<Self, AdapterError> {
        crate::system::cocoa_runtime::ensure_cocoa_multithreaded()?;
        unsafe {
            let class = objc_getClass(c"NSAutoreleasePool".as_ptr());
            if class.is_null() {
                return Err(unavailable("NSAutoreleasePool class was not found"));
            }
            let send: unsafe extern "C" fn(Pasteboard, Sel) -> Pasteboard =
                std::mem::transmute(objc_msgSend as *const c_void);
            let pool = send(
                send(class as Pasteboard, sel_registerName(c"alloc".as_ptr())),
                sel_registerName(c"init".as_ptr()),
            );
            if pool.is_null() {
                return Err(unavailable("NSAutoreleasePool initialization failed"));
            }
            Ok(Self { pool })
        }
    }
}

impl Drop for AutoreleasePool {
    fn drop(&mut self) {
        unsafe {
            let send: unsafe extern "C" fn(Pasteboard, Sel) =
                std::mem::transmute(objc_msgSend as *const c_void);
            send(self.pool, sel_registerName(c"drain".as_ptr()));
        }
    }
}

pub(crate) fn pasteboard() -> Result<Pasteboard, AdapterError> {
    unsafe {
        let class = objc_getClass(c"NSPasteboard".as_ptr());
        if class.is_null() {
            return Err(unavailable("NSPasteboard class was not found"));
        }
        let send: unsafe extern "C" fn(Pasteboard, Sel) -> Pasteboard =
            std::mem::transmute(objc_msgSend as *const c_void);
        let pasteboard = send(
            class as Pasteboard,
            sel_registerName(c"generalPasteboard".as_ptr()),
        );
        if pasteboard.is_null() {
            return Err(unavailable("NSPasteboard generalPasteboard returned null"));
        }
        Ok(pasteboard)
    }
}

pub(crate) unsafe fn clear_contents(pasteboard: Pasteboard) -> isize {
    unsafe {
        let send: unsafe extern "C" fn(Pasteboard, Sel) -> isize =
            std::mem::transmute(objc_msgSend as *const c_void);
        send(pasteboard, sel_registerName(c"clearContents".as_ptr()))
    }
}

pub(crate) unsafe fn change_count(pasteboard: Pasteboard) -> isize {
    unsafe {
        let send: unsafe extern "C" fn(Pasteboard, Sel) -> isize =
            std::mem::transmute(objc_msgSend as *const c_void);
        send(pasteboard, sel_registerName(c"changeCount".as_ptr()))
    }
}

pub(crate) fn ensure_read_access(pasteboard: Pasteboard) -> Result<(), AdapterError> {
    unsafe {
        let access_selector = sel_registerName(c"accessBehavior".as_ptr());
        let responds: unsafe extern "C" fn(Pasteboard, Sel, Sel) -> bool =
            std::mem::transmute(objc_msgSend as *const c_void);
        if !responds(
            pasteboard,
            sel_registerName(c"respondsToSelector:".as_ptr()),
            access_selector,
        ) {
            return Ok(());
        }
        let send: unsafe extern "C" fn(Pasteboard, Sel) -> isize =
            std::mem::transmute(objc_msgSend as *const c_void);
        if !read_access_denied(send(pasteboard, access_selector)) {
            return Ok(());
        }
        Err(AdapterError::new(
            ErrorCode::PermDenied,
            "System clipboard read access is denied",
        )
        .with_suggestion(
            "Allow pasteboard access for the app that launches agent-desktop in System Settings, then retry.",
        ))
    }
}

fn read_access_denied(behavior: isize) -> bool {
    behavior == PASTEBOARD_ACCESS_ALWAYS_DENY
}

fn unavailable(detail: impl Into<String>) -> AdapterError {
    AdapterError::new(ErrorCode::ActionFailed, "System clipboard is unavailable")
        .with_platform_detail(detail)
        .with_suggestion(
            "Retry from an interactive macOS login session after the pasteboard service is available.",
        )
}

#[cfg(test)]
#[path = "clipboard_runtime_tests.rs"]
mod tests;
