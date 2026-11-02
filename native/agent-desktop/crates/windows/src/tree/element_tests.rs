use super::*;

#[cfg(not(target_os = "windows"))]
fn canned_element() -> UIAElement {
    UIAElement::from(CannedElement)
}

#[test]
fn a_foreign_payload_never_masquerades_as_a_uia_element() {
    let foreign = NativeHandle::new(String::from("ax-token"));

    let Err(error) = uia_element(&foreign) else {
        panic!("a macOS-shaped payload must be rejected");
    };

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    let details = error.details.expect("rejection carries details");
    assert_eq!(details["platform"], "windows");
    assert_eq!(details["empty"], false);
}

#[test]
fn an_empty_handle_is_rejected_without_a_pointer_cast() {
    let empty = NativeHandle::null();

    let Err(error) = uia_element(&empty) else {
        panic!("an empty handle must be rejected");
    };

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(
        error.details.expect("rejection carries details")["empty"],
        true
    );
}

#[cfg(not(target_os = "windows"))]
#[test]
fn a_wrapper_round_trips_through_a_native_handle() {
    let handle = canned_element().into_native_handle();

    assert!(uia_element(&handle).is_ok());
}

#[cfg(target_os = "windows")]
mod windows_only {
    use super::*;
    use crate::tree::automation::{automation_client, uia_error};

    fn root_element() -> UIAElement {
        crate::tree::fixture::ensure_test_apartment();
        let client = automation_client().expect("a UIA client is available");
        UIAElement::from(
            client
                .get_root_element()
                .map_err(|error| uia_error(&error, "read the desktop root"))
                .expect("the desktop root resolves"),
        )
    }

    #[test]
    fn a_wrapper_round_trips_through_a_native_handle() {
        let element = root_element();
        let handle = element.into_native_handle();

        assert!(uia_element(&handle).is_ok());
    }

    /// The refcount contract is asserted by observation, not by reading the
    /// source: a clone is dropped and the survivor must still answer a live
    /// property read. A double-release would have invalidated the interface.
    #[test]
    fn dropping_a_clone_leaves_the_survivor_usable() {
        let element = root_element();
        let clone = element.clone();

        drop(clone);

        assert!(element.0.get_control_type().is_ok());
    }

    #[test]
    fn dropping_the_original_leaves_the_clone_usable() {
        let element = root_element();
        let clone = element.clone();

        drop(element);

        assert!(clone.0.get_control_type().is_ok());
    }
}
