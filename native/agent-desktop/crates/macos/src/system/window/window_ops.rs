use agent_desktop_core::{AdapterError, Deadline, ErrorCode, WindowInfo, WindowOp};

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use accessibility_sys::{
        kAXPositionAttribute, kAXSizeAttribute, kAXValueTypeCGPoint, kAXValueTypeCGSize,
    };
    use core_foundation::{
        base::{CFType, TCFType},
        boolean::CFBoolean,
        string::CFString,
    };
    use core_graphics::geometry::{CGPoint, CGSize};
    use std::ffi::c_void;

    unsafe extern "C" {
        fn AXValueCreate(value_type: u32, value_ptr: *const c_void) -> *mut c_void;
    }

    pub fn execute(win: &WindowInfo, op: WindowOp, deadline: Deadline) -> Result<(), AdapterError> {
        tracing::debug!(operation = ?op, "system: window operation");
        deadline.ensure_remaining()?;
        let win_el = crate::system::window::window_resolve::window_element_for_info(win, deadline)?;
        match op {
            WindowOp::Resize { width, height } => set_size(&win_el, width, height, deadline),
            WindowOp::Move { x, y } => set_position(&win_el, x, y, deadline),
            WindowOp::Minimize => set_minimized(&win_el, true, deadline),
            WindowOp::Maximize => maximize_to_main_display(&win_el, deadline),
            WindowOp::Restore => set_minimized(&win_el, false, deadline),
        }
    }

    fn maximize_to_main_display(
        el: &crate::tree::AXElement,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        let current = crate::tree::element_bounds::read_bounds_with_deadline(
            el,
            std::time::Instant::now()
                .checked_add(deadline.remaining())
                .ok_or_else(|| AdapterError::internal("Window deadline is out of range"))?,
        )?;
        let work_area = crate::system::display_work_area::for_window(current, deadline)?;
        set_position(el, work_area.x, work_area.y, deadline)?;
        set_size(el, work_area.width, work_area.height, deadline).map_err(|error| {
            crate::actions::DeliveryTracker::from_delivered_units(1).annotate(error)
        })
    }

    fn set_size(
        el: &crate::tree::AXElement,
        width: f64,
        height: f64,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        validate_size(width, height)?;
        prepare(el, deadline)?;
        let size = CGSize::new(width, height);
        let ax_value =
            unsafe { AXValueCreate(kAXValueTypeCGSize, &size as *const _ as *const c_void) };
        if ax_value.is_null() {
            return Err(AdapterError::internal("Failed to create AXValue for size"));
        }
        let cf_attr = CFString::new(kAXSizeAttribute);
        let ax_value = unsafe { CFType::wrap_under_create_rule(ax_value as _) };
        let err = crate::tree::properties::ax_ipc::set_attribute_value(
            el,
            cf_attr.as_concrete_TypeRef(),
            ax_value.as_CFTypeRef(),
            deadline,
        )?;
        finish(el, err, "resize window", deadline)?;
        crate::system::window::window_postcondition::wait_for_geometry(
            el,
            agent_desktop_core::Rect {
                x: 0.0,
                y: 0.0,
                width,
                height,
            },
            false,
            deadline,
        )
    }

    fn set_position(
        el: &crate::tree::AXElement,
        x: f64,
        y: f64,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        validate_position(x, y)?;
        prepare(el, deadline)?;
        let point = CGPoint::new(x, y);
        let ax_value =
            unsafe { AXValueCreate(kAXValueTypeCGPoint, &point as *const _ as *const c_void) };
        if ax_value.is_null() {
            return Err(AdapterError::internal(
                "Failed to create AXValue for position",
            ));
        }
        let cf_attr = CFString::new(kAXPositionAttribute);
        let ax_value = unsafe { CFType::wrap_under_create_rule(ax_value as _) };
        let err = crate::tree::properties::ax_ipc::set_attribute_value(
            el,
            cf_attr.as_concrete_TypeRef(),
            ax_value.as_CFTypeRef(),
            deadline,
        )?;
        finish(el, err, "move window", deadline)?;
        crate::system::window::window_postcondition::wait_for_geometry(
            el,
            agent_desktop_core::Rect {
                x,
                y,
                width: 0.0,
                height: 0.0,
            },
            true,
            deadline,
        )
    }

    fn set_minimized(
        el: &crate::tree::AXElement,
        minimized: bool,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        prepare(el, deadline)?;
        let cf_attr = CFString::new("AXMinimized");
        let val = if minimized {
            CFBoolean::true_value()
        } else {
            CFBoolean::false_value()
        };
        let err = crate::tree::properties::ax_ipc::set_attribute_value(
            el,
            cf_attr.as_concrete_TypeRef(),
            val.as_CFTypeRef(),
            deadline,
        )?;
        finish(
            el,
            err,
            if minimized {
                "minimize window"
            } else {
                "restore window"
            },
            deadline,
        )?;
        crate::system::window::window_postcondition::wait_for_minimized(el, minimized, deadline)
    }

    fn validate_size(width: f64, height: f64) -> Result<(), AdapterError> {
        const MAX_DIMENSION: f64 = 1_000_000.0;
        if !width.is_finite()
            || !height.is_finite()
            || width <= 0.0
            || height <= 0.0
            || width > MAX_DIMENSION
            || height > MAX_DIMENSION
        {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                "Window width and height must be finite, positive, and at most 1000000",
            ));
        }
        Ok(())
    }

    fn validate_position(x: f64, y: f64) -> Result<(), AdapterError> {
        const MAX_COORDINATE: f64 = 1_000_000.0;
        if !x.is_finite() || !y.is_finite() || x.abs() > MAX_COORDINATE || y.abs() > MAX_COORDINATE
        {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                "Window coordinates must be finite and within -1000000..=1000000",
            ));
        }
        Ok(())
    }

    fn prepare(el: &crate::tree::AXElement, deadline: Deadline) -> Result<(), AdapterError> {
        crate::tree::properties::attributes::set_messaging_timeout(el, deadline)
    }

    fn finish(
        element: &crate::tree::AXElement,
        error: i32,
        operation: &str,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        crate::system::focus::finish_mutation(element, error, operation, deadline)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn geometry_rejects_non_finite_and_extreme_values() {
            assert!(validate_size(f64::NAN, 100.0).is_err());
            assert!(validate_size(100.0, f64::INFINITY).is_err());
            assert!(validate_size(0.0, 100.0).is_err());
            assert!(validate_position(f64::NEG_INFINITY, 0.0).is_err());
            assert!(validate_position(1_000_001.0, 0.0).is_err());
        }

        #[test]
        fn geometry_accepts_negative_screen_coordinates() {
            assert!(validate_position(-1920.0, 0.0).is_ok());
            assert!(validate_size(1920.0, 1080.0).is_ok());
        }
    }
}

