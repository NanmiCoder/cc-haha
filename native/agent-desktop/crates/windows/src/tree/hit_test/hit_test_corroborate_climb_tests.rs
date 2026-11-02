//! What the host-window climb reports when it cannot be completed.
//!
//! Split from `hit_test_corroborate_tests.rs` so that file stays inside the
//! size cap. These cases drive a live fixture and a real walker, which the
//! attribution tests next door deliberately do not.

use crate::tree::automation::{automation_client, root_from_hwnd};
use crate::tree::fixture::HostedFixture;
use crate::tree::walk::walker_fake::deadline;

/// A climb that cannot be completed must not answer `Ok(None)`, because a
/// caller reads that as "this element owns no window" - the ordinary shape
/// for WPF, WinUI and Chromium content - and acts on it. An exhausted
/// budget is the one cause of an incomplete climb that can be staged
/// deterministically; `walker_source_tests` records that a genuine
/// parent-read fault has no deterministic live trigger with this crate's
/// fixture machinery, and the same holds here.
#[test]
fn an_exhausted_budget_reports_an_incomplete_climb_rather_than_a_missing_window() {
    crate::tree::fixture::ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let root = root_from_hwnd(fixture.handle(), deadline()).expect("the fixture window resolves");
    let client = automation_client().expect("a UIA client");
    let walker = client
        .get_raw_view_walker()
        .expect("the raw view walker is available");

    let exhausted = agent_desktop_core::Deadline::after(0).expect("a zero budget");
    let outcome = crate::tree::hit_test::corroborate::first_native_hwnd(&root, &walker, exhausted);

    assert!(
        outcome.is_err(),
        "an exhausted budget must be distinguishable from a completed climb that found \
         no window, or a caller treats a read it never made as a fact about the element"
    );
}

/// The other direction, so the case above is a claim rather than a default:
/// the same element on the same walker with an ample budget completes and
/// resolves the fixture's own window.
#[test]
fn an_ample_budget_completes_the_climb_and_finds_the_fixture_window() {
    crate::tree::fixture::ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let root = root_from_hwnd(fixture.handle(), deadline()).expect("the fixture window resolves");
    let client = automation_client().expect("a UIA client");
    let walker = client
        .get_raw_view_walker()
        .expect("the raw view walker is available");

    let outcome = crate::tree::hit_test::corroborate::first_native_hwnd(&root, &walker, deadline())
        .expect("a live climb with budget to spare must not report incomplete");

    assert!(
        outcome.is_some(),
        "the fixture's own root reports a window handle"
    );
}
