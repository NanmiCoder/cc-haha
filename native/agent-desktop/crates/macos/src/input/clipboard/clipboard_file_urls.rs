use agent_desktop_core::{AdapterError, Deadline, ErrorCode};
use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use core_foundation::url::CFURL;
use core_foundation_sys::base::kCFAllocatorDefault;
use core_foundation_sys::string::CFStringGetLength;
use core_foundation_sys::url::CFURLCreateWithString;
use std::ffi::c_void;

use crate::input::clipboard::owned_object::OwnedObject;

type Id = *mut c_void;
type Class = *mut c_void;
type Sel = *mut c_void;

const MAX_FILE_URLS: usize = 1_024;
const MAX_FILE_URL_UTF16: usize = 16_384;
const MAX_FILE_URL_TOTAL_UTF16: usize = 1_000_000;

unsafe extern "C" {
    fn objc_getClass(name: *const core::ffi::c_char) -> Class;
    fn sel_registerName(name: *const core::ffi::c_char) -> Sel;
    fn objc_msgSend(receiver: Id, sel: Sel, ...) -> Id;
    static NSPasteboardTypeFileURL: Id;
}

pub(crate) struct PreparedFileUrls {
    urls: Vec<CFURL>,
    paths: Vec<String>,
}

impl PreparedFileUrls {
    pub(crate) fn paths(&self) -> &[String] {
        &self.paths
    }
}

pub(crate) fn prepare_file_urls(paths: &[String]) -> Result<PreparedFileUrls, AdapterError> {
    if paths.is_empty() || paths.len() > MAX_FILE_URLS {
        return Err(invalid("File URL list must contain 1 to 1024 paths"));
    }
    let mut urls = Vec::with_capacity(paths.len());
    let mut normalized_paths = Vec::with_capacity(paths.len());
    let mut total_units = 0_usize;
    for path in paths {
        let units = path.encode_utf16().count();
        if path.is_empty()
            || path.contains('\0')
            || !std::path::Path::new(path).is_absolute()
            || units > MAX_FILE_URL_UTF16
        {
            return Err(invalid("Every file path must be a bounded absolute path"));
        }
        let url = CFURL::from_path(path, false)
            .ok_or_else(|| invalid("Every file path must be representable as a file URL"))?;
        let normalized = url
            .to_path()
            .and_then(|value| value.to_str().map(str::to_owned))
            .filter(|value| !value.contains('\0') && std::path::Path::new(value).is_absolute())
            .ok_or_else(|| invalid("Every file URL must resolve to a local UTF-8 path"))?;
        total_units = total_units
            .checked_add(normalized.encode_utf16().count())
            .ok_or_else(|| invalid("File URL text budget overflowed"))?;
        if total_units > MAX_FILE_URL_TOTAL_UTF16 {
            return Err(invalid("File URLs exceed the total text budget"));
        }
        urls.push(url);
        normalized_paths.push(normalized);
    }
    Ok(PreparedFileUrls {
        urls,
        paths: normalized_paths,
    })
}

pub(crate) fn read_file_urls(pb: Id, deadline: Deadline) -> Result<Vec<String>, AdapterError> {
    deadline.ensure_remaining()?;
    let result = unsafe { read_file_urls_inner(pb, deadline) }?;
    deadline.ensure_remaining()?;
    Ok(result)
}

