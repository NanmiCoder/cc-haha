use super::*;
use crate::input::interactive_test::{is_worker, run_bounded};
use agent_desktop_core::{ClipboardContent, ClipboardFormat, Deadline, ImageBuffer, ImageFormat};
use core_foundation::{base::TCFType, string::CFString};
use std::ffi::c_void;
use std::time::Duration;

type Class = *mut c_void;

unsafe extern "C" {
    fn objc_getClass(name: *const core::ffi::c_char) -> Class;
}

#[test]
fn native_clipboard_contract_is_bounded() {
    if is_worker("clipboard") {
        let _pool = AutoreleasePool::new().expect("autorelease pool is available");
        let pb = unique_pasteboard().expect("isolated pasteboard is available");
        let result = exercise_clipboard(pb);
        unsafe { release_globally(pb) };
        result.expect("isolated clipboard contract succeeds");
    } else {
        run_bounded(
            "native_clipboard_contract_is_bounded",
            "clipboard",
            Duration::from_secs(15),
        );
    }
}

fn exercise_clipboard(pb: Id) -> Result<(), AdapterError> {
    let deadline = Deadline::after(5_000)?;
    replace_on(
        pb,
        "text",
        deadline,
        |pb, deadline| unsafe { write_string(pb, "original clipboard value", deadline) },
        |pb, deadline| unsafe {
            ensure_read_budget(deadline)?;
            Ok(read_string(pb)?.as_deref() == Some("original clipboard value"))
        },
    )?;

    set_content_on(
        pb,
        &ClipboardContent::Text(String::from("replacement")),
        deadline,
    )?;
    assert!(matches!(
        unsafe { get_content_from(pb, ClipboardFormat::Text, deadline) }?,
        Some(ClipboardContent::Text(text)) if text == "replacement"
    ));

    let image = ClipboardContent::Image(ImageBuffer {
        data: one_pixel_png().to_vec(),
        format: ImageFormat::Png,
        width: 1,
        height: 1,
        scale_factor: 1.0,
    });
    set_content_on(pb, &image, deadline)?;
    let image_result = unsafe { get_content_from(pb, ClipboardFormat::Image, deadline) }?;
    assert!(matches!(
        image_result,
        Some(ClipboardContent::Image(ImageBuffer {
            width: 1,
            height: 1,
            ..
        }))
    ));
    Ok(())
}

fn unique_pasteboard() -> Result<Id, AdapterError> {
    unsafe {
        let class = objc_getClass(c"NSPasteboard".as_ptr());
        if class.is_null() {
            return Err(pasteboard_unavailable("NSPasteboard class was not found"));
        }
        let name = CFString::new(&format!(
            "com.norolabs.agent-desktop.tests.{}",
            std::process::id()
        ));
        let send: unsafe extern "C" fn(Class, Sel, Id) -> Id =
            std::mem::transmute(objc_msgSend as *const c_void);
        let pb = send(
            class,
            sel_registerName(c"pasteboardWithName:".as_ptr()),
            name.as_concrete_TypeRef() as Id,
        );
        if pb.is_null() {
            return Err(pasteboard_unavailable(
                "NSPasteboard pasteboardWithName returned null",
            ));
        }
        Ok(pb)
    }
}

fn pasteboard_unavailable(detail: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "Isolated test pasteboard is unavailable",
    )
    .with_platform_detail(detail)
}

unsafe fn release_globally(pb: Id) {
    unsafe {
        let send: unsafe extern "C" fn(Id, Sel) =
            std::mem::transmute(objc_msgSend as *const c_void);
        send(pb, sel_registerName(c"releaseGlobally".as_ptr()));
    }
}

fn one_pixel_png() -> [u8; 68] {
    [
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4,
        0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5,
        1, 1, 39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]
}
