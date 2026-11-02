use crate::convert::string::{free_c_string, string_to_c_lossy};
use crate::types::AdDisplayInfo;
use agent_desktop_core::{AdapterError, DisplayInfo, ErrorCode};
use std::os::raw::c_char;
use std::ptr;

pub(crate) fn validate_display_info(display: &DisplayInfo) -> Result<(), AdapterError> {
    if display.id.is_empty() {
        return Err(AdapterError::new(
            ErrorCode::Internal,
            "Display id is empty",
        ));
    }
    crate::resource::validate_output_string(&display.id, "Display id")?;
    display.bounds.validate().map_err(|error| {
        AdapterError::new(
            ErrorCode::Internal,
            format!("Display has invalid bounds: {}", error.message),
        )
    })?;
    if !display.scale.is_finite() || display.scale <= 0.0 {
        return Err(AdapterError::new(
            ErrorCode::Internal,
            "Display has invalid scale",
        ));
    }
    Ok(())
}

pub(crate) fn display_info_to_c(display: &DisplayInfo) -> AdDisplayInfo {
    AdDisplayInfo {
        version: crate::types::display_info::AD_DISPLAY_INFO_VERSION,
        size: crate::types::display_info::AD_DISPLAY_INFO_SIZE as u32,
        id: string_to_c_lossy(&display.id),
        bounds: crate::convert::rect_to_c(&display.bounds),
        is_primary: display.is_primary,
        scale: display.scale,
    }
}

pub(crate) unsafe fn free_display_info_fields(display: &mut AdDisplayInfo) {
    unsafe {
        free_c_string(display.id as *mut c_char);
        display.id = ptr::null();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::string::c_to_string;
    use agent_desktop_core::Rect;

    fn display() -> DisplayInfo {
        DisplayInfo {
            id: "main".into(),
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            is_primary: true,
            scale: 2.0,
        }
    }

    #[test]
    fn display_conversion_preserves_targeting_fields() {
        let source = display();
        validate_display_info(&source).expect("valid display");
        let mut converted = display_info_to_c(&source);

        assert_eq!(
            unsafe { c_to_string(converted.id) }.as_deref(),
            Some("main")
        );
        assert_eq!(converted.bounds.width, 1920.0);
        assert!(converted.is_primary);
        assert_eq!(converted.scale, 2.0);
        unsafe { free_display_info_fields(&mut converted) };
        assert!(converted.id.is_null());
    }

    #[test]
    fn display_validation_rejects_invalid_platform_output() {
        let mut source = display();
        source.scale = f64::NAN;
        assert_eq!(
            validate_display_info(&source)
                .expect_err("invalid scale")
                .code,
            ErrorCode::Internal
        );

        source.scale = 2.0;
        source.bounds.width = -1.0;
        assert_eq!(
            validate_display_info(&source)
                .expect_err("invalid bounds")
                .code,
            ErrorCode::Internal
        );
    }
}
