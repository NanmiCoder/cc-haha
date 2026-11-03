use super::*;
use agent_desktop_core::{AppInfo, ErrorCode, ProcessId, WindowInfo, WindowState};

use crate::system::fixture::test_time::deadline;

fn window(id: &str, app: &str, pid: u32, instance: &str) -> WindowInfo {
    WindowInfo {
        id: id.to_string(),
        title: String::new(),
        app: app.to_string(),
        pid: ProcessId::from(pid),
        process_instance: Some(instance.to_string()),
        bounds: None,
        state: WindowState {
            is_focused: false,
            accessible: true,
            minimized: None,
            visible: None,
        },
    }
}

fn app_info(name: &str, pid: u32, instance: &str) -> AppInfo {
    AppInfo {
        name: name.to_string(),
        pid: ProcessId::from(pid),
        bundle_id: None,
        process_instance: Some(instance.to_string()),
        presentation: None,
    }
}

fn inventory(
    windows: Vec<WindowInfo>,
    apps: Vec<AppInfo>,
    windows_complete: bool,
    apps_complete: bool,
) -> SignalWindowInventory {
    SignalWindowInventory {
        windows,
        apps,
        windows_complete,
        apps_complete,
    }
}

#[test]
fn an_unfiltered_assembly_is_complete_with_surfaces_reflecting_no_scan_requested() {
    let source = inventory(
        vec![window("w-1", "one.exe", 100, "gen-a")],
        vec![app_info("one.exe", 100, "gen-a")],
        true,
        true,
    );

    let baseline = assemble(source, &SignalFilter::default(), deadline(10_000))
        .expect("assembling an unfiltered inventory never touches the native surface scan");

    assert!(baseline.completeness.windows);
    assert!(baseline.completeness.apps);
    assert!(
        baseline.surfaces.is_empty(),
        "no app or process was named, so no surface scan runs"
    );
    assert!(
        !baseline.completeness.surfaces,
        "the surfaces bit must report that no scan was requested, not claim a complete \
         scan that never ran"
    );
}

#[test]
fn a_truncated_walk_reports_windows_and_apps_incomplete() {
    let source = inventory(Vec::new(), Vec::new(), false, false);

    let baseline = assemble(source, &SignalFilter::default(), deadline(10_000))
        .expect("a truncated walk is a reported outcome, not an error");

    assert!(
        !baseline.completeness.windows,
        "a walk cut short by the budget must report completeness.windows false"
    );
    assert!(
        !baseline.completeness.apps,
        "a walk cut short by the budget must report completeness.apps false"
    );
}

#[test]
fn a_timeout_error_passes_through_the_boundary_narrowing_unchanged() {
    let error = AdapterError::timeout("Operation exceeded its deadline");

    let narrowed = narrow_to_permitted_codes(error);

    assert_eq!(narrowed.code, ErrorCode::Timeout);
}

#[test]
fn every_non_timeout_code_the_boundary_narrowing_sees_becomes_app_unresponsive() {
    let every_code = [
        ErrorCode::PermDenied,
        ErrorCode::ElementNotFound,
        ErrorCode::AppNotFound,
        ErrorCode::ActionFailed,
        ErrorCode::ActionNotSupported,
        ErrorCode::StaleRef,
        ErrorCode::AmbiguousTarget,
        ErrorCode::WindowNotFound,
        ErrorCode::PlatformNotSupported,
        ErrorCode::InvalidArgs,
        ErrorCode::NotificationNotFound,
        ErrorCode::SnapshotNotFound,
        ErrorCode::PolicyDenied,
        ErrorCode::Internal,
    ];

    for code in every_code {
        let label = code.as_str();
        let narrowed = narrow_to_permitted_codes(AdapterError::new(code, "seam-forced failure"));
        assert_eq!(
            narrowed.code,
            ErrorCode::AppUnresponsive,
            "code {label} must be narrowed to APP_UNRESPONSIVE rather than reaching core \
             unchanged - core aborts the whole wait on any code outside the closed set"
        );
    }
}

#[cfg(target_os = "windows")]
mod windows_only {
    use super::*;

    use std::time::Duration;

