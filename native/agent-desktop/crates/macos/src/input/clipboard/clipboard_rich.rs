use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, MAX_PNG_INPUT_BYTES, parse_png_dimensions,
};
use std::borrow::Cow;
use std::ffi::c_void;

pub(crate) use super::clipboard_file_urls::{prepare_file_urls, read_file_urls, write_file_urls};

type Id = *mut c_void;
type Sel = *mut c_void;
type ImageDimensions = (u32, u32);
type PreparedImage<'a> = (Cow<'a, [u8]>, ImageDimensions);
type OwnedImage = (Vec<u8>, ImageDimensions);

const MAX_IMAGE_PIXELS: u64 = 64 * 1024 * 1024;
const PNG_HEADER_BYTES: usize = 24;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

unsafe extern "C" {
    fn sel_registerName(name: *const core::ffi::c_char) -> Sel;
    fn objc_msgSend(receiver: Id, sel: Sel, ...) -> Id;
    static NSPasteboardTypePNG: Id;
}

pub(crate) fn prepare_image(bytes: &[u8]) -> Result<PreparedImage<'_>, AdapterError> {
    validate_byte_count(bytes.len(), true)?;
    let header_dimensions = validate_png_header(bytes, true)?;
    let dimensions = parse_png_dimensions(bytes)
        .ok_or_else(|| invalid_image("Clipboard images must be complete, valid PNG payloads"))?;
    if dimensions != header_dimensions || !super::clipboard_image_io::is_complete_png(bytes) {
        return Err(invalid_image("Clipboard PNG failed platform validation"));
    }
    Ok((Cow::Borrowed(bytes), dimensions))
}

pub(crate) fn read_image(pb: Id, deadline: Deadline) -> Result<Option<OwnedImage>, AdapterError> {
    deadline.ensure_remaining()?;
    let png = unsafe { read_data(pb, NSPasteboardTypePNG, deadline) }?;
    let result = normalize_image_data(png)?;
    deadline.ensure_remaining()?;
    Ok(result)
}

fn normalize_image_data(png: Option<Vec<u8>>) -> Result<Option<OwnedImage>, AdapterError> {
    let Some(bytes) = png else {
        return Ok(None);
    };
    let header_dimensions = validate_png_header(&bytes, false)?;
    let dimensions = parse_png_dimensions(&bytes)
        .ok_or_else(|| clipboard_data_error("Clipboard PNG payload failed complete validation"))?;
    if dimensions != header_dimensions || !super::clipboard_image_io::is_complete_png(&bytes) {
        return Err(clipboard_data_error(
            "Clipboard PNG failed platform validation",
        ));
    }
    Ok(Some((bytes, dimensions)))
}

pub(crate) fn write_image(pb: Id, png: &[u8], deadline: Deadline) -> Result<bool, AdapterError> {
    deadline.ensure_remaining()?;
    if png.len() > MAX_PNG_INPUT_BYTES {
        return Ok(false);
    }
    unsafe { Ok(write_data(pb, png, NSPasteboardTypePNG)) }
}

unsafe fn read_data(
    pb: Id,
    pasteboard_type: Id,
    deadline: Deadline,
) -> Result<Option<Vec<u8>>, AdapterError> {
    unsafe {
        let send: unsafe extern "C" fn(Id, Sel, Id) -> Id =
            std::mem::transmute(objc_msgSend as *const c_void);
        let data = send(
            pb,
            sel_registerName(c"dataForType:".as_ptr()),
            pasteboard_type,
        );
        if data.is_null() {
            return Ok(None);
        }
        copy_nsdata(data, deadline)
    }
}

