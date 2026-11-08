use agent_desktop_core::{AdapterError, ErrorCode, ImageBuffer};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub(crate) enum AllocationKind {
    ActionPostState,
    ActionStateStrings,
    ActionSteps,
    CString,
    NotificationActions,
    TreeNodes,
    TreeStateStrings,
}

static ALLOCATIONS: OnceLock<Mutex<HashMap<(AllocationKind, usize), usize>>> = OnceLock::new();

pub(crate) const MAX_FFI_LIST_ITEMS: usize = 100_000;
pub(crate) const MAX_FFI_IMAGE_BYTES: usize = 512 * 1024 * 1024;

fn allocations() -> MutexGuard<'static, HashMap<(AllocationKind, usize), usize>> {
    match ALLOCATIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub(crate) fn register_allocation<T>(kind: AllocationKind, ptr: *mut T, len: usize) {
    if !ptr.is_null() {
        allocations().insert((kind, ptr.addr()), len);
    }
}

pub(crate) fn take_allocation<T>(kind: AllocationKind, ptr: *mut T) -> Option<usize> {
    (!ptr.is_null())
        .then(|| allocations().remove(&(kind, ptr.addr())))
        .flatten()
}

pub(crate) fn validate_list_len(len: usize, label: &str) -> Result<(), AdapterError> {
    if len <= MAX_FFI_LIST_ITEMS && u32::try_from(len).is_ok() {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::Internal,
        format!("{label} exceeds the FFI output item limit"),
    ))
}

pub(crate) fn validate_output_string(value: &str, label: &str) -> Result<(), AdapterError> {
    if value.len() <= crate::convert::string::AD_MAX_STRING_BYTES {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::Internal,
        format!("{label} exceeds the FFI output string limit"),
    ))
}

pub(crate) fn validate_image(image: &ImageBuffer) -> Result<(), AdapterError> {
    validate_image_parts(
        image.data.len(),
        image.width,
        image.height,
        image.scale_factor,
    )
}

fn validate_image_parts(
    byte_len: usize,
    width: u32,
    height: u32,
    scale_factor: f64,
) -> Result<(), AdapterError> {
    if byte_len > MAX_FFI_IMAGE_BYTES {
        return Err(image_validation_error(
            "Screenshot exceeds the FFI image byte limit",
            "bytes",
        ));
    }
    if width == 0 || height == 0 || width > 100_000 || height > 100_000 {
        return Err(image_validation_error(
            "Screenshot dimensions are outside the FFI image limits",
            "dimensions",
        ));
    }
    if !scale_factor.is_finite() || scale_factor <= 0.0 || scale_factor > 16.0 {
        return Err(image_validation_error(
            "Screenshot scale factor is outside the FFI image limits",
            "scale_factor",
        ));
    }
    Ok(())
}

fn image_validation_error(message: &str, reason: &str) -> AdapterError {
    AdapterError::new(ErrorCode::Internal, message)
        .with_details(serde_json::json!({ "reason": reason }))
}

#[cfg(test)]
#[path = "resource_tests.rs"]
mod tests;
