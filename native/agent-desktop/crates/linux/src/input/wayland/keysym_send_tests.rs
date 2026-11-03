use super::*;
use crate::input::wayland::fake_session::FakeSession;
use agent_desktop_core::ErrorCode;

const CONTROL_L: u32 = 0xffe3;
const KEY_A: u32 = 0x61;

fn live() -> Deadline {
    Deadline::after(5_000).expect("a five second deadline builds")
}

fn tap(keysym: u32) -> [KeysymStep; 2] {
    [edge(keysym, true), edge(keysym, false)]
}

fn edge(keysym: u32, down: bool) -> KeysymStep {
    KeysymStep { keysym, down }
}

fn ctrl_a() -> Vec<KeysymStep> {
    vec![
        edge(CONTROL_L, true),
        edge(KEY_A, true),
        edge(KEY_A, false),
        edge(CONTROL_L, false),
    ]
}

#[test]
fn received_key_with_lost_reply_is_uncertain_and_cannot_replay() {
    let keys = tap(KEY_A);
    let mut session = FakeSession::failing_on("down:61");
    session.resumed = true;
    let error = run_chunks(&mut session, &[&keys], &mut || Ok(()), live())
        .expect_err("the first key arrived but its reply was lost");
    assert_eq!(session.arrived, [(KEY_A, true)]);
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    assert!(!sent_nothing(&error), "a reused session must not replay");
    assert!(
        error
            .suggestion
            .as_deref()
            .is_some_and(|s| s.contains("before retrying"))
    );
    let details = error.details.expect("delivery evidence");
    assert_eq!(details["physical_delivery_started"], true);
    assert_eq!(details["delivered_events"], 0);

    let mut unattempted = FakeSession::new();
    unattempted.resumed = true;
    let expired = Deadline::after(0).expect("zero deadline builds");
    let error = run_chunks(&mut unattempted, &[&keys], &mut || Ok(()), expired)
        .expect_err("deadline prevents dispatch");
    assert!(unattempted.arrived.is_empty());
    assert!(sent_nothing(&error));
}

