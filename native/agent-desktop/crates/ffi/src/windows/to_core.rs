use crate::convert::string::{optional_adapter_string, required_adapter_string};
use crate::types::{AdExactWindowInfo, AdWindowInfo};
use agent_desktop_core::{AdapterError, Rect, WindowInfo};

pub(crate) fn ad_exact_window_to_core(
    exact: &AdExactWindowInfo,
) -> Result<WindowInfo, AdapterError> {
    if exact.version != crate::types::exact_window_info::AD_EXACT_WINDOW_INFO_VERSION
        || exact.size as usize != crate::types::exact_window_info::AD_EXACT_WINDOW_INFO_SIZE
    {
        return Err(AdapterError::new(
            agent_desktop_core::ErrorCode::InvalidArgs,
            "AdExactWindowInfo version or size does not match this library",
        ));
    }
    let process_instance = required_adapter_string(exact.process_instance, "process_instance")?;
    if process_instance.is_empty() {
        return Err(AdapterError::new(
            agent_desktop_core::ErrorCode::InvalidArgs,
            "process_instance is empty",
        ));
    }
    decode_window(&exact.window, process_instance, exact.accessible)
}

fn decode_window(
    w: &AdWindowInfo,
    process_instance: String,
    accessible: bool,
) -> Result<WindowInfo, AdapterError> {
    if w.pid == 0 {
        return Err(AdapterError::new(
            agent_desktop_core::ErrorCode::InvalidArgs,
            "window pid must be positive",
        ));
    }
    let id = required_adapter_string(w.id, "window id")?;
    if id.is_empty() {
        return Err(AdapterError::new(
            agent_desktop_core::ErrorCode::InvalidArgs,
            "window id is empty",
        ));
    }
    let title = required_adapter_string(w.title, "window title")?;
    let app = optional_adapter_string(w.app_name, "window app_name")?.unwrap_or_default();
    let bounds = if w.has_bounds {
        let bounds = Rect {
            x: w.bounds.x,
            y: w.bounds.y,
            width: w.bounds.width,
            height: w.bounds.height,
        };
        bounds.validate()?;
        Some(bounds)
    } else {
        None
    };
    Ok(WindowInfo {
        id,
        title,
        app,
        pid: agent_desktop_core::ProcessId::new(w.pid),
        process_instance: Some(process_instance),
        bounds,
        state: agent_desktop_core::WindowState {
            is_focused: w.is_focused,
            accessible,
            minimized: None,
            visible: None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::string::AD_MAX_STRING_BYTES;
    use crate::types::AdRect;
    use agent_desktop_core::ErrorCode;
    use std::ffi::CString;

    #[test]
    fn window_app_name_rejects_oversized_string() {
        let id = CString::new("w-1").unwrap();
        let title = CString::new("Main").unwrap();
        let mut app = vec![b'a'; AD_MAX_STRING_BYTES + 1];
        app.push(0);
        let win = window(id.as_ptr(), title.as_ptr(), app.as_ptr().cast());

        let err = ad_exact_window_to_core(&win).unwrap_err();

        assert_eq!(err.code, ErrorCode::InvalidArgs);
        assert!(err.message.contains("window app_name exceeds"));
    }

    #[test]
    fn window_app_name_rejects_invalid_utf8() {
        let id = CString::new("w-1").unwrap();
        let title = CString::new("Main").unwrap();
        let app = [0xff_u8, 0x00];
        let win = window(id.as_ptr(), title.as_ptr(), app.as_ptr().cast());

        let err = ad_exact_window_to_core(&win).unwrap_err();

        assert_eq!(err.code, ErrorCode::InvalidArgs);
        assert!(err.message.contains("window app_name is not valid UTF-8"));
    }

    #[test]
    fn exact_window_rejects_unknown_layout_version() {
        let mut exact = unsafe { std::mem::zeroed::<AdExactWindowInfo>() };
        exact.version = u32::MAX;
        exact.size = crate::types::exact_window_info::AD_EXACT_WINDOW_INFO_SIZE as u32;

        let error = ad_exact_window_to_core(&exact).unwrap_err();

        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert!(error.message.contains("version or size"));
    }

    #[test]
    fn exact_window_rejects_an_empty_window_id() {
        let id = CString::new("").unwrap();
        let title = CString::new("Main").unwrap();
        let exact = window(id.as_ptr(), title.as_ptr(), std::ptr::null());

        let error = ad_exact_window_to_core(&exact).unwrap_err();

        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert!(error.message.contains("window id is empty"));
    }

    #[test]
    fn exact_window_preserves_accessibility() {
        let id = CString::new("w-1").unwrap();
        let title = CString::new("Main").unwrap();
        let mut exact = window(id.as_ptr(), title.as_ptr(), std::ptr::null());
        exact.accessible = false;

        let decoded = ad_exact_window_to_core(&exact).unwrap();

        assert!(!decoded.state.accessible);
    }

    fn window(
        id: *const std::os::raw::c_char,
        title: *const std::os::raw::c_char,
        app_name: *const std::os::raw::c_char,
    ) -> AdExactWindowInfo {
        AdExactWindowInfo {
            version: crate::types::exact_window_info::AD_EXACT_WINDOW_INFO_VERSION,
            size: crate::types::exact_window_info::AD_EXACT_WINDOW_INFO_SIZE as u32,
            window: AdWindowInfo {
                id,
                title,
                app_name,
                pid: 7,
                bounds: AdRect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 0.0,
                },
                has_bounds: false,
                is_focused: false,
            },
            process_instance: c"7:100".as_ptr(),
            accessible: true,
        }
    }
}
