use super::*;
use agent_desktop_core::Rect;

use crate::system::fixture::test_time::deadline;

#[test]
fn the_filter_excludes_invisible_zero_sized_cloaked_and_tool_windows() {
    let sample = EnumeratedWindow {
        handle: std::ptr::null_mut(),
        visible: true,
        iconic: false,
        cloaked: false,
        tool: false,
        rect: Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 40.0,
        },
    };
    assert!(passes_filter(&sample));

    assert!(!passes_filter(&EnumeratedWindow {
        visible: false,
        ..sample
    }));
    assert!(!passes_filter(&EnumeratedWindow {
        rect: Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        },
        ..sample
    }));
    assert!(!passes_filter(&EnumeratedWindow {
        cloaked: true,
        ..sample
    }));
    assert!(!passes_filter(&EnumeratedWindow {
        tool: true,
        ..sample
    }));
}

#[test]
fn the_window_id_is_the_hwnd_with_the_w_prefix() {
    let parsed = parse_handle("w-1000");
    assert_eq!(parsed as usize, 1000);
}

#[cfg(target_os = "windows")]
mod windows_only {
    use super::*;

    /// How many times a live listing is re-attempted before its
    /// mid-walk identity refusal is accepted as the desktop's answer.
    use crate::system::window::listing_retry::LISTING_RACE_ATTEMPTS;

    /// The live half of the census: a hosted fixture window appears in
    /// `list_windows` with a parseable id, the fixture's pid, and a
    /// non-empty process token. Rule-shaped: no window count or desktop
    /// shape is asserted.
    ///
    /// The inventory refuses the whole listing when any window's owning
    /// process changes mid-walk, and a suite that spawns and terminates
    /// real processes makes that transient refusal reachable here. It is
    /// retried rather than tolerated on the first miss, so the identity
    /// assertions below still run on any desktop where the race is not
    /// permanent; only a refusal that survives every attempt is accepted,
    /// and then only as the exact refusal the listing exists to report.
    /// `list_windows_live` now retries this same race internally, so this
    /// loop's own retries are expected to succeed on the first pass in the
    /// common case - an observation, not a timing fact this test asserts.
    #[test]
    fn the_fixture_window_appears_in_list_windows_with_identity() {
        crate::tree::fixture::ensure_test_apartment();
        let fixture = crate::tree::fixture::HostedFixture::spawn().expect("a fixture host starts");

        let mut listed = None;
        let mut last_refusal = None;
        for _ in 0..LISTING_RACE_ATTEMPTS {
            match list_windows_live(&WindowFilter::default(), deadline(10_000)) {
                Ok(windows) => {
                    listed = Some(windows);
                    break;
                }
                Err(error) => {
                    assert_eq!(
                        error.code,
                        agent_desktop_core::ErrorCode::WindowNotFound,
                        "the only refusal this inventory may report is the mid-listing identity race"
                    );
                    last_refusal = Some(error);
                }
            }
        }
        let Some(windows) = listed else {
            let refusal = last_refusal.expect(
                "the loop ran at least once, so an exhausted retry budget always carries a refusal",
            );
            assert_eq!(
                refusal.code,
                agent_desktop_core::ErrorCode::WindowNotFound,
                "a permanently-refusing inventory must still be refusing the documented \
                 mid-listing race, not failing some other way"
            );
            if let Some(kind) = refusal
                .details
                .as_ref()
                .and_then(|details| details.get("kind"))
            {
                assert!(
                    kind.is_string(),
                    "a details.kind on the exhausted refusal must be a string, got {kind:?}"
                );
            }
            return;
        };

        let matching = windows
            .iter()
            .find(|window| window.pid == agent_desktop_core::ProcessId::from(fixture.process_id()));
        assert!(
            matching.is_some(),
            "the fixture's process must appear among listed windows; found {} windows",
            windows.len()
        );
        let window = matching.expect("just checked");

        assert!(
            window
                .process_instance
                .as_deref()
                .is_some_and(|token| !token.is_empty()),
            "a listed window carries a process-generation token"
        );
        assert!(
            !parse_handle(&window.id).is_null(),
            "the fixture's id parses back to a handle"
        );
    }

