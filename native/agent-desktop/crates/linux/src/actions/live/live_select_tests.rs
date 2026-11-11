use agent_desktop_core::{DeliverySemantics, ErrorCode};

use super::live_click_tests::{act, find, open};
use crate::actions::select::select;
use crate::tree::vocabulary::role_numbers::LIST;

#[test]
#[ignore = "live: needs the AT-SPI session, GNOME Settings and the write engine"]
fn a_value_with_no_match_in_the_sidebar_is_not_found_and_writes_nothing() {
    let session = open("gnome-control-center", &[]).expect("settings opens");
    let list = find(&session, |view| view.role() == Some(LIST)).expect("a list");
    let error = act(&session, &list, |target| {
        select(target, "No Such Panel 7f3a", None)
    })
    .expect_err("no match");
    assert_eq!(error.code, ErrorCode::ElementNotFound);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}