#[cfg(target_os = "macos")]
mod raise {
    use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics};
    use core_foundation::{base::TCFType, boolean::CFBoolean, string::CFString};

    pub(crate) fn raise_window(
        window: &crate::tree::AXElement,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        prepare(window, deadline)?;
        let raise = CFString::new("AXRaise");
        let raise_err = crate::tree::properties::ax_ipc::perform_action(
            window,
            raise.as_concrete_TypeRef(),
            deadline,
        )?;
        let outcome = crate::actions::ax_mutation::classify_result(
            window,
            "AXRaise",
            crate::actions::ax_mutation::PERFORM_API,
            raise_err,
        );
        if !needs_main_fallback(outcome, || {
            crate::system::focus::wait_until_main(window, deadline)
        })? {
            return Ok(());
        }
        prepare(window, deadline)?;
        let main_attr = CFString::new("AXMain");
        let ax_err = crate::tree::properties::ax_ipc::set_attribute_value(
            window,
            main_attr.as_concrete_TypeRef(),
            CFBoolean::true_value().as_CFTypeRef(),
            deadline,
        )?;
        crate::system::focus::finish_mutation(window, ax_err, "raise window", deadline)?;
        crate::system::focus::wait_until_main(window, deadline).map_err(after_delivery)
    }

    fn needs_main_fallback(
        outcome: Result<bool, AdapterError>,
        verify: impl FnOnce() -> Result<(), AdapterError>,
    ) -> Result<bool, AdapterError> {
        match outcome {
            Ok(false) => Ok(true),
            Ok(true) => verify().map(|()| false).map_err(after_delivery),
            Err(error) if error.disposition == DeliverySemantics::uncertain() => {
                verify().map(|()| false).map_err(|_| error)
            }
            Err(error) => Err(error),
        }
    }

    fn prepare(window: &crate::tree::AXElement, deadline: Deadline) -> Result<(), AdapterError> {
        crate::tree::properties::attributes::set_messaging_timeout(window, deadline)
    }

    fn after_delivery(error: AdapterError) -> AdapterError {
        error.with_disposition(DeliverySemantics::delivered_unverified())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn uncertain_raise_requires_main_window_evidence_and_never_falls_back() {
            let error = AdapterError::timeout("raise uncertain")
                .with_disposition(DeliverySemantics::uncertain());
            assert!(!needs_main_fallback(Err(error.clone()), || Ok(())).unwrap());
            let failure =
                needs_main_fallback(Err(error), || Err(AdapterError::timeout("readback")))
                    .unwrap_err();
            assert_eq!(failure.message, "raise uncertain");
            assert_eq!(failure.disposition, DeliverySemantics::uncertain());
        }

        #[test]
        fn only_unsupported_raise_authorizes_the_main_attribute_fallback() {
            assert!(needs_main_fallback(Ok(false), || panic!("no read needed")).unwrap());
            assert!(!needs_main_fallback(Ok(true), || Ok(())).unwrap());
            let error = needs_main_fallback(Err(AdapterError::permission_denied()), || {
                panic!("no probe after permission denial")
            })
            .unwrap_err();
            assert_eq!(error.code, agent_desktop_core::ErrorCode::PermDenied);
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) use raise::raise_window;

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    pub fn execute(
        _win: &WindowInfo,
        _op: WindowOp,
        _deadline: Deadline,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("window_op"))
    }
}

pub(crate) use imp::execute;
