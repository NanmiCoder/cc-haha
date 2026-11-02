use super::*;

const E_ACCESSDENIED_HRESULT: i32 = 0x8007_0005_u32 as i32;
const UIA_E_ELEMENTNOTAVAILABLE_HRESULT: i32 = 0x8004_0201_u32 as i32;
const RPC_S_SERVER_UNAVAILABLE_HRESULT: i32 = 0x8007_06BA_u32 as i32;
const UNRECOGNISED_SENTINEL: i32 = 4242;

#[test]
fn a_negative_hresult_formats_with_its_symbolic_name() {
    let error = uia_failure_error(
        UiaFailure::Hresult(E_ACCESSDENIED_HRESULT),
        "read a property",
    );

    assert_eq!(error.code, ErrorCode::PermDenied);
    assert_eq!(
        error.platform_detail.as_deref(),
        Some("COM HRESULT 0x80070005 (E_ACCESSDENIED: Access is denied)")
    );
}

#[test]
fn a_crate_sentinel_never_prints_a_fabricated_hresult() {
    let error = uia_failure_error(UiaFailure::Sentinel(ERR_TIMEOUT), "read a property");

    assert_eq!(error.code, ErrorCode::Timeout);
    let detail = error.platform_detail.expect("a sentinel carries detail");
    assert!(!detail.contains("0x"), "sentinel detail was {detail}");
    assert!(!error.message.contains("0x"));
}

#[test]
fn an_unrecognised_sentinel_maps_to_internal_rather_than_a_guess() {
    let error = uia_failure_error(
        UiaFailure::Sentinel(UNRECOGNISED_SENTINEL),
        "walk a subtree",
    );

    assert_eq!(error.code, ErrorCode::Internal);
}

#[test]
fn a_disconnected_provider_reports_an_unresponsive_app() {
    let error = uia_failure_error(
        UiaFailure::Hresult(RPC_S_SERVER_UNAVAILABLE_HRESULT),
        "enumerate children",
    );

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
}

#[test]
fn only_the_empty_sentinel_counts_as_exhaustion() {
    assert!(UiaFailure::Sentinel(ERR_NONE).is_exhaustion());
    assert!(!UiaFailure::Sentinel(ERR_NOTFOUND).is_exhaustion());
    assert!(!UiaFailure::Hresult(0).is_exhaustion());
    assert!(!UiaFailure::Hresult(UIA_E_ELEMENTNOTAVAILABLE_HRESULT).is_exhaustion());
}

#[test]
fn an_unavailable_root_is_a_missing_window_not_a_stale_element() {
    let by_hresult = root_resolution_error(UiaFailure::Hresult(UIA_E_ELEMENTNOTAVAILABLE_HRESULT));
    let by_sentinel = root_resolution_error(UiaFailure::Sentinel(ERR_NOTFOUND));

    assert_eq!(by_hresult.code, ErrorCode::WindowNotFound);
    assert_eq!(by_sentinel.code, ErrorCode::WindowNotFound);
    assert!(
        by_hresult
            .platform_detail
            .is_some_and(|detail| detail.contains("UIA_E_ELEMENTNOTAVAILABLE"))
    );
}

#[test]
fn a_root_failure_that_is_not_a_missing_window_keeps_its_own_code() {
    let error = root_resolution_error(UiaFailure::Hresult(E_ACCESSDENIED_HRESULT));

    assert_eq!(error.code, ErrorCode::PermDenied);
}

