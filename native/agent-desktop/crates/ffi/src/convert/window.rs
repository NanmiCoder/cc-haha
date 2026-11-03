use crate::convert::rect::rect_to_c;
use crate::convert::string::{free_c_string, opt_string_to_c, string_to_c_lossy};
use crate::types::{AdExactWindowInfo, AdRect, AdWindowInfo};
use agent_desktop_core::{AdapterError, ErrorCode, WindowInfo};
use std::os::raw::c_char;
use std::ptr;

pub(crate) fn window_info_to_c(w: &WindowInfo) -> AdWindowInfo {
    let (bounds, has_bounds) = match &w.bounds {
        Some(r) => (rect_to_c(r), true),
        None => (
            AdRect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
            false,
        ),
    };
    AdWindowInfo {
        id: string_to_c_lossy(&w.id),
        title: string_to_c_lossy(&w.title),
        app_name: string_to_c_lossy(&w.app),
        pid: w.pid.get(),
        bounds,
        has_bounds,
        is_focused: w.state.is_focused,
    }
}

pub(crate) fn exact_window_info_to_c(w: &WindowInfo) -> AdExactWindowInfo {
    AdExactWindowInfo {
        version: crate::types::exact_window_info::AD_EXACT_WINDOW_INFO_VERSION,
        size: crate::types::exact_window_info::AD_EXACT_WINDOW_INFO_SIZE as u32,
        window: window_info_to_c(w),
        process_instance: opt_string_to_c(w.process_instance.as_deref()),
        accessible: w.state.accessible,
    }
}

pub(crate) fn validate_exact_window_info(window: &WindowInfo) -> Result<(), AdapterError> {
    if window.pid.get() == 0 {
        return Err(AdapterError::new(
            ErrorCode::Internal,
            "Exact window pid is not positive",
        ));
    }
    if window.id.is_empty() {
        return Err(AdapterError::new(
            ErrorCode::Internal,
            "Exact window id is empty",
        ));
    }
    let process_instance = window
        .process_instance
        .as_deref()
        .filter(|identity| !identity.is_empty())
        .ok_or_else(|| {
            AdapterError::new(
                ErrorCode::Internal,
                "Exact window lacks process-generation evidence",
            )
        })?;
    crate::resource::validate_output_string(&window.id, "Window id")?;
    crate::resource::validate_output_string(&window.title, "Window title")?;
    crate::resource::validate_output_string(&window.app, "Window app")?;
    crate::resource::validate_output_string(process_instance, "Window process instance")?;
    if let Some(bounds) = window.bounds {
        bounds.validate().map_err(|error| {
            AdapterError::new(
                ErrorCode::Internal,
                format!("Exact window has invalid bounds: {}", error.message),
            )
        })?;
    }
    Ok(())
}

pub(crate) unsafe fn free_window_info_fields(w: &mut AdWindowInfo) {
    unsafe {
        free_c_string(w.id as *mut c_char);
        free_c_string(w.title as *mut c_char);
        free_c_string(w.app_name as *mut c_char);
        w.id = ptr::null();
        w.title = ptr::null();
        w.app_name = ptr::null();
    }
}

pub(crate) unsafe fn free_exact_window_info_fields(w: &mut AdExactWindowInfo) {
    unsafe {
        free_window_info_fields(&mut w.window);
        free_c_string(w.process_instance as *mut c_char);
        w.process_instance = ptr::null();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::string::c_to_string;
    use agent_desktop_core::Rect;

    #[test]
    fn test_window_info_roundtrip() {
        let w = WindowInfo {
            id: "w-123".into(),
            title: "Documents".into(),
            app: "Finder".into(),
            pid: agent_desktop_core::ProcessId::new(42),
            process_instance: Some("42:100".into()),
            bounds: Some(Rect {
                x: 10.0,
                y: 20.0,
                width: 800.0,
                height: 600.0,
            }),
            state: agent_desktop_core::WindowState {
                is_focused: true,
                accessible: true,
                minimized: None,
                visible: None,
            },
        };
        let c = window_info_to_c(&w);
        assert_eq!(unsafe { c_to_string(c.id) }.as_deref(), Some("w-123"));
        assert_eq!(
            unsafe { c_to_string(c.title) }.as_deref(),
            Some("Documents")
        );
        assert_eq!(
            unsafe { c_to_string(c.app_name) }.as_deref(),
            Some("Finder")
        );
        assert_eq!(c.pid, 42);
        assert!(c.has_bounds);
        assert_eq!(c.bounds.x, 10.0);
        assert!(c.is_focused);
        let mut c = c;
        unsafe { free_window_info_fields(&mut c) };
    }

    #[test]
    fn window_info_to_c_bounds_none_sets_false_flag_and_zeroed_rect() {
        let w = WindowInfo {
            id: "w-7".into(),
            title: "Untitled".into(),
            app: "TextEdit".into(),
            pid: agent_desktop_core::ProcessId::new(99),
            process_instance: Some("99:200".into()),
            bounds: None,
            state: agent_desktop_core::WindowState::default(),
        };
        let c = window_info_to_c(&w);
        assert!(
            !c.has_bounds,
            "has_bounds must be false when bounds is None"
        );
        assert!(!c.is_focused);
        assert_eq!(c.bounds.x, 0.0);
        assert_eq!(c.bounds.y, 0.0);
        assert_eq!(c.bounds.width, 0.0);
        assert_eq!(c.bounds.height, 0.0);
        let mut c = c;
        unsafe { free_window_info_fields(&mut c) };
    }

    #[test]
    fn exact_window_info_carries_owned_process_generation() {
        let window = WindowInfo {
            id: "w-9".into(),
            title: "Main".into(),
            app: "Fixture".into(),
            pid: agent_desktop_core::ProcessId::new(9),
            process_instance: Some("9:123".into()),
            bounds: None,
            state: agent_desktop_core::WindowState::default(),
        };
        let mut exact = exact_window_info_to_c(&window);

        assert_eq!(
            unsafe { c_to_string(exact.process_instance) }.as_deref(),
            Some("9:123")
        );
        assert!(exact.accessible);
        unsafe { free_exact_window_info_fields(&mut exact) };
        assert!(exact.process_instance.is_null());
    }

    #[test]
    fn exact_window_validation_rejects_missing_process_generation() {
        let window = WindowInfo {
            id: "w-9".into(),
            title: "Main".into(),
            app: "Fixture".into(),
            pid: agent_desktop_core::ProcessId::new(9),
            process_instance: None,
            bounds: None,
            state: agent_desktop_core::WindowState::default(),
        };

        let error = validate_exact_window_info(&window).unwrap_err();

        assert_eq!(error.code, ErrorCode::Internal);
        assert!(error.message.contains("process-generation"));
    }
}