unsafe fn read_file_urls_inner(pb: Id, deadline: Deadline) -> Result<Vec<String>, AdapterError> {
    unsafe {
        let send: unsafe extern "C" fn(Id, Sel) -> Id =
            std::mem::transmute(objc_msgSend as *const c_void);
        let types = send(pb, sel_registerName(c"types".as_ptr()));
        if types.is_null() {
            return Ok(Vec::new());
        }
        let send_contains: unsafe extern "C" fn(Id, Sel, Id) -> bool =
            std::mem::transmute(objc_msgSend as *const c_void);
        if !send_contains(
            types,
            sel_registerName(c"containsObject:".as_ptr()),
            NSPasteboardTypeFileURL,
        ) {
            return Ok(Vec::new());
        }
        let items = send(pb, sel_registerName(c"pasteboardItems".as_ptr()));
        if items.is_null() {
            return Err(data_error("Clipboard file URL items are unavailable"));
        }
        let send_usize: unsafe extern "C" fn(Id, Sel) -> usize =
            std::mem::transmute(objc_msgSend as *const c_void);
        let count = send_usize(items, sel_registerName(c"count".as_ptr()));
        if count > MAX_FILE_URLS {
            return Err(data_error("Clipboard contains too many file URLs"));
        }
        let send_at: unsafe extern "C" fn(Id, Sel, usize) -> Id =
            std::mem::transmute(objc_msgSend as *const c_void);
        let send_string: unsafe extern "C" fn(Id, Sel, Id) -> Id =
            std::mem::transmute(objc_msgSend as *const c_void);
        let mut urls = Vec::new();
        let mut total_units = 0_usize;
        for index in 0..count {
            deadline.ensure_remaining()?;
            let item = send_at(items, sel_registerName(c"objectAtIndex:".as_ptr()), index);
            if item.is_null() {
                return Err(data_error("Pasteboard item disappeared during read"));
            }
            let value = send_string(
                item,
                sel_registerName(c"stringForType:".as_ptr()),
                NSPasteboardTypeFileURL,
            );
            if value.is_null() {
                continue;
            }
            let string_ref = value as core_foundation_sys::string::CFStringRef;
            let units = CFStringGetLength(string_ref);
            if units < 0 || units as usize > MAX_FILE_URL_UTF16 {
                return Err(data_error("File URL exceeds its text budget"));
            }
            total_units = total_units
                .checked_add(units as usize)
                .ok_or_else(|| data_error("File URL text budget overflowed"))?;
            if total_units > MAX_FILE_URL_TOTAL_UTF16 {
                return Err(data_error("File URLs exceed the total text budget"));
            }
            let url = CFString::wrap_under_get_rule(string_ref).to_string();
            let path = file_url_to_path(&url)
                .ok_or_else(|| data_error("Clipboard file URL is not a local UTF-8 path"))?;
            urls.push(path);
        }
        Ok(urls)
    }
}

pub(crate) fn file_url_to_path(url_string: &str) -> Option<String> {
    if !url_string.starts_with("file:///")
        || url_string.contains('\0')
        || url_string.to_ascii_uppercase().contains("%00")
    {
        return None;
    }
    let value = CFString::new(url_string);
    let url_ref = unsafe {
        CFURLCreateWithString(
            kCFAllocatorDefault,
            value.as_concrete_TypeRef(),
            std::ptr::null(),
        )
    };
    if url_ref.is_null() {
        return None;
    }
    let url: CFURL = unsafe { TCFType::wrap_under_create_rule(url_ref) };
    let path = url.to_path()?;
    let path = path.to_str()?;
    (!path.contains('\0') && std::path::Path::new(path).is_absolute()).then(|| path.to_owned())
}

pub(crate) fn write_file_urls(
    pb: Id,
    prepared: &PreparedFileUrls,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    deadline.ensure_remaining()?;
    unsafe { write_file_urls_inner(pb, prepared, deadline) }
}

unsafe fn write_file_urls_inner(
    pb: Id,
    prepared: &PreparedFileUrls,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    unsafe {
        let class = objc_getClass(c"NSMutableArray".as_ptr());
        if class.is_null() {
            return Ok(false);
        }
        let send: unsafe extern "C" fn(Id, Sel) -> Id =
            std::mem::transmute(objc_msgSend as *const c_void);
        let array = OwnedObject::from_id(
            send(
                send(class as Id, sel_registerName(c"alloc".as_ptr())),
                sel_registerName(c"init".as_ptr()),
            ),
            "NSMutableArray initialization",
        )?;
        let send_add: unsafe extern "C" fn(Id, Sel, Id) =
            std::mem::transmute(objc_msgSend as *const c_void);
        for url in &prepared.urls {
            deadline.ensure_remaining()?;
            send_add(
                array.as_id(),
                sel_registerName(c"addObject:".as_ptr()),
                url.as_concrete_TypeRef() as Id,
            );
        }
        deadline.ensure_remaining()?;
        let send_write: unsafe extern "C" fn(Id, Sel, Id) -> bool =
            std::mem::transmute(objc_msgSend as *const c_void);
        Ok(send_write(
            pb,
            sel_registerName(c"writeObjects:".as_ptr()),
            array.as_id(),
        ))
    }
}

fn invalid(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, message)
}

fn data_error(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::ActionFailed, message)
}