unsafe fn copy_nsdata(data: Id, deadline: Deadline) -> Result<Option<Vec<u8>>, AdapterError> {
    unsafe {
        deadline.ensure_remaining()?;
        let send_usize: unsafe extern "C" fn(Id, Sel) -> usize =
            std::mem::transmute(objc_msgSend as *const c_void);
        let len = send_usize(data, sel_registerName(c"length".as_ptr()));
        validate_byte_count(len, false)?;
        if len == 0 {
            return Ok(Some(Vec::new()));
        }
        let send_ptr: unsafe extern "C" fn(Id, Sel) -> *const u8 =
            std::mem::transmute(objc_msgSend as *const c_void);
        let ptr = send_ptr(data, sel_registerName(c"bytes".as_ptr()));
        if ptr.is_null() {
            return Err(clipboard_data_error("NSData returned null bytes"));
        }
        let bytes = std::slice::from_raw_parts(ptr, len);
        validate_png_header(bytes, false)?;
        let copy = bytes.to_vec();
        deadline.ensure_remaining()?;
        Ok(Some(copy))
    }
}

unsafe fn write_data(pb: Id, bytes: &[u8], pasteboard_type: Id) -> bool {
    unsafe extern "C" {
        fn objc_getClass(name: *const core::ffi::c_char) -> *mut c_void;
    }
    unsafe {
        let class = objc_getClass(c"NSData".as_ptr());
        if class.is_null() {
            return false;
        }
        let send_data: unsafe extern "C" fn(Id, Sel, *const u8, usize) -> Id =
            std::mem::transmute(objc_msgSend as *const c_void);
        let data = send_data(
            class as Id,
            sel_registerName(c"dataWithBytes:length:".as_ptr()),
            bytes.as_ptr(),
            bytes.len(),
        );
        if data.is_null() {
            return false;
        }
        let send_set: unsafe extern "C" fn(Id, Sel, Id, Id) -> bool =
            std::mem::transmute(objc_msgSend as *const c_void);
        send_set(
            pb,
            sel_registerName(c"setData:forType:".as_ptr()),
            data,
            pasteboard_type,
        )
    }
}

fn validate_png_header(data: &[u8], argument: bool) -> Result<(u32, u32), AdapterError> {
    let dimensions = data
        .get(..PNG_HEADER_BYTES)
        .filter(|header| header.get(..8) == Some(PNG_SIGNATURE.as_slice()))
        .filter(|header| header.get(8..12) == Some(13_u32.to_be_bytes().as_slice()))
        .filter(|header| header.get(12..16) == Some(b"IHDR"))
        .and_then(|header| {
            Some((
                u32::from_be_bytes(header.get(16..20)?.try_into().ok()?),
                u32::from_be_bytes(header.get(20..24)?.try_into().ok()?),
            ))
        });
    let Some(dimensions) = dimensions else {
        return Err(if argument {
            invalid_image("Clipboard image is missing a valid PNG header")
        } else {
            clipboard_data_error("Clipboard image is missing a valid PNG header")
        });
    };
    validate_dimensions(dimensions, argument)?;
    Ok(dimensions)
}

fn validate_byte_count(bytes: usize, argument: bool) -> Result<(), AdapterError> {
    if bytes <= MAX_PNG_INPUT_BYTES {
        return Ok(());
    }
    Err(if argument {
        invalid_image("Image exceeds the 64 MiB encoded-data budget")
    } else {
        clipboard_data_error("Clipboard image exceeds the 64 MiB encoded-data budget")
    })
}

fn validate_dimensions(dimensions: (u32, u32), argument: bool) -> Result<(), AdapterError> {
    let (width, height) = dimensions;
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| clipboard_data_error("Image pixel count overflowed"))?;
    if width > 0 && height > 0 && pixels <= MAX_IMAGE_PIXELS {
        return Ok(());
    }
    Err(if argument {
        invalid_image("Image exceeds the decoded-image budget")
    } else {
        clipboard_data_error("Clipboard image exceeds the decoded-image budget")
    })
}

fn invalid_image(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, message)
}

fn clipboard_data_error(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::ActionFailed, message)
}

#[cfg(test)]
#[path = "clipboard_rich_tests.rs"]
mod tests;