#[test]
fn delivery_lifecycle_and_failures() {
    let keys = ctrl_a();
    let mut session = FakeSession::new();
    let log = session.log();
    let mut gate = || {
        log.borrow_mut().push("gate".into());
        Ok(())
    };
    let delivery = run_chunks(&mut session, &[&keys], &mut gate, live()).expect("keys deliver");
    assert_eq!(delivery.delivered_events, 4);
    let events = session.events();
    let position = |label: &str| events.iter().position(|event| event == label).unwrap();
    assert_eq!(&events[..2], ["create", "start"]);
    assert!(position("down:ffe1") < position("up:ffe1"));
    assert!(position("gate") < position("down:ffe1"));
    assert!(events[position("up:ffe1") + 1..position("down:ffe3")].contains(&"gate".into()));
    assert!(position("gate") < position("down:ffe3"));
    assert!(position("down:ffe3") < position("down:61"));
    assert!(position("down:61") < position("up:61"));
    assert!(position("up:61") < position("up:ffe3"));
    assert_eq!(events.last().map(String::as_str), Some("stop"));

    for (failure, count, attempted) in [
        ("create", 0, false),
        ("start", 0, false),
        ("down:ffe1", 0, true),
        ("down:ffe3", 2, true),
        ("down:61", 3, true),
        ("up:ffe3", 5, true),
    ] {
        let mut failed = FakeSession::failing_on(failure);
        let error =
            run_chunks(&mut failed, &[&keys], &mut || Ok(()), live()).expect_err("step fails");
        assert_eq!(error.code, ErrorCode::Internal, "{failure}");
        assert_eq!(
            error.disposition,
            if attempted {
                DeliverySemantics::uncertain()
            } else {
                DeliverySemantics::not_delivered()
            },
            "{failure}"
        );
        let details = error.details.expect("progress evidence");
        assert_eq!(details["physical_delivery_started"], attempted, "{failure}");
        if attempted {
            assert_eq!(details["delivered_events"], count, "{failure}");
        }
        let events = failed.events();
        assert_eq!(
            events.last().map(String::as_str),
            Some(if failure == "create" {
                "create"
            } else {
                "stop"
            }),
            "{failure}"
        );
    }

    let mut timeout = FakeSession::new();
    let expired = Deadline::after(0).expect("zero deadline builds");
    let error = run_chunks(&mut timeout, &[&keys], &mut || Ok(()), expired).expect_err("expired");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(
        error.details.expect("no delivery evidence")["physical_delivery_started"],
        false
    );
    assert_eq!(timeout.events(), vec!["create", "stop"]);

    let mut gate_failure = FakeSession::new();
    let gate_error = run_chunks(
        &mut gate_failure,
        &[&keys],
        &mut || {
            Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "window is not active",
            ))
        },
        live(),
    )
    .expect_err("gate refuses");
    assert_eq!(gate_error.message, "window is not active");
    assert_eq!(gate_error.disposition, DeliverySemantics::not_delivered());
    assert!(gate_failure.arrived.is_empty());
    assert_eq!(
        gate_failure.events().last().map(String::as_str),
        Some("stop")
    );

    let mut release_failure = FakeSession::failing_on("up:61");
    let error = run_chunks(&mut release_failure, &[&keys], &mut || Ok(()), live())
        .expect_err("release fails");
    assert_eq!(error.code, ErrorCode::Internal);
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    assert_eq!(
        error.details.expect("delivered prefix")["delivered_events"],
        4
    );
    let events = release_failure.events();
    let last = &events[events.len() - 3..];
    assert_eq!(last, ["up:61", "up:ffe3", "stop"]);

    let mut gate_timeout = FakeSession::new();
    let expired = Deadline::after(0).expect("zero deadline builds");
    let error = run_chunks(
        &mut gate_timeout,
        &[&keys],
        &mut || Err(expired.timeout_error()),
        live(),
    )
    .expect_err("gate times out");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(
        error.details.expect("details")["physical_delivery_started"],
        false
    );
}

#[test]
fn first_real_key_survives_compositor_drop() {
    let keys = ctrl_a();
    let mut session = FakeSession::new();
    session.drops_first_key = true;
    run_chunks(&mut session, &[&keys], &mut || Ok(()), live()).expect("keys deliver");
    let real: Vec<(u32, bool)> = keys.iter().map(|key| (key.keysym, key.down)).collect();
    assert_eq!(
        &session.arrived[session.arrived.len() - real.len()..],
        real.as_slice()
    );
    assert_eq!(session.arrived.len(), real.len() + 1);
}

#[test]
fn chunks_preserve_progress() {
    let first = tap(KEY_A);
    let second = tap(0x62);
    let mut session = FakeSession::failing_on("down:62");
    let error = run_chunks(&mut session, &[&first, &second], &mut || Ok(()), live())
        .expect_err("second chunk fails");
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    assert!(!sent_nothing(&error));
    let details = error.details.expect("delivery details");
    assert_eq!(details["physical_delivery_started"], true);
    assert_eq!(details["delivered_events"], 4);

    let mut session = FakeSession::new();
    let log = session.log();
    let mut gate = || {
        if log.borrow().iter().any(|event| event == "up:61") {
            Err(AdapterError::new(ErrorCode::ActionFailed, "window lost"))
        } else {
            Ok(())
        }
    };
    let error = run_chunks(&mut session, &[&first, &second], &mut gate, live())
        .expect_err("gate stops later chunk");
    assert!(error.message.contains("4 keyboard events were confirmed"));
    assert_eq!(
        error.details.expect("delivery details")["delivered_events"],
        4
    );
}

