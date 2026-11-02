use super::*;
use agent_desktop_core::{Deadline, ErrorCode};

use crate::system::fixture::test_time::deadline;

#[test]
fn a_non_timeout_native_failure_is_remapped_to_app_unresponsive() {
    let native = AdapterError::internal("EnumWindows failed to enumerate top-level windows");
    let mapped = remap_native_failure(native);

    assert_eq!(mapped.code, ErrorCode::AppUnresponsive);
    let kind = mapped
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(|kind| kind.as_str());
    assert_eq!(kind, Some("native_enumeration_failure"));
}

#[test]
fn a_timeout_native_failure_passes_through_unchanged() {
    let timeout = AdapterError::timeout("Operation exceeded its deadline");
    let mapped = remap_native_failure(timeout);

    assert_eq!(mapped.code, ErrorCode::Timeout);
}

#[test]
fn the_exhausted_race_error_names_its_kind_and_attempt_count() {
    let error = mid_walk_identity_race_error(LISTING_RACE_ATTEMPTS);

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    let details = error.details.as_ref().expect("details are attached");
    assert_eq!(
        details.get("kind").and_then(|kind| kind.as_str()),
        Some("mid_walk_identity_race")
    );
    assert_eq!(
        details
            .get("attempts")
            .and_then(|attempts| attempts.as_u64()),
        Some(u64::from(LISTING_RACE_ATTEMPTS))
    );
}

#[cfg(target_os = "windows")]
mod windows_only {
    use super::*;
    use crate::tree::fixture::{HostedFixture, bootstrap};
    use std::collections::HashSet;

    /// Runs a live capture and accepts the one refusal this inventory may
    /// legitimately report on a busy desktop: an exhausted mid-walk identity
    /// race, already retried internally up to `LISTING_RACE_ATTEMPTS` times.
    /// Any other code fails the assertion outright.
    fn expect_capture(deadline: Deadline) -> Option<SignalWindowInventory> {
        match capture_windows_and_apps(deadline) {
            Ok(inventory) => Some(inventory),
            Err(error) => {
                assert_eq!(
                    error.code,
                    ErrorCode::AppUnresponsive,
                    "the only refusal a live capture may report is an exhausted mid-walk \
                     identity race"
                );
                None
            }
        }
    }

    #[test]
    fn a_single_pass_performs_exactly_one_enum_windows_walk() {
        bootstrap();
        enum_windows_calls::take();

        let _ = single_pass(deadline(10_000));

        assert_eq!(
            enum_windows_calls::take(),
            1,
            "one single_pass invocation must enumerate windows exactly once"
        );
    }

    #[test]
    fn an_already_expired_deadline_returns_timeout_before_any_enumeration() {
        enum_windows_calls::take();
        let expired = Deadline::after(0).expect("a zero-timeout deadline is constructible");

        let error = capture_windows_and_apps(expired)
            .expect_err("an expired deadline must refuse the capture");

        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(
            enum_windows_calls::take(),
            0,
            "an already-expired deadline must perform no native enumeration"
        );
    }

    #[test]
    fn a_hosted_fixture_appears_once_in_both_inventories_with_identity() {
        bootstrap();
        let fixture = HostedFixture::spawn().expect("a fixture host starts");
        let fixture_pid = ProcessId::from(fixture.process_id());
        let Some(inventory) = expect_capture(deadline(10_000)) else {
            return;
        };

        let matches: Vec<_> = inventory
            .windows
            .iter()
            .filter(|window| window.pid == fixture_pid)
            .collect();
        assert!(
            !matches.is_empty(),
            "the fixture's window must appear in the inventory"
        );
        for window in &matches {
            assert!(
                window
                    .process_instance
                    .as_deref()
                    .is_some_and(|token| !token.is_empty()),
                "a listed window carries a non-empty process_instance"
            );
            assert!(
                !window_ops::parse_handle(&window.id).is_null(),
                "the window id parses back to a handle"
            );
        }
        let app_matches = inventory
            .apps
            .iter()
            .filter(|app| app.pid == fixture_pid)
            .count();
        assert_eq!(
            app_matches, 1,
            "the fixture's process appears exactly once in apps"
        );
    }

    #[test]
    fn terminating_the_fixture_removes_it_from_a_later_capture() {
        bootstrap();
        let mut fixture = HostedFixture::spawn().expect("a fixture host starts");
        let fixture_pid = ProcessId::from(fixture.process_id());
        fixture.terminate();

        let Some(inventory) = expect_capture(deadline(10_000)) else {
            return;
        };
        assert!(
            !inventory
                .windows
                .iter()
                .any(|window| window.pid == fixture_pid)
        );
        assert!(!inventory.apps.iter().any(|app| app.pid == fixture_pid));
    }

    #[test]
    fn every_returned_window_and_app_carries_a_non_empty_process_instance() {
        bootstrap();
        let Some(inventory) = expect_capture(deadline(10_000)) else {
            return;
        };

        for window in &inventory.windows {
            assert!(
                window
                    .process_instance
                    .as_deref()
                    .is_some_and(|token| !token.is_empty()),
                "window {} must carry a non-empty process_instance",
                window.id
            );
        }
        for app in &inventory.apps {
            assert!(
                app.process_instance
                    .as_deref()
                    .is_some_and(|token| !token.is_empty()),
                "app pid {} must carry a non-empty process_instance",
                app.pid
            );
        }
    }

