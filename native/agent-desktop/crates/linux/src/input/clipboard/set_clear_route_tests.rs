use agent_desktop_core::{
    ClipboardContent, ClipboardFormat, Deadline, DeliverySemantics, ErrorCode,
};

use super::*;
use crate::system::display::display_cause::Cause;
use crate::system::display::display_unavailable::Unavailable;

fn no_display() -> DisplayServer {
    DisplayServer::Unavailable(Unavailable {
        cause: Cause::NotConfigured,
        detail: "no display variable is set".to_owned(),
    })
}

fn lease() -> InteractionLease {
    InteractionLease::guarded(Deadline::after(1_000).expect("a deadline"), ()).expect("a lease")
}

fn assert_refused_before_any_change(error: AdapterError) {
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn a_read_with_no_usable_display_is_not_delivered() {
    let deadline = Deadline::after(1_000).expect("a deadline");
    let error = get_from(
        no_display(),
        &ClipboardTools::default(),
        ClipboardFormat::Text,
        deadline,
    )
    .expect_err("refused");
    assert_refused_before_any_change(error);
}

#[test]
fn a_set_with_no_usable_display_is_not_delivered() {
    let content = ClipboardContent::Text("hello".to_owned());
    let error = set_from(no_display(), &ClipboardTools::default(), &content, &lease())
        .expect_err("refused");
    assert_refused_before_any_change(error);
}

#[test]
fn a_clear_with_no_usable_display_is_not_delivered() {
    let error =
        clear_from(no_display(), &ClipboardTools::default(), &lease()).expect_err("refused");
    assert_refused_before_any_change(error);
}