/// `ref_action.rs` clones adapter error text into session JSONL and into the
/// trace HTML export. A `UiaFailure` carries only an integer, so the error is
/// pinned to its complete static shape: any text a later change appends to the
/// message, the platform detail or the details object fails the comparison.
/// The path that takes caller-supplied text is covered by
/// `a_live_uia_error_never_carries_the_crate_message_verbatim`.
#[test]
fn a_classifier_error_is_exactly_its_static_shape() {
    let error = uia_failure_error(
        UiaFailure::Hresult(E_ACCESSDENIED_HRESULT),
        "read a property",
    );

    assert_eq!(error.message, "UI Automation could not read a property");
    assert_eq!(
        error.platform_detail.as_deref(),
        Some("COM HRESULT 0x80070005 (E_ACCESSDENIED: Access is denied)")
    );
    let details = error.details.expect("the classifier stamps details");
    let mut keys: Vec<&str> = details
        .as_object()
        .expect("details are an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["complete", "retryable"]);
}

#[test]
fn an_empty_window_handle_is_rejected_before_the_com_layer() {
    let deadline = Deadline::standard().expect("a standard deadline");

    let Err(error) = validate_window_handle(0, deadline) else {
        panic!("an empty window handle must be rejected");
    };

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(validate_window_handle(1, deadline).is_ok());
}

#[cfg(not(target_os = "windows"))]
#[test]
fn the_canned_resolver_reports_a_missing_window_for_an_empty_handle() {
    let deadline = Deadline::standard().expect("a standard deadline");

    let Err(error) = root_from_hwnd(0, deadline) else {
        panic!("the canned arm must reject an empty handle");
    };

    assert_eq!(error.code, ErrorCode::WindowNotFound);
    assert!(root_from_hwnd(1, deadline).is_ok());
}

#[cfg(target_os = "windows")]
mod windows_only {
    use super::*;
    use crate::tree::fixture::bootstrap;
    use uiautomation::Error as UiaError;

    const LEAK_MARKER: &str = "zzmarkerzz-secret-window-title";

    /// Two calls on one thread hand back the *same* COM object, not two.
    ///
    /// Asserting only that both calls succeed passes just as well for a cache
    /// that was never populated, which would pay a fresh `CoCreateInstance`
    /// and a fresh first-touch serialization on every walk. The interfaces are
    /// compared directly, so a reuse regression fails here.
    #[test]
    fn the_client_is_reusable_within_a_thread() {
        bootstrap();

        let first = automation_client().expect("the first client builds");
        let second = automation_client().expect("the second client builds");

        let first: &windows::Win32::UI::Accessibility::IUIAutomation = first.as_ref();
        let second: &windows::Win32::UI::Accessibility::IUIAutomation = second.as_ref();
        assert_eq!(
            first, second,
            "the second call must return this thread's cached client, not a new instance"
        );
    }

    #[test]
    fn a_hresult_error_splits_onto_the_result_branch() {
        let error = UiaError::from(windows::core::HRESULT(E_ACCESSDENIED_HRESULT));

        assert_eq!(
            failure_of(&error),
            UiaFailure::Hresult(E_ACCESSDENIED_HRESULT)
        );
    }

    #[test]
    fn a_sentinel_error_splits_onto_the_sentinel_branch() {
        let error = UiaError::new(ERR_TIMEOUT, "");

        assert_eq!(failure_of(&error), UiaFailure::Sentinel(ERR_TIMEOUT));
    }

    /// The runtime end-of-list pair the walker depends on, asserted against
    /// the real crate rather than against a reading of it.
    #[test]
    fn a_null_interface_out_param_reports_the_exhaustion_sentinel() {
        let error = UiaError::from(windows::core::Error::empty());

        assert!(failure_of(&error).is_exhaustion());
    }

    #[test]
    fn a_destroyed_window_handle_reports_a_missing_window() {
        bootstrap();
        let deadline = Deadline::standard().expect("a standard deadline");

        let Err(error) = root_from_hwnd(isize::MAX, deadline) else {
            panic!("a handle that addresses no window must not resolve");
        };

        assert!(matches!(
            error.code,
            ErrorCode::WindowNotFound | ErrorCode::InvalidArgs | ErrorCode::ElementNotFound
        ));
    }

    /// Greptile raised this as a P1 and it was right: two deadline checks
    /// cannot interrupt the blocking `SendMessage` between them, so a target
    /// that has stopped pumping would block the caller indefinitely.
    ///
    /// The condition is recorded elsewhere as unverified because "the fixture
    /// cannot produce it". It can - `CreateWindowExW` dispatches `WM_CREATE`
    /// inline, so a thread can own a live, visible window and then never
    /// dispatch again. Against that window the resolver must return a
    /// structured `APP_UNRESPONSIVE` promptly, not hang; the watchdog makes a
    /// regression fail loudly rather than stall the lane.
    #[test]
    fn a_window_that_stopped_pumping_is_reported_rather_than_blocked_on() {
        bootstrap();
        let stalled = crate::tree::fixture::StalledFixture::create()
            .expect("a non-pumping window is created");
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let watchdog = done.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(30));
            assert!(
                watchdog.load(std::sync::atomic::Ordering::SeqCst),
                "root resolution blocked on a window that stopped pumping"
            );
        });

        let started = std::time::Instant::now();
        let outcome = root_from_hwnd(
            stalled.handle(),
            Deadline::after(5_000).expect("a bounded deadline"),
        );
        done.store(true, std::sync::atomic::Ordering::SeqCst);

        let Err(error) = outcome else {
            panic!("a window that is not dispatching must not resolve");
        };
        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(20),
            "the probe must bound the wait, took {:?}",
            started.elapsed()
        );
    }

    /// Why the client is built from `CUIAutomation8` rather than the CLSID
    /// `UIAutomation::new_direct()` uses: the crate's object does not support
    /// `IUIAutomation2`, so its calls carry no timeout at all. That is the
    /// whole reason this crate does not use it, and the reason there is no
    /// fallback to it.
    #[test]
    fn the_crates_own_client_carries_no_timeout_which_is_why_it_is_not_used() {
        use windows::Win32::UI::Accessibility::{IUIAutomation, IUIAutomation2};
        use windows::core::Interface;
        bootstrap();
        let crate_client = uiautomation::UIAutomation::new_direct().expect("the crate's client");
        let raw: IUIAutomation = crate_client.as_ref().clone();

        assert!(raw.cast::<IUIAutomation2>().is_err());
    }

    /// The client this crate hands out is the bounded one - always, with no
    /// unbounded fallback. A client whose calls cannot time out is refused
    /// rather than quietly accepted, so this assertion holds on every build
    /// the product supports or client creation fails outright.
    #[test]
    fn the_shipped_client_exposes_the_timeouts_it_sets() {
        use windows::Win32::UI::Accessibility::{IUIAutomation, IUIAutomation2};
        use windows::core::Interface;
        bootstrap();
        let client = automation_client().expect("a client");
        let raw: IUIAutomation = client.as_ref().clone();

        let bounded: IUIAutomation2 = raw
            .cast()
            .expect("the shipped client must expose IUIAutomation2");
        assert_eq!(
            unsafe { bounded.ConnectionTimeout() }.expect("a connection timeout is set"),
            crate::tree::automation::CONNECTION_TIMEOUT_MS
        );
    }

    /// The race Greptile named: a target that answers the pump probe and then
    /// stops dispatching. The probe cannot help there, so the bound has to be
    /// on the call itself.
    ///
    /// Asserted by skipping the probe entirely and calling the client
    /// directly, which is the worst case the resolver can face. The client's
    /// connection timeout returns `UIA_E_TIMEOUT` instead of blocking.
    #[test]
    fn the_client_bounds_a_call_the_pump_probe_cannot_catch() {
        bootstrap();
        let stalled = crate::tree::fixture::StalledFixture::create()
            .expect("a non-pumping window is created");
        let client = automation_client().expect("a client");
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let watchdog = done.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(30));
            assert!(
                watchdog.load(std::sync::atomic::Ordering::SeqCst),
                "the client did not bound a call against a non-pumping target"
            );
        });

        let started = std::time::Instant::now();
        let outcome =
            client.element_from_handle(uiautomation::types::Handle::from(stalled.handle()));
        done.store(true, std::sync::atomic::Ordering::SeqCst);

        assert!(outcome.is_err(), "a stalled target must not resolve");
        let bound = std::time::Duration::from_millis(u64::from(
            crate::tree::automation::CONNECTION_TIMEOUT_MS,
        )) * 2;
        assert!(
            started.elapsed() < bound,
            "the call must be bounded by the client's connection timeout, took {:?}",
            started.elapsed()
        );
    }

    /// UI Automation's client core initializes lazily and not re-entrantly:
    /// concurrent first touches made all but one thread fail instantly with
    /// E_FAIL and "Re-Entrant CheckInit() call, aborting". The accessor
    /// serializes that first touch, so every thread gets a working client.
    #[test]
    fn concurrent_first_touches_do_not_race_uia_lazy_initialization() {
        bootstrap();
        let readers: Vec<_> = (0..4)
            .map(|_| {
                std::thread::spawn(|| {
                    bootstrap();
                    let client = automation_client().expect("a client per thread");
                    client.get_root_element().is_ok()
                })
            })
            .collect();

        for reader in readers {
            assert!(
                reader.join().expect("the reader thread completes"),
                "a healthy desktop-root read was refused by the connection bound"
            );
        }
    }

    #[test]
    fn a_pumping_window_passes_the_probe() {
        bootstrap();
        let fixture =
            crate::tree::fixture::LocalFixture::create().expect("a pumping window is created");

        assert!(crate::tree::automation::window_is_pumping(
            fixture.handle(),
            2_000
        ));
        assert!(!crate::tree::automation::window_is_pumping(0, 50));
    }

    #[test]
    fn a_live_uia_error_never_carries_the_crate_message_verbatim() {
        let error = uia_error(&UiaError::new(ERR_TIMEOUT, LEAK_MARKER), "read a property");

        assert!(!error.message.contains(LEAK_MARKER));
        assert!(
            !error
                .platform_detail
                .unwrap_or_default()
                .contains(LEAK_MARKER)
        );
    }
}
