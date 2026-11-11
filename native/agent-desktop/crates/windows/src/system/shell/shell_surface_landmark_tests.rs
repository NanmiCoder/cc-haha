//! The landmark search's failure classification, pinned separately from the
//! live resolver tests because the fault side cannot be staged on a real
//! surface: a transient transport failure under a presented Action Center is
//! exactly the event a test cannot schedule, and it is the one that turns
//! "search failed" into "surface closed" if the classification flattens.

#![cfg(target_os = "windows")]

use super::landmark_search_answer;
use crate::system::runtime::hresult::{UIA_E_ELEMENTNOTAVAILABLE, UIA_E_TIMEOUT};
use crate::tree::automation::{ERR_NOTFOUND, ERR_TIMEOUT};
use agent_desktop_core::ErrorCode;
use uiautomation::Error;

const CONTEXT: &str = "search an immersive surface candidate for its landmark";

#[test]
fn a_found_element_and_a_raced_subtree_are_the_two_absence_shaped_answers() {
    crate::tree::fixture::bootstrap();
    assert!(landmark_search_answer(Ok(found_element()), CONTEXT).expect("a hit reads as presence"));
    assert!(
        !landmark_search_answer(Err(Error::new(ERR_NOTFOUND, "test")), CONTEXT)
            .expect("a raced-away subtree is absence, not a fault")
    );
    assert!(
        !landmark_search_answer(
            Err(Error::from(windows::core::HRESULT(
                UIA_E_ELEMENTNOTAVAILABLE
            ))),
            CONTEXT
        )
        .expect("a vanished element is absence, not a fault")
    );
}

/// The flattened classification read every search fault as absence, and a
/// close built on that answer skipped the dismissal on a presented surface.
/// Each fault here must surface instead, narrowed onto the read paths'
/// closed code set.
#[test]
fn a_search_that_could_not_run_surfaces_instead_of_reading_the_surface_closed() {
    for error in [Error::new(ERR_TIMEOUT, "test"), hresult(UIA_E_TIMEOUT)] {
        let surfaced = landmark_search_answer(Err(error), CONTEXT)
            .expect_err("a fault must surface, never read as landmark absence");
        assert!(
            matches!(
                surfaced.code,
                ErrorCode::Timeout | ErrorCode::AppUnresponsive
            ),
            "the fault surfaces inside the permitted read-path set, got {:?}",
            surfaced.code
        );
    }
}

fn hresult(code: i32) -> Error {
    Error::from(windows::core::HRESULT(code))
}

fn found_element() -> uiautomation::UIElement {
    let client = crate::tree::automation::automation_client().expect("the client builds");
    client
        .get_root_element()
        .expect("the desktop root resolves for the presence-shaped answer")
}
