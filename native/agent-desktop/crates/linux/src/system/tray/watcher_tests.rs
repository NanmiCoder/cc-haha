use agent_desktop_core::{DeliverySemantics, ErrorCode};

use super::require_owner;

#[test]
fn a_watcher_that_vanishes_during_the_read_is_not_treated_as_an_empty_list() {
    let error = require_owner(None).expect_err("watcher is absent");

    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(error.details.expect("watcher state")["watcher"], "absent");
    assert!(
        error
            .suggestion
            .as_deref()
            .unwrap_or_default()
            .contains("org.kde.StatusNotifierWatcher")
    );
}
