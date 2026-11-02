use agent_desktop_core::{AdapterError, Deadline, ErrorCode, Point};

use crate::tree::AXElement;

pub(crate) struct PreparedPhysicalTarget {
    identity: crate::system::process::process_identity::ProcessIdentity,
    window: AXElement,
}

impl PreparedPhysicalTarget {
    pub(crate) fn prepare(element: &AXElement, deadline: Deadline) -> Result<Self, AdapterError> {
        let pid =
            crate::system::app::app_ops::pid_from_element(element, deadline).ok_or_else(|| {
                AdapterError::new(
                    ErrorCode::StaleRef,
                    "Physical input target no longer has an owning application",
                )
            })?;
        let identity = crate::system::process::process_identity::ProcessIdentity::capture(pid)?
            .ok_or_else(|| {
                AdapterError::new(
                    ErrorCode::StaleRef,
                    "Physical input target process exited before input preparation",
                )
            })?;
        let window = target_window(element, deadline)?;
        crate::system::focus::verify_app_focused(pid, deadline)?;
        crate::system::focus::verify_window_main(&window, deadline)?;
        Ok(Self { identity, window })
    }

    pub(crate) fn verify_pointer(
        &self,
        element: &AXElement,
        point: &Point,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        crate::system::focus::verify_app_focused(self.identity.pid(), deadline)?;
        crate::system::focus::verify_window_main(&self.window, deadline)?;
        match crate::tree::hit_test::hit_test_ax_element(element, point.clone(), deadline)? {
            agent_desktop_core::adapter::hit_test::HitTestResult::ReachesTarget => {}
            agent_desktop_core::adapter::hit_test::HitTestResult::InterceptedBy {
                role,
                name,
                ..
            } => {
                return Err(AdapterError::new(
                    ErrorCode::ActionFailed,
                    "Physical input point is intercepted by another accessibility element",
                )
                .with_details(serde_json::json!({
                    "physical_delivery_started": false,
                    "occluder_role": role,
                    "occluder_name": name,
                })));
            }
            agent_desktop_core::adapter::hit_test::HitTestResult::Unknown => {
                return Err(AdapterError::new(
                    ErrorCode::ActionFailed,
                    "Physical input target could not be proven at the final input point",
                )
                .with_details(serde_json::json!({ "physical_delivery_started": false })));
            }
        }
        if !self.identity.still_matches()? {
            return Err(AdapterError::new(
                ErrorCode::StaleRef,
                "Physical input target process instance changed at input delivery",
            )
            .with_details(serde_json::json!({ "physical_delivery_started": false })));
        }
        Ok(())
    }
}

fn target_window(element: &AXElement, deadline: Deadline) -> Result<AXElement, AdapterError> {
    crate::tree::properties::attributes::set_messaging_timeout(element, deadline)?;
    let result = crate::tree::properties::attributes::copy_element_attr_result(
        element, "AXWindow", deadline,
    );
    if deadline.is_expired() {
        return Err(deadline.timeout_error());
    }
    match result {
        Ok(Some(window)) => Ok(window),
        Ok(None) => Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "Physical input target has no verified owning window",
        )
        .with_details(serde_json::json!({ "physical_delivery_started": false }))),
        Err(error) => Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "Could not verify the physical input target window",
        )
        .with_details(serde_json::json!({
            "ax_error": error,
            "physical_delivery_started": false,
        }))),
    }
}
