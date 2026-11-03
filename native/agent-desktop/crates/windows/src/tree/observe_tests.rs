use super::*;

fn window_for(pid: u32, instance: &str) -> agent_desktop_core::WindowInfo {
    agent_desktop_core::WindowInfo {
        id: "w-1".into(),
        title: "x".into(),
        app: "x".into(),
        pid: agent_desktop_core::ProcessId::new(pid),
        process_instance: Some(instance.into()),
        bounds: None,
        state: Default::default(),
    }
}

fn request_with(deadline: Deadline, force_renderer_accessibility: bool) -> ObservationRequest {
    let options = agent_desktop_core::TreeOptions {
        force_renderer_accessibility,
        ..agent_desktop_core::TreeOptions::default()
    };
    ObservationRequest::snapshot(&options, deadline)
}

/// A small, complete `WalkOutcome` unrelated to any live provider: one node,
/// no faults. `finish_observation` takes `chromium_root` and the shell
/// classification as separate inputs, so this same outcome doubles as both a
/// "clean native walk" and a "settled Chromium shell" fixture depending on
/// what the caller passes for `chromium_root`.
fn small_complete_outcome() -> WalkOutcome {
    crate::tree::walk::walker_fake::walk(
        &crate::tree::walk::walker_fake::FakeTree::default(),
        crate::tree::walk::walker_fake::budget(10),
    )
}

#[test]
fn a_malformed_root_window_id_fails_before_walking() {
    let request = ObservationRequest::snapshot(
        &agent_desktop_core::TreeOptions::default(),
        agent_desktop_core::Deadline::after(5_000).unwrap(),
    );
    let window = agent_desktop_core::WindowInfo {
        id: "not-a-window-id".into(),
        title: "x".into(),
        app: "x".into(),
        pid: agent_desktop_core::ProcessId::new(1),
        process_instance: None,
        bounds: None,
        state: Default::default(),
    };

    let error = observe_tree(
        ObservationRoot::Window(&window),
        &request,
        &crate::adapter::WindowsAdapter::new(),
    )
    .expect_err("a malformed id must fail");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[cfg(target_os = "windows")]
#[test]
fn a_destroyed_hwnd_fails_reverification_as_window_not_found() {
    let window = agent_desktop_core::WindowInfo {
        id: format!("w-{}", 0x7fffffff),
        title: "x".into(),
        app: "x".into(),
        pid: agent_desktop_core::ProcessId::new(1),
        process_instance: None,
        bounds: None,
        state: Default::default(),
    };

    let error = re_verify_root(agent_desktop_core::ObservationRoot::Window(&window))
        .expect_err("a destroyed handle must fail the liveness gate");
    assert_eq!(error.code, ErrorCode::WindowNotFound);
}

#[cfg(target_os = "windows")]
#[test]
fn a_freshly_created_fixture_window_passes_reverification() {
    use agent_desktop_core::ObservationRoot;

    crate::tree::fixture::ensure_test_apartment();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("a fixture host starts");
    let window = agent_desktop_core::WindowInfo {
        id: crate::system::window::window_ops::window_id(fixture.handle() as _),
        title: "agent-desktop fixture".into(),
        app: "fixture.exe".into(),
        pid: agent_desktop_core::ProcessId::from(fixture.process_id()),
        process_instance: Some(
            crate::system::process_identity::token_for_pid(agent_desktop_core::ProcessId::from(
                fixture.process_id(),
            ))
            .unwrap()
            .expect("a live fixture process has a token"),
        ),
        bounds: None,
        state: Default::default(),
    };

    let result = re_verify_root(ObservationRoot::Window(&window));
    assert!(
        result.is_ok(),
        "a live fixture root must pass the liveness gate: {result:?}"
    );
}

/// Finding 4(a): a clean-looking complete walk still has to pass the
/// liveness gate. Deleting the `verify_root(root)?` call site in
/// `finish_observation`'s non-shell branch would make this test observe a
/// success where the fake verifier demands a failure.
#[test]
fn a_clean_complete_walk_still_fails_when_root_reverification_fails() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    let request = request_with(Deadline::after(5_000).unwrap(), false);

    let error = finish_observation(
        ObservationRoot::Window(&window),
        request,
        &adapter,
        CompletedWalk {
            chromium_root: false,
            outcome: small_complete_outcome(),
            walk_duration: Duration::ZERO,
        },
        |_| Err(window_identity_changed()),
    )
    .expect_err("a failing reverification must not be swallowed by a clean-looking walk");

    assert_eq!(error.code, ErrorCode::WindowNotFound);
}

/// Finding 4(b): the force-renderer-accessibility path skips activation
/// guidance, not liveness. Deleting the `verify_root(root)?` call ahead of
/// the force-path's early return would make this test observe a success.
#[test]
fn the_force_path_still_reverifies_before_returning_the_tree() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    let request = request_with(Deadline::after(5_000).unwrap(), true);

    let error = finish_observation(
        ObservationRoot::Window(&window),
        request,
        &adapter,
        CompletedWalk {
            chromium_root: true,
            outcome: small_complete_outcome(),
            walk_duration: Duration::ZERO,
        },
        |_| Err(window_identity_changed()),
    )
    .expect_err("the force-renderer-accessibility path must not skip liveness");

    assert_eq!(error.code, ErrorCode::WindowNotFound);
}

