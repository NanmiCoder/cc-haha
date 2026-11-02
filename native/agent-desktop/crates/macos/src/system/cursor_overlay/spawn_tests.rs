use super::*;
use std::os::unix::net::UnixListener;

#[test]
fn travel_acknowledgement_obeys_remaining_budget() {
    let error = unacknowledged_failure(agent_desktop_core::CursorPhase::Travel);

    assert_eq!(
        error.message,
        "macOS cursor overlay did not confirm cursor arrival"
    );
}

#[test]
fn drag_requires_acknowledgement_before_tracking_is_considered_ready() {
    let error = unacknowledged_failure(agent_desktop_core::CursorPhase::Drag);

    assert_eq!(
        error.message,
        "macOS cursor overlay did not acknowledge the control"
    );
}

#[test]
fn effect_requires_acknowledgement_before_it_is_considered_delivered() {
    let error = unacknowledged_failure(agent_desktop_core::CursorPhase::Effect);

    assert_eq!(
        error.message,
        "macOS cursor overlay did not confirm cursor effect"
    );
}

fn unacknowledged_failure(phase: agent_desktop_core::CursorPhase) -> AdapterError {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::path::PathBuf::from(format!(
        "/tmp/ca-{}-{unique:x}-{phase:?}.sock",
        std::process::id()
    ));
    let result = std::panic::catch_unwind(|| {
        let listener = UnixListener::bind(&path).unwrap();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let receiver = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut payload = Vec::new();
            stream.read_to_end(&mut payload).unwrap();
            released.recv_timeout(Duration::from_secs(10)).is_ok()
        });
        let instruction = agent_desktop_core::CursorOverlayInstruction::new(
            agent_desktop_core::Point { x: 10.0, y: 20.0 },
            &agent_desktop_core::CursorOverlayConfig::enabled(None, 8).unwrap(),
            false,
        )
        .unwrap()
        .with_phase(phase);
        let control = CursorOverlayControl::present("run-budget".into(), instruction);
        let started = Instant::now();
        let error = send_until(&path, &control, started + Duration::from_millis(30))
            .expect_err("an unacknowledged control must fail");
        release.send(()).unwrap();
        assert!(
            receiver.join().unwrap(),
            "send_until must give up on its own deadline, not when the receiver lets go"
        );
        error
    });
    let _ = std::fs::remove_file(path);
    result.unwrap()
}