#[test]
fn refusal_after_bootstrap_reports_the_sent_keys_in_message_and_evidence() {
    let keys = tap(KEY_A);
    let mut session = FakeSession::new();
    let log = session.log();
    let mut gate = || {
        if log.borrow().iter().any(|event| event == "up:ffe1") {
            Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "The target window is not active, so no key was sent",
            )
            .with_details(json!({ "cause": "not_active", "physical_delivery_started": false }))
            .with_disposition(DeliverySemantics::not_delivered()))
        } else {
            Ok(())
        }
    };
    let error = run_chunks(&mut session, &[&keys], &mut gate, live()).unwrap_err();
    assert_eq!(
        session.arrived,
        [(KEYSYM_SHIFT_L, true), (KEYSYM_SHIFT_L, false)]
    );
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(error.message.contains("2 keyboard events were confirmed"));
    assert!(error.message.contains("bootstrap"));
    assert!(!error.message.contains("no key was sent"));
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    let details = error.details.unwrap();
    assert_eq!(details["cause"], "not_active");
    assert_eq!(details["physical_delivery_started"], true);
    assert_eq!(details["delivered_events"], 2);
}

#[test]
fn focus_loss_inside_a_text_chunk_stops_before_the_next_key_down() {
    let keys = [tap(KEY_A), tap(0x62)].concat();
    let mut session = FakeSession::new();
    session.resumed = true;
    let log = session.log();
    let mut gate = || {
        if log.borrow().iter().any(|event| event == "up:61") {
            Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "target focus lost",
            ))
        } else {
            Ok(())
        }
    };
    let error = run_chunks(&mut session, &[&keys], &mut gate, live()).unwrap_err();
    assert_eq!(session.arrived, [(KEY_A, true), (KEY_A, false)]);
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    assert_eq!(error.details.unwrap()["delivered_events"], 2);
}

#[test]
fn retained_session_lifecycle() {
    let keys = tap(KEY_A);
    let mut retained = FakeSession::new();
    retained.retains = true;
    run_chunks(&mut retained, &[&keys], &mut || Ok(()), live()).expect("delivers");
    assert!(!retained.events().iter().any(|event| event == "stop"));

    let mut resumed = FakeSession::new();
    resumed.resumed = true;
    resumed.retains = true;
    run_chunks(&mut resumed, &[&keys], &mut || Ok(()), live()).expect("resumes");
    let events = resumed.events();
    assert_eq!(events.len(), 2);
    assert!(events.contains(&"down:61".into()) && events.contains(&"up:61".into()));

    let mut failed = FakeSession::failing_on("down:ffe1");
    failed.retains = true;
    run_chunks(&mut failed, &[&keys], &mut || Ok(()), live()).expect_err("fails");
    assert_eq!(failed.events().last().map(String::as_str), Some("stop"));
}

#[test]
fn success_drains_and_refusal_is_private() {
    let keys = tap(KEY_A);
    let mut session = FakeSession::new();
    let started = std::time::Instant::now();
    run_chunks(&mut session, &[&keys], &mut || Ok(()), live()).expect("delivers");
    assert!(started.elapsed() >= DRAIN);

    let mut failing = FakeSession::failing_on("down:61");
    let error = run_chunks(&mut failing, &[&keys], &mut || Ok(()), live()).expect_err("fails");
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    assert_eq!(
        error.details.expect("delivery evidence")["physical_delivery_started"],
        true
    );
    let events = failing.events();
    assert_eq!(&events[events.len() - 2..], ["down:61", "stop"]);

    let outside = tap(0x0100_4f60);
    let error =
        send_chunks(&[outside.to_vec()], &mut || Ok(()), live()).expect_err("layout refuses");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let rendered = format!("{error:?}");
    assert!(!rendered.contains("4f60") && !rendered.contains("你"));

    let empty = send_chunks(&[], &mut || Ok(()), live()).expect("empty input is a no-op");
    assert_eq!(empty.delivered_events, 0);
}
