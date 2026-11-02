use super::*;
use crate::commands::session::{self, SessionAction};
use crate::refs::refs_test_support::HomeGuard;

#[test]
fn session_and_overlay_responses_show_portable_activation_guidance() {
    let _guard = HomeGuard::new();
    let started = session::execute(SessionAction::Start {
        name: None,
        no_trace: false,
        screenshots: false,
    })
    .expect("session start");
    let id = started["session_id"].as_str().expect("session id");
    let expected = session::activation_export(id);

    assert_eq!(started["next"], expected);
    assert_eq!(
        started["activation"]["environment"],
        "AGENT_DESKTOP_SESSION"
    );
    assert_eq!(started["activation"]["value"], id);

    let enabled = execute(
        id,
        CursorOverlayAction::Enable(Box::new(CursorOverlayConfig::enabled(None, 6).unwrap())),
    )
    .expect("cursor overlay enable");

    assert_eq!(enabled["next"], expected);
    assert_eq!(enabled["activation"], started["activation"]);
}