#[test]
fn a_partial_tree_is_rejected_when_root_ownership_changes() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    let request = request_with(Deadline::after(5_000).unwrap(), false);
    let fake = crate::tree::walk::walker_fake::FakeTree::default().with_chain(&[1, 2, 3]);
    let outcome = crate::tree::walk::walker_fake::walk(
        &fake,
        crate::tree::walk::walker_fake::budget(10).with_max_raw_depth(1),
    );
    assert!(!outcome.tree.is_complete());

    let error = finish_observation(
        ObservationRoot::Window(&window),
        request,
        &adapter,
        CompletedWalk {
            chromium_root: false,
            outcome,
            walk_duration: Duration::ZERO,
        },
        |_| Err(window_identity_changed()),
    )
    .expect_err("a partial tree must not bypass root ownership verification");

    assert_eq!(error.code, ErrorCode::WindowNotFound);
}

/// Finding 4(c): activation state must not be a single global flag. Two
/// different processes observed sequentially through the same adapter each
/// get their own activation pass - the second must not inherit the first's
/// "already settled" state.
#[test]
fn two_different_pids_through_one_adapter_each_get_their_own_activation_pass() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let first = window_for(1, "gen-1");
    let second = window_for(2, "gen-1");
    let request = request_with(Deadline::after(5_000).unwrap(), false);

    let first_error = finish_observation(
        ObservationRoot::Window(&first),
        request,
        &adapter,
        CompletedWalk {
            chromium_root: true,
            outcome: small_complete_outcome(),
            walk_duration: Duration::ZERO,
        },
        |_| Ok(()),
    )
    .expect_err("a never-attempted process must be offered activation");
    assert!(first_error.requires_renderer_accessibility_activation());

    adapter
        .note_renderer_activation_attempted(root_process_identity(ObservationRoot::Window(&first)));

    let second_error = finish_observation(
        ObservationRoot::Window(&second),
        request,
        &adapter,
        CompletedWalk {
            chromium_root: true,
            outcome: small_complete_outcome(),
            walk_duration: Duration::ZERO,
        },
        |_| Ok(()),
    )
    .expect_err("a different process must not inherit another process's settle state");
    assert!(second_error.requires_renderer_accessibility_activation());
}

/// Finding 1: once a process's settle has run, a still-shell walk must keep
/// re-arming core's retry loop for as long as the deadline has room, rather
/// than surfacing the plain still-thin error after a single retry.
#[test]
fn a_still_shell_walk_with_generous_deadline_loops_the_marker_again() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    adapter.note_renderer_activation_attempted(root_process_identity(ObservationRoot::Window(
        &window,
    )));
    let request = request_with(Deadline::after(5_000).unwrap(), false);

    let error = finish_observation(
        ObservationRoot::Window(&window),
        request,
        &adapter,
        CompletedWalk {
            chromium_root: true,
            outcome: small_complete_outcome(),
            walk_duration: Duration::ZERO,
        },
        |_| Ok(()),
    )
    .expect_err("a still-thin shell must not silently succeed");

    assert!(
        error.requires_renderer_accessibility_activation(),
        "a generous remaining deadline must keep the settle looping"
    );
}

/// The dual of the case above: once the deadline is nearly exhausted, the
/// loop must stop and hand back the plain guidance error instead of
/// re-arming a retry that has no time left to run.
#[test]
fn a_still_shell_walk_with_an_exhausted_deadline_returns_the_guidance_error() {
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = window_for(1, "gen-1");
    adapter.note_renderer_activation_attempted(root_process_identity(ObservationRoot::Window(
        &window,
    )));
    let deadline = Deadline::after(1).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    let request = request_with(deadline, false);

    let error = finish_observation(
        ObservationRoot::Window(&window),
        request,
        &adapter,
        CompletedWalk {
            chromium_root: true,
            outcome: small_complete_outcome(),
            walk_duration: Duration::ZERO,
        },
        |_| Ok(()),
    )
    .expect_err("a still-thin shell must not silently succeed");

    assert!(
        !error.requires_renderer_accessibility_activation(),
        "an exhausted deadline must stop the loop with plain guidance instead of looping forever"
    );
    assert_eq!(error.code, ErrorCode::ActionFailed);
}

/// `walk_fault_error` only folds a failure's structured `details` into the
/// aggregate, never its `message`. Pinning that here means a marker string
/// planted in an upstream failure's message can never leak into the
/// aggregated error this crate hands to session trace segments.
#[test]
fn walk_fault_error_never_folds_a_failures_message_text_into_the_aggregate() {
    const MARKER: &str = "zzsecretmarkerzz";
    let failure = AdapterError::new(ErrorCode::ActionFailed, MARKER)
        .with_details(json!({ "kind": "child_enumeration_failed" }));

    let aggregated = walk_fault_error(&[failure]);

    assert!(!aggregated.message.contains(MARKER));
    let serialized = aggregated
        .details
        .as_ref()
        .map(serde_json::Value::to_string)
        .unwrap_or_default();
    assert!(!serialized.contains(MARKER));
}
