use agent_desktop_core::{AdapterError, ErrorCode};
use std::{ffi::c_void, ptr::NonNull};

type Id = *mut c_void;
type Sel = *mut c_void;

unsafe extern "C" {
    fn sel_registerName(name: *const core::ffi::c_char) -> Sel;
    fn objc_msgSend(receiver: Id, sel: Sel, ...) -> Id;
}

pub(crate) struct OwnedObject(NonNull<c_void>);

impl OwnedObject {
    pub(crate) fn from_id(id: Id, operation: &str) -> Result<Self, AdapterError> {
        NonNull::new(id).map(Self).ok_or_else(|| {
            AdapterError::new(ErrorCode::ActionFailed, "System clipboard is unavailable")
                .with_platform_detail(format!("{operation} returned an unavailable object"))
                .with_suggestion(
                    "Retry from an interactive macOS login session after the pasteboard service is available.",
                )
        })
    }

    pub(crate) fn as_id(&self) -> Id {
        self.0.as_ptr()
    }
}

impl Drop for OwnedObject {
    fn drop(&mut self) {
        unsafe {
            let send: unsafe extern "C" fn(Id, Sel) =
                std::mem::transmute(objc_msgSend as *const c_void);
            send(self.as_id(), sel_registerName(c"release".as_ptr()));
        }
    }
}
