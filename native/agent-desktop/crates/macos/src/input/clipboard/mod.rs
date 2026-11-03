use agent_desktop_core::{AdapterError, ErrorCode};

#[cfg(target_os = "macos")]
#[path = "clipboard_runtime.rs"]
mod clipboard_runtime;
pub(super) mod owned_object;

#[cfg(target_os = "macos")]
#[path = "clipboard_file_urls.rs"]
mod clipboard_file_urls;

#[cfg(target_os = "macos")]
#[path = "clipboard_rich.rs"]
mod clipboard_rich;

#[cfg(target_os = "macos")]
#[path = "clipboard_image_io.rs"]
mod clipboard_image_io;

#[cfg(target_os = "macos")]
#[path = "clipboard_transaction.rs"]
mod clipboard_transaction;

#[cfg(target_os = "macos")]
#[path = "clipboard_helper_client.rs"]
mod clipboard_helper_client;

#[cfg(target_os = "macos")]
#[path = "clipboard_helper_protocol.rs"]
mod clipboard_helper_protocol;

#[cfg(target_os = "macos")]
#[path = "clipboard_helper_entry.rs"]
mod clipboard_helper_entry;

#[cfg(target_os = "macos")]
#[path = "clipboard_helper_dl.rs"]
mod clipboard_helper_dl;

#[cfg(target_os = "macos")]
#[path = "clipboard_helper_identity.rs"]
mod clipboard_helper_identity;

#[cfg(target_os = "macos")]
#[path = "clipboard_helper_process.rs"]
mod clipboard_helper_process;

#[cfg(target_os = "macos")]
mod imp {
    use super::clipboard_runtime::{
        AutoreleasePool, Pasteboard as Id, change_count, ensure_read_access, pasteboard,
    };
    use super::*;
    use agent_desktop_core::{
        ClipboardContent, ClipboardFormat, Deadline, ImageBuffer, ImageFormat,
    };
    use core_foundation::base::TCFType;
    use std::ffi::c_void;

    #[cfg(all(test, feature = "interactive-tests"))]
    mod interactive_tests {
        include!("clipboard_tests.rs");
    }

    type Sel = *mut c_void;

    const MAX_CLIPBOARD_TEXT_UTF16: usize = 1_000_000;

    unsafe extern "C" {
        fn sel_registerName(name: *const core::ffi::c_char) -> Sel;
        fn objc_msgSend(receiver: Id, sel: Sel, ...) -> Id;
        static NSPasteboardTypeString: Id;
    }

    pub(crate) fn clear_direct(deadline: Deadline) -> Result<(), AdapterError> {
        tracing::debug!("clipboard: clear");
        let _pool = AutoreleasePool::new()?;
        let pb = pasteboard()?;
        super::clipboard_transaction::clear_verified(pb, deadline)
    }

    pub(crate) fn get_content_direct(
        format: ClipboardFormat,
        deadline: Deadline,
    ) -> Result<Option<ClipboardContent>, AdapterError> {
        tracing::debug!("clipboard: get_content format={format:?}");
        let _pool = AutoreleasePool::new()?;
        let pb = pasteboard()?;
        ensure_read_access(pb)?;
        for attempt in 0..2 {
            ensure_read_budget(deadline)?;
            let before = unsafe { change_count(pb) };
            let content = unsafe { get_content_from(pb, format, deadline) }?;
            ensure_read_budget(deadline)?;
            if before == unsafe { change_count(pb) } {
                return Ok(content);
            }
            if attempt == 1 {
                return Err(concurrent_change_error("read"));
            }
        }
        Err(AdapterError::internal(
            "Clipboard stable-read loop exited unexpectedly",
        ))
    }

    unsafe fn get_content_from(
        pb: Id,
        format: ClipboardFormat,
        deadline: Deadline,
    ) -> Result<Option<ClipboardContent>, AdapterError> {
        unsafe {
            match format {
                ClipboardFormat::Text => Ok(read_string(pb)?.map(ClipboardContent::Text)),
                ClipboardFormat::Image => {
                    Ok(super::clipboard_rich::read_image(pb, deadline)?.map(build_image_content))
                }
                ClipboardFormat::FileUrls => {
                    let urls = super::clipboard_rich::read_file_urls(pb, deadline)?;
                    Ok((!urls.is_empty()).then_some(ClipboardContent::FileUrls(urls)))
                }
                ClipboardFormat::Auto => auto_content(pb, deadline),
            }
        }
    }

