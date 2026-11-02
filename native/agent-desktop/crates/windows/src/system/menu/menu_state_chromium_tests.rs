//! Source C's composition test: the Chromium DOM-menu arm added after A26-12
//! measured both shipped sources silent under a demonstrably open Chromium
//! context menu (a DOM menu inside the app's own window). The positive side
//! fires only on the real Chromium host the probe stages, so what is driven
//! here is the multi-pid composition against a real window.

#![cfg(target_os = "windows")]

use super::*;
use std::time::Duration;

use crate::system::fixture::test_support::{FIXTURE_APP_NAME_LOCK, settles_to};
use crate::tree::fixture::bootstrap;
use crate::tree::fixture::fixture_menu::MenuFixture;

const STATE_TIMEOUT: Duration = Duration::from_secs(5);

use crate::system::fixture::test_time::deadline;

/// The composition identity IS the invariant: for the same pid,
/// `menus_open_for` must answer exactly what [`menu_is_open`] answers,
/// including the Chromium source the single-pid composition gained. The
/// at-rest state is the one that exercises source C inside the multi-pid path
/// on this box - classic and source B read false, so the shared Chromium arm
/// runs and must stay quiet for the framework-gate reason the arm
/// documents. A staged Chromium DOM menu is not feasible here (no
/// Chromium host is staged in the unit lane), so a firing source C is
/// covered by the single-pid arm's own measurement (A26-12) and by the arm
/// being the same shared function both compositions call.
///
/// An open popup is deliberately not part of this case. Win32 menu mode is
/// cancelled by any activation change on the desktop, so a popup held open
/// across two separate reads can close between them and make the identity
/// fail for a reason that is not the composition's.
#[test]
fn menus_open_for_answers_identically_to_menu_is_open_for_the_fixture_pid() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    let pid = ProcessId::from(fixture.process_id());

    let composed = || {
        menus_open_for(&[pid], deadline(10_000))
            .expect("the multi-pid predicate reads the fixture")
            .get(&pid)
            .copied()
            .expect("the queried pid is in the answer")
    };
    let single =
        || menu_is_open(pid, deadline(10_000)).expect("the single-pid predicate reads the fixture");

    assert!(
        settles_to(STATE_TIMEOUT, false, composed),
        "menus_open_for never settled to closed: at rest every source must stay quiet"
    );
    assert!(
        settles_to(STATE_TIMEOUT, false, single),
        "menu_is_open never settled to closed: at rest every source must stay quiet"
    );
    assert_eq!(
        composed(),
        single(),
        "at rest both compositions probe every source and must agree"
    );
}