    use agent_desktop_core::{
        EventKind, InteractionLease, ProcessIdentity, SystemOps, WindowState, diff_signals,
    };

    use crate::system::window::window_activate::focus_window;
    use crate::tree::fixture::fixture_window;
    use crate::tree::fixture::{HostedFixture, bootstrap};

    const SETTLE: Duration = Duration::from_millis(250);

    fn lease() -> InteractionLease {
        InteractionLease::guarded(deadline(10_000), ())
            .expect("a lease can be acquired for the test")
    }

    fn window_info_for(fixture: &HostedFixture) -> WindowInfo {
        let pid = ProcessId::from(fixture.process_id());
        let token = crate::system::process_identity::token_for_pid(pid)
            .expect("a live process's token is readable")
            .expect("a live process has a readable generation token");
        WindowInfo {
            id: format!("w-{}", fixture.handle() as usize),
            title: String::new(),
            app: String::new(),
            pid,
            process_instance: Some(token),
            bounds: None,
            state: WindowState::default(),
        }
    }

    /// Reproduces `crates/core/src/commands/wait_event.rs:257-296`'s own
    /// predicate rather than paraphrasing it: for a process-filtered wait,
    /// every observed pid and process instance across windows, apps, and
    /// surfaces must equal the expected one exactly.
    fn satisfies_validate_signal_scope(
        baseline: &SignalBaseline,
        expected: &ProcessIdentity,
    ) -> bool {
        baseline
            .windows
            .iter()
            .map(|window| (window.pid, window.process_instance.as_deref()))
            .chain(
                baseline
                    .apps
                    .iter()
                    .map(|app| (app.pid, app.process_instance.as_deref())),
            )
            .chain(
                baseline
                    .surfaces
                    .iter()
                    .map(|surface| (surface.pid, Some(surface.process_instance.as_str()))),
            )
            .all(|(pid, instance)| {
                pid == expected.pid && instance == Some(expected.instance.as_str())
            })
    }

    #[test]
    fn an_unfiltered_capture_on_a_live_desktop_is_complete_with_no_surface_scan() {
        bootstrap();

        let baseline = capture_signal_baseline_impl(&SignalFilter::default(), deadline(10_000))
            .expect("an unfiltered capture on a live desktop must succeed");

        assert!(baseline.completeness.windows);
        assert!(baseline.completeness.apps);
        assert!(baseline.surfaces.is_empty());
        assert!(!baseline.completeness.surfaces);
    }

    #[test]
    fn a_process_filtered_capture_returns_only_that_process_and_satisfies_cores_scope_check() {
        bootstrap();
        let fixture = HostedFixture::spawn().expect("a fixture host starts");
        let fixture_pid = ProcessId::from(fixture.process_id());
        let token = crate::system::process_identity::token_for_pid(fixture_pid)
            .expect("a live process's token is readable")
            .expect("a live process has a readable generation token");
        let expected = ProcessIdentity::new(fixture.process_id(), token);
        let filter = SignalFilter {
            app: None,
            process: Some(expected.clone()),
        };

        let baseline = capture_signal_baseline_impl(&filter, deadline(10_000))
            .expect("a process-filtered capture on a live desktop must succeed");

        assert!(
            baseline
                .windows
                .iter()
                .any(|window| window.pid == fixture_pid),
            "the filtered capture must still contain the fixture's window, or the scope checks \
             below pass on an empty baseline"
        );
        assert!(
            baseline.apps.iter().any(|app| app.pid == fixture_pid),
            "the filtered capture must still contain the fixture's app, or the scope checks \
             below pass on an empty baseline"
        );
        for window in &baseline.windows {
            assert_eq!(window.pid, fixture_pid);
        }
        for app in &baseline.apps {
            assert_eq!(app.pid, fixture_pid);
        }
        assert!(
            satisfies_validate_signal_scope(&baseline, &expected),
            "a process-filtered capture must carry no window, app, or surface whose pid or \
             instance differs from the filter's expected process, or core's \
             validate_signal_scope aborts the wait"
        );
    }

