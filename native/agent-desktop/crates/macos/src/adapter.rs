pub struct MacOSAdapter;

impl MacOSAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MacOSAdapter {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn ax_element(
    handle: &agent_desktop_core::NativeHandle,
) -> Result<&crate::tree::AXElement, agent_desktop_core::AdapterError> {
    handle
        .downcast_ref::<crate::tree::AXElement>()
        .ok_or_else(|| {
            agent_desktop_core::AdapterError::new(
                agent_desktop_core::ErrorCode::InvalidArgs,
                "Native handle does not contain a macOS accessibility element",
            )
            .with_details(serde_json::json!({
                "kind": "invalid_native_handle",
                "platform": "macos",
                "empty": handle.is_null()
            }))
        })
}

#[cfg(test)]
mod tests {
    use super::ax_element;
    use agent_desktop_core::{ErrorCode, NativeHandle};

    #[test]
    fn empty_handle_is_rejected_without_a_pointer_cast() {
        let empty = NativeHandle::null();
        let Err(error) = ax_element(&empty) else {
            panic!("empty handle must be rejected");
        };

        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(error.details.unwrap()["kind"], "invalid_native_handle");
    }

    #[test]
    fn wrong_platform_payload_is_rejected_without_a_pointer_cast() {
        let wrong = NativeHandle::new(String::from("uia-token"));
        let Err(error) = ax_element(&wrong) else {
            panic!("wrong payload type must be rejected");
        };

        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(error.details.unwrap()["platform"], "macos");
    }
}