    /// `focused_window` composition: the focused-only filter answers with
    /// the window that owns the foreground and nothing else.
    ///
    /// Which window owns the foreground is machine state a sibling test or the
    /// runner's shell can change between any two reads, so the foreground is
    /// pinned for the listing instead of raced for: the fixture's window is
    /// declared the foreground and must be the one window returned, stamped
    /// focused. With the foreground pinned to a handle no window carries, the
    /// filter must answer with nothing rather than falling back to any
    /// window.
    #[test]
    fn the_focused_filter_answers_with_the_foreground_window_and_nothing_else() {
        crate::tree::fixture::ensure_test_apartment();
        let fixture = crate::tree::fixture::HostedFixture::spawn().expect("a fixture host starts");
        let filter = WindowFilter {
            focused_only: true,
            app: None,
        };

        let focused = forced_foreground::with(fixture.handle(), || {
            list_windows_live(&filter, deadline(10_000))
        })
        .expect("the focused listing reads the pinned foreground");

        assert_eq!(
            focused.len(),
            1,
            "the focused-only filter returns exactly the foreground window: {focused:?}"
        );
        assert_eq!(focused[0].id, window_id(fixture.handle() as _));
        assert!(
            focused[0].state.is_focused,
            "the window the focused-only filter returns is stamped focused"
        );

        let nobody = forced_foreground::with(1, || list_windows_live(&filter, deadline(10_000)))
            .expect("the focused listing reads the pinned foreground");
        assert!(
            nobody.is_empty(),
            "no window owns the foreground, so the focused-only filter returns none: {nobody:?}"
        );
    }

    /// The deadline this entry point accepts is a real budget, not an
    /// ignored parameter. An already-expired deadline must refuse before any
    /// native enumeration runs at all - invert-verifiable by dropping the
    /// `ensure_remaining` preamble in `retry_transient_window_race` and watching
    /// this assertion fail as enumeration proceeds anyway.
    #[test]
    fn an_already_expired_deadline_returns_timeout_without_enumerating() {
        enumeration_calls::take();
        let expired = Deadline::after(0).expect("a zero-timeout deadline is constructible");

        let error = list_windows_live(&WindowFilter::default(), expired)
            .expect_err("an expired deadline must refuse the listing");

        assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
        assert_eq!(
            enumeration_calls::take(),
            0,
            "an already-expired deadline must perform no native enumeration"
        );
    }

    /// A mid-walk identity race is absorbed internally rather than surfacing
    /// to `wait_for_window`, whose retryable set does not include
    /// `WINDOW_NOT_FOUND`.
    ///
    /// This forces exactly `FORCED_RACES` inconsistencies. The filter names
    /// an application no window belongs to, so no listed window reaches
    /// `re_verify` and the live desktop cannot inject a genuine identity race
    /// on top of the forced ones: the attempt count is exactly the forced
    /// races plus the attempt that succeeds, and a regression to unbounded
    /// or absent retries changes it.
    #[test]
    fn a_forced_transient_inconsistency_is_retried_and_succeeds_once_it_clears() {
        crate::tree::fixture::ensure_test_apartment();
        enumeration_calls::take();

        const FORCED_RACES: usize = 2;
        let filter = WindowFilter {
            focused_only: false,
            app: Some("agent-desktop-no-such-application.exe".to_string()),
        };
        let outcome = force_window_not_found::with(FORCED_RACES, || {
            list_windows_live(&filter, deadline(10_000))
        });

        assert!(
            outcome.is_ok(),
            "the listing must succeed once the forced inconsistency clears"
        );
        assert_eq!(
            enumeration_calls::take(),
            FORCED_RACES + 1,
            "the {FORCED_RACES} forced-race attempts plus the attempt that succeeded"
        );
    }

    /// A race that survives the whole retry budget still returns the exact
    /// refusal the shipped inventory has always reported, so `wait --window`
    /// and every other caller of this refusal see no change in kind - only
    /// in how often it is reached.
    #[test]
    fn a_persistent_inconsistency_exhausts_the_retry_budget_and_still_refuses() {
        crate::tree::fixture::ensure_test_apartment();
        enumeration_calls::take();

        let outcome = force_window_not_found::with(
            crate::system::window::listing_retry::LISTING_RACE_ATTEMPTS as usize * 2,
            || list_windows_live(&WindowFilter::default(), deadline(10_000)),
        );

        let error = outcome.expect_err("a persistent inconsistency must exhaust the retry budget");
        assert_eq!(error.code, agent_desktop_core::ErrorCode::WindowNotFound);
        assert_eq!(
            enumeration_calls::take(),
            crate::system::window::listing_retry::LISTING_RACE_ATTEMPTS as usize,
            "every attempt performs its own walk"
        );
    }
}