    #[test]
    fn a_window_whose_token_read_fails_is_excluded_and_not_emitted_with_none() {
        bootstrap();
        let fixture = HostedFixture::spawn().expect("a fixture host starts");
        let fixture_pid = ProcessId::from(fixture.process_id());

        let outcome =
            force_token_none::with(fixture_pid, || capture_windows_and_apps(deadline(10_000)));

        let inventory = match outcome {
            Ok(inventory) => inventory,
            Err(error) => {
                assert_eq!(error.code, ErrorCode::AppUnresponsive);
                return;
            }
        };

        assert!(
            !inventory
                .windows
                .iter()
                .any(|window| window.pid == fixture_pid),
            "a window whose identity cannot be read must not be emitted"
        );
        assert!(
            !inventory.apps.iter().any(|app| app.pid == fixture_pid),
            "an app whose identity cannot be read must not be emitted"
        );
        assert!(
            inventory.windows_complete && inventory.apps_complete,
            "an identity exclusion must not flip completeness"
        );
    }

    #[test]
    fn the_re_walk_retries_a_forced_inconsistency_and_succeeds_once_it_clears() {
        bootstrap();
        enum_windows_calls::take();

        let outcome = force_race::with(2, || capture_windows_and_apps(deadline(10_000)));

        assert!(
            outcome.is_ok(),
            "the capture must succeed once the forced inconsistency clears"
        );
        assert_eq!(
            enum_windows_calls::take(),
            3,
            "two forced-race attempts plus the attempt that succeeded"
        );
    }

    #[test]
    fn a_held_inconsistency_exhausts_the_re_walk_and_never_reports_a_shipped_refusal_code() {
        bootstrap();
        enum_windows_calls::take();

        let outcome = force_race::with(LISTING_RACE_ATTEMPTS as usize * 2, || {
            capture_windows_and_apps(deadline(10_000))
        });

        let error = outcome.expect_err("a held inconsistency must exhaust the re-walk budget");
        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        let kind = error
            .details
            .as_ref()
            .and_then(|details| details.get("kind"))
            .and_then(|kind| kind.as_str());
        assert_eq!(kind, Some("mid_walk_identity_race"));
        assert_eq!(
            enum_windows_calls::take(),
            LISTING_RACE_ATTEMPTS as usize,
            "every attempt performs its own walk"
        );
    }

    #[test]
    fn a_truncated_walk_reports_incomplete_never_the_exclusion_disposition() {
        bootstrap();

        let outcome = force_truncation::with(|| capture_windows_and_apps(deadline(10_000)));

        let inventory = outcome.expect("a truncated walk is a reported outcome, not an error");
        assert!(!inventory.windows_complete);
        assert!(!inventory.apps_complete);
        assert!(inventory.windows.is_empty());
        assert!(inventory.apps.is_empty());
    }

    #[test]
    fn two_back_to_back_captures_agree_on_identity() {
        bootstrap();

        let windows_of = |inventory: &SignalWindowInventory| {
            inventory
                .windows
                .iter()
                .map(|window| {
                    (
                        window.pid,
                        window.process_instance.clone(),
                        window.id.clone(),
                    )
                })
                .collect::<HashSet<_>>()
        };
        let apps_of = |inventory: &SignalWindowInventory| {
            inventory
                .apps
                .iter()
                .map(|app| (app.pid, app.process_instance.clone()))
                .collect::<HashSet<_>>()
        };

        let (Some(first), Some(second)) = (
            expect_capture(deadline(10_000)),
            expect_capture(deadline(10_000)),
        ) else {
            return;
        };

        let (first_windows, second_windows) = (windows_of(&first), windows_of(&second));
        let (first_apps, second_apps) = (apps_of(&first), apps_of(&second));

        let first_ids = first_windows
            .iter()
            .map(|(_, _, id)| id.clone())
            .collect::<HashSet<_>>();
        let second_ids = second_windows
            .iter()
            .map(|(_, _, id)| id.clone())
            .collect::<HashSet<_>>();
        for id in first_ids.intersection(&second_ids) {
            let identity_of = |set: &HashSet<(ProcessId, Option<String>, String)>| {
                set.iter()
                    .filter(|(_, _, candidate)| candidate == id)
                    .map(|(pid, instance, _)| (*pid, instance.clone()))
                    .collect::<HashSet<_>>()
            };
            assert_eq!(
                identity_of(&first_windows),
                identity_of(&second_windows),
                "the same window id resolved to a different pid or process instance between \
                 two reads, so the inventory is inventing identity rather than reporting it"
            );
        }

        let first_app_pids = first_apps
            .iter()
            .map(|(pid, _)| *pid)
            .collect::<HashSet<_>>();
        let second_app_pids = second_apps
            .iter()
            .map(|(pid, _)| *pid)
            .collect::<HashSet<_>>();
        for pid in first_app_pids.intersection(&second_app_pids) {
            let instance_of = |set: &HashSet<(ProcessId, Option<String>)>| {
                set.iter()
                    .filter(|(candidate, _)| candidate == pid)
                    .map(|(_, instance)| instance.clone())
                    .collect::<HashSet<_>>()
            };
            assert_eq!(
                instance_of(&first_apps),
                instance_of(&second_apps),
                "a process live across two reads must report one generation token in both"
            );
        }
    }
}
