use super::*;
use crate::system::display::display_cause::Cause;
use crate::system::display::display_unavailable::Unavailable;

fn unavailable(cause: Cause, detail: &str) -> DisplayServer {
    DisplayServer::Unavailable(Unavailable {
        cause,
        detail: detail.to_owned(),
    })
}

fn reason_of(server: DisplayServer) -> String {
    let error = resolve(server).expect_err("an unavailable server has no route");
    error
        .details
        .as_ref()
        .and_then(|details| details.get("display_unavailable"))
        .and_then(|reason| reason.as_str())
        .map(str::to_owned)
        .expect("the refusal names why the display is unavailable")
}

#[test]
fn an_x11_answer_selects_the_x11_route_with_its_display() {
    assert_eq!(
        resolve(DisplayServer::X11(":7".into())).expect("x11 routes"),
        Route::X11(":7".into())
    );
}

#[test]
fn a_wayland_answer_selects_the_wayland_route() {
    assert_eq!(
        resolve(DisplayServer::Wayland).expect("wayland routes"),
        Route::Wayland
    );
}

#[test]
fn a_missing_server_and_a_refusing_one_give_different_reasons() {
    let missing = reason_of(unavailable(Cause::Missing, "DISPLAY=:9 is gone"));
    let refused = reason_of(unavailable(Cause::Refused, "DISPLAY=:9 refused"));
    assert_eq!(missing, "missing");
    assert_eq!(refused, "refused");
}

#[test]
fn no_configured_display_names_both_variables() {
    let error = resolve(unavailable(Cause::NotConfigured, "")).expect_err("no route");
    let suggestion = error.suggestion.expect("the refusal carries a suggestion");
    assert!(suggestion.contains("DISPLAY"), "{suggestion}");
    assert!(suggestion.contains("WAYLAND_DISPLAY"), "{suggestion}");
}
