use core_foundation::base::{CFType, TCFType, kCFAllocatorDefault, kCFAllocatorNull};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation_sys::base::{CFEqual, CFTypeRef};
use core_foundation_sys::data::{CFDataCreateWithBytesNoCopy, CFDataRef};
use core_foundation_sys::dictionary::CFDictionaryRef;
use core_foundation_sys::string::CFStringRef;
use libc::{c_uint, c_ulong};
use std::ffi::c_void;

type ImageSource = *const c_void;

const MAX_PNG_CHUNKS: usize = 65_536;

#[link(name = "ImageIO", kind = "framework")]
unsafe extern "C" {
    fn CGImageSourceCreateWithData(data: CFDataRef, options: CFDictionaryRef) -> ImageSource;
    fn CGImageSourceGetCount(source: ImageSource) -> usize;
    fn CGImageSourceGetStatus(source: ImageSource) -> i32;
    fn CGImageSourceGetStatusAtIndex(source: ImageSource, index: usize) -> i32;
    fn CGImageSourceGetType(source: ImageSource) -> CFStringRef;
    fn CGImageSourceCreateThumbnailAtIndex(
        source: ImageSource,
        index: usize,
        options: CFDictionaryRef,
    ) -> CFTypeRef;
    static kCGImageSourceCreateThumbnailFromImageAlways: CFStringRef;
    static kCGImageSourceThumbnailMaxPixelSize: CFStringRef;
    static kCGImageSourceShouldCacheImmediately: CFStringRef;
}

#[link(name = "z")]
unsafe extern "C" {
    fn crc32(crc: c_ulong, buffer: *const u8, length: c_uint) -> c_ulong;
}

pub(crate) fn is_complete_png(bytes: &[u8]) -> bool {
    if !has_complete_chunk_stream(bytes) {
        return false;
    }
    let Ok(length) = isize::try_from(bytes.len()) else {
        return false;
    };
    unsafe {
        let data = CFDataCreateWithBytesNoCopy(
            kCFAllocatorDefault,
            bytes.as_ptr(),
            length,
            kCFAllocatorNull,
        );
        if data.is_null() {
            return false;
        }
        let data = CFType::wrap_under_create_rule(data as CFTypeRef);
        let source =
            CGImageSourceCreateWithData(data.as_CFTypeRef() as CFDataRef, std::ptr::null());
        if source.is_null() {
            return false;
        }
        let source = CFType::wrap_under_create_rule(source as CFTypeRef);
        let source_ref = source.as_CFTypeRef() as ImageSource;
        let source_type = CGImageSourceGetType(source_ref);
        let png_type = CFString::new("public.png");
        let structurally_complete = !source_type.is_null()
            && CFEqual(source_type as CFTypeRef, png_type.as_CFTypeRef()) != 0
            && CGImageSourceGetCount(source_ref) == 1
            && CGImageSourceGetStatus(source_ref) == 0
            && CGImageSourceGetStatusAtIndex(source_ref, 0) == 0;
        structurally_complete && decodes_thumbnail(source_ref)
    }
}

fn has_complete_chunk_stream(bytes: &[u8]) -> bool {
    let mut cursor = 8_usize;
    let mut seen_header = false;
    let mut seen_image_data = false;
    let mut image_data_ended = false;
    let mut chunks = 0_usize;
    while cursor < bytes.len() {
        chunks += 1;
        if chunks > MAX_PNG_CHUNKS {
            return false;
        }
        let Some(length) = read_u32(bytes, cursor).and_then(|value| usize::try_from(value).ok())
        else {
            return false;
        };
        let Some(kind_start) = cursor.checked_add(4) else {
            return false;
        };
        let Some(data_start) = kind_start.checked_add(4) else {
            return false;
        };
        let Some(data_end) = data_start.checked_add(length) else {
            return false;
        };
        let Some(chunk_end) = data_end.checked_add(4) else {
            return false;
        };
        let Some(kind): Option<&[u8; 4]> = bytes
            .get(kind_start..data_start)
            .and_then(|value| value.try_into().ok())
        else {
            return false;
        };
        let Some(data) = bytes.get(data_start..data_end) else {
            return false;
        };
        let Some(stored_crc) = read_u32(bytes, data_end) else {
            return false;
        };
        if chunk_end > bytes.len()
            || !kind.iter().all(u8::is_ascii_alphabetic)
            || !kind[2].is_ascii_uppercase()
            || chunk_crc(kind, data) != stored_crc
        {
            return false;
        }
        match kind {
            b"IHDR" => {
                if seen_header || cursor != 8 || length != 13 {
                    return false;
                }
                seen_header = true;
            }
            b"IDAT" => {
                if !seen_header || image_data_ended {
                    return false;
                }
                seen_image_data = true;
            }
            b"IEND" => {
                return seen_header && seen_image_data && length == 0 && chunk_end == bytes.len();
            }
            _ => {
                image_data_ended |= seen_image_data;
            }
        }
        cursor = chunk_end;
    }
    false
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn chunk_crc(kind: &[u8; 4], data: &[u8]) -> u32 {
    unsafe {
        let crc = crc32(0, kind.as_ptr(), kind.len() as c_uint);
        crc32(crc, data.as_ptr(), data.len() as c_uint) as u32
    }
}

unsafe fn decodes_thumbnail(source: ImageSource) -> bool {
    unsafe {
        let keys = [
            CFString::wrap_under_get_rule(kCGImageSourceCreateThumbnailFromImageAlways).as_CFType(),
            CFString::wrap_under_get_rule(kCGImageSourceThumbnailMaxPixelSize).as_CFType(),
            CFString::wrap_under_get_rule(kCGImageSourceShouldCacheImmediately).as_CFType(),
        ];
        let values = [
            CFBoolean::true_value().as_CFType(),
            CFNumber::from(1_i32).as_CFType(),
            CFBoolean::true_value().as_CFType(),
        ];
        let options = CFDictionary::from_CFType_pairs(&[
            (keys[0].clone(), values[0].clone()),
            (keys[1].clone(), values[1].clone()),
            (keys[2].clone(), values[2].clone()),
        ]);
        let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options.as_concrete_TypeRef());
        if image.is_null() {
            return false;
        }
        let _image = CFType::wrap_under_create_rule(image);
        true
    }
}

#[cfg(test)]
#[path = "clipboard_image_io_tests.rs"]
mod tests;