    #[test]
    fn a_process_filter_requests_and_completes_a_surface_scan_of_the_calling_process() {
        bootstrap();
        let own_pid = ProcessId::from(std::process::id());
        let token = crate::system::process_identity::token_for_pid(own_pid)
            .expect("this test process's own token is readable")
            .expect("this test process's own token is a live generation token");
        let filter = SignalFilter {
            app: None,
            process: Some(ProcessIdentity::new(std::process::id(), token)),
        };

        let baseline = capture_signal_baseline_impl(&filter, deadline(10_000))
            .expect("a process-filtered capture scoped to this live process must succeed");

        assert!(
            baseline.completeness.surfaces,
            "a filter naming a process must request and complete a surface scan"
        );
    }

    /// Forces OS foreground onto `transition`'s window, so it holds
    /// `fixture_window::on_screen_stage` for the whole span - both captures
    /// plus the forced focus change between them - the same DESKTOP/
    /// FOREGROUND-state guard `window_activate_tests.rs`'s focus tests and
    /// `wait_event_live_tests.rs`'s no-transition negative test take. The
    /// fixture and shell lock families are held first, in the crate-wide
    /// order: this test's own deliberate focus change is exactly the kind of
    /// real, unguarded foreground move that can leak into a sibling's
    /// two-captures-no-event assertion running concurrently, and a sibling's
    /// raise or staged window can leak into this one's baseline the same way.
    #[test]
    fn a_fixture_transition_still_produces_window_opened_and_focus_changed_through_the_composed_capture()
     {
        bootstrap();
        let _fixture_scope = crate::system::fixture::test_support::FIXTURE_APP_NAME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _shell = crate::system::fixture::test_support::SHELL_SURFACE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _stage = fixture_window::on_screen_stage();

        let parking = HostedFixture::spawn().expect("the parking fixture starts");
        if !crate::system::fixture::test_support::stage_foreground(parking.handle()) {
            eprintln!(concat!(
                "skip composed focus transition: this desktop declines foreground even to a ",
                "raw SetForegroundWindow, so no transition can be staged at all",
            ));
            return;
        }

        let before = capture_signal_baseline_impl(&SignalFilter::default(), deadline(10_000))
            .expect("the composed baseline capture must succeed on a live desktop");

        let transition = HostedFixture::spawn().expect("the transition fixture starts");
        let transition_pid = ProcessId::from(transition.process_id());

        focus_window(&window_info_for(&transition), &lease()).expect(concat!(
            "foreground was granted to the parking window before the baseline was taken, so ",
            "the product's own activation must succeed here - a refusal is a regression, not ",
            "an environment decline",
        ));
        std::thread::sleep(SETTLE);

        let after = capture_signal_baseline_impl(&SignalFilter::default(), deadline(10_000))
            .expect("the composed baseline capture must succeed on a live desktop");

        let events = diff_signals(&before, &after);
        assert!(
            events
                .iter()
                .any(|event| matches!(event.kind, EventKind::WindowOpened)
                    && event.pid == Some(transition_pid)),
            "the fixture's window must be reported opened through the composed capture: \
             {events:?}"
        );
        assert!(
            events
                .iter()
                .any(|event| matches!(event.kind, EventKind::FocusChangedWindow)
                    && event.pid == Some(transition_pid)),
            "the focus change must name the window activation was asked for, not merely \
             report that the desktop's foreground moved - an activation that focused some \
             other window would satisfy an unpinned assertion: {events:?}"
        );
    }

    #[test]
    fn an_already_expired_deadline_is_refused_with_timeout() {
        let expired = Deadline::after(0).expect("a zero-timeout deadline is constructible");

        let error = capture_signal_baseline_impl(&SignalFilter::default(), expired)
            .expect_err("an expired deadline must refuse the capture");

        assert_eq!(error.code, ErrorCode::Timeout);
    }

    #[test]
    fn capture_signal_baseline_reaches_the_windows_override_instead_of_the_not_supported_default() {
        let adapter = crate::adapter::WindowsAdapter::new();

        let result = adapter.capture_signal_baseline(&SignalFilter::default(), deadline(10_000));

        if let Err(error) = result {
            assert_ne!(error.code, ErrorCode::PlatformNotSupported);
        }
    }
}