    unsafe fn auto_content(
        pb: Id,
        deadline: Deadline,
    ) -> Result<Option<ClipboardContent>, AdapterError> {
        unsafe {
            let urls = super::clipboard_rich::read_file_urls(pb, deadline)?;
            if !urls.is_empty() {
                return Ok(Some(ClipboardContent::FileUrls(urls)));
            }
            if let Some(image) = super::clipboard_rich::read_image(pb, deadline)? {
                return Ok(Some(build_image_content(image)));
            }
            Ok(read_string(pb)?.map(ClipboardContent::Text))
        }
    }

    fn build_image_content(image: (Vec<u8>, (u32, u32))) -> ClipboardContent {
        let (bytes, (width, height)) = image;
        ClipboardContent::Image(ImageBuffer {
            data: bytes,
            format: ImageFormat::Png,
            width,
            height,
            scale_factor: 1.0,
        })
    }

    pub(crate) fn set_content_direct(
        content: &ClipboardContent,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        validate_content(content)?;
        let _pool = AutoreleasePool::new()?;
        ensure_read_budget(deadline)?;
        let pb = pasteboard()?;
        set_content_on(pb, content, deadline)
    }

    fn set_content_on(
        pb: Id,
        content: &ClipboardContent,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        match content {
            ClipboardContent::Text(text) => replace_on(
                pb,
                "text",
                deadline,
                |pb, deadline| unsafe { write_string(pb, text, deadline) },
                |pb, deadline| unsafe {
                    ensure_read_budget(deadline)?;
                    let matches = read_string(pb)?.as_deref() == Some(text);
                    ensure_read_budget(deadline)?;
                    Ok(matches)
                },
            ),
            ClipboardContent::Image(image) => {
                let (prepared, dimensions) = super::clipboard_rich::prepare_image(&image.data)?;
                if !matches!(&image.format, ImageFormat::Png)
                    || dimensions != (image.width, image.height)
                    || !image.scale_factor.is_finite()
                    || image.scale_factor <= 0.0
                {
                    return Err(AdapterError::new(
                        ErrorCode::InvalidArgs,
                        "Clipboard image metadata does not match its PNG payload",
                    ));
                }
                replace_on(
                    pb,
                    "image",
                    deadline,
                    |pb, deadline| {
                        super::clipboard_rich::write_image(pb, prepared.as_ref(), deadline)
                    },
                    |pb, deadline| {
                        Ok(super::clipboard_rich::read_image(pb, deadline)?
                            .as_ref()
                            .is_some_and(|(bytes, _)| bytes.as_slice() == prepared.as_ref()))
                    },
                )
            }
            ClipboardContent::FileUrls(paths) => {
                let prepared = super::clipboard_rich::prepare_file_urls(paths)?;
                replace_on(
                    pb,
                    "file URLs",
                    deadline,
                    |pb, deadline| super::clipboard_rich::write_file_urls(pb, &prepared, deadline),
                    |pb, deadline| {
                        Ok(
                            super::clipboard_rich::read_file_urls(pb, deadline)?
                                == prepared.paths(),
                        )
                    },
                )
            }
        }
    }

    fn replace_on(
        pb: Id,
        kind: &str,
        deadline: Deadline,
        write: impl FnOnce(Id, Deadline) -> Result<bool, AdapterError>,
        verify: impl FnOnce(Id, Deadline) -> Result<bool, AdapterError>,
    ) -> Result<(), AdapterError> {
        super::clipboard_transaction::replace_on(pb, kind, deadline, write, verify)
    }

    unsafe fn read_string(pb: Id) -> Result<Option<String>, AdapterError> {
        unsafe {
            let sel = sel_registerName(c"stringForType:".as_ptr());
            let send: unsafe extern "C" fn(Id, Sel, Id) -> Id =
                std::mem::transmute(objc_msgSend as *const c_void);
            let ns_string = send(pb, sel, NSPasteboardTypeString);
            if ns_string.is_null() {
                return Ok(None);
            }
            let string_ref = ns_string as core_foundation_sys::string::CFStringRef;
            let length = core_foundation_sys::string::CFStringGetLength(string_ref);
            if length < 0 || length as usize > MAX_CLIPBOARD_TEXT_UTF16 {
                return Err(clipboard_resource_limit_error(
                    "clipboard text",
                    length.max(0) as usize,
                ));
            }
            let cf_str = core_foundation::string::CFString::wrap_under_get_rule(string_ref);
            Ok(Some(cf_str.to_string()))
        }
    }

    fn validate_content(content: &ClipboardContent) -> Result<(), AdapterError> {
        match content {
            ClipboardContent::Text(text) => {
                let utf16_units = text.encode_utf16().count();
                if utf16_units > MAX_CLIPBOARD_TEXT_UTF16 {
                    Err(input_resource_limit_error("clipboard text", utf16_units))
                } else {
                    Ok(())
                }
            }
            ClipboardContent::Image(_) | ClipboardContent::FileUrls(_) => Ok(()),
        }
    }

    fn concurrent_change_error(phase: &str) -> AdapterError {
        AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Clipboard changed concurrently during a stable operation",
        )
        .with_details(serde_json::json!({
            "phase": phase,
            "concurrent_change": true,
            "retryable": true,
        }))
    }

    fn input_resource_limit_error(kind: &str, observed: usize) -> AdapterError {
        AdapterError::new(
            ErrorCode::InvalidArgs,
            format!("{kind} exceeds the supported resource budget"),
        )
        .with_details(serde_json::json!({ "kind": kind, "observed": observed }))
    }

    fn clipboard_resource_limit_error(kind: &str, observed: usize) -> AdapterError {
        AdapterError::new(
            ErrorCode::ActionFailed,
            format!("{kind} exceeds the supported resource budget"),
        )
        .with_details(serde_json::json!({ "kind": kind, "observed": observed }))
    }

    unsafe fn write_string(pb: Id, text: &str, deadline: Deadline) -> Result<bool, AdapterError> {
        unsafe {
            ensure_read_budget(deadline)?;
            let cf_text = core_foundation::string::CFString::new(text);
            let ns_text = cf_text.as_concrete_TypeRef() as Id;
            let set_sel = sel_registerName(c"setString:forType:".as_ptr());
            let send_two: unsafe extern "C" fn(Id, Sel, Id, Id) -> bool =
                std::mem::transmute(objc_msgSend as *const c_void);
            Ok(send_two(pb, set_sel, ns_text, NSPasteboardTypeString))
        }
    }

    fn ensure_read_budget(deadline: Deadline) -> Result<(), AdapterError> {
        if deadline.is_expired() {
            Err(deadline.timeout_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    pub fn clear(_deadline: agent_desktop_core::Deadline) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("clipboard_clear"))
    }

    pub fn get_content(
        _format: agent_desktop_core::ClipboardFormat,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<Option<agent_desktop_core::ClipboardContent>, AdapterError> {
        Err(AdapterError::not_supported("get_clipboard_content"))
    }

    pub fn set_content(
        _content: &agent_desktop_core::ClipboardContent,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("set_clipboard_content"))
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn clear(deadline: agent_desktop_core::Deadline) -> Result<(), AdapterError> {
    clipboard_helper_client::clear(deadline)
}

#[cfg(target_os = "macos")]
pub(crate) fn get_content(
    format: agent_desktop_core::ClipboardFormat,
    deadline: agent_desktop_core::Deadline,
) -> Result<Option<agent_desktop_core::ClipboardContent>, AdapterError> {
    clipboard_helper_client::read(format, deadline)
}

#[cfg(target_os = "macos")]
pub(crate) fn set_content(
    content: &agent_desktop_core::ClipboardContent,
    deadline: agent_desktop_core::Deadline,
) -> Result<(), AdapterError> {
    clipboard_helper_client::write(content, deadline)
}

#[cfg(target_os = "macos")]
pub use clipboard_helper_entry::entry_from_env as helper_entry_from_env;

#[cfg(target_os = "macos")]
pub(crate) use imp::{clear_direct, get_content_direct, set_content_direct};

#[cfg(not(target_os = "macos"))]
pub(crate) use imp::{clear, get_content, set_content};

pub(crate) mod directory_identity;
