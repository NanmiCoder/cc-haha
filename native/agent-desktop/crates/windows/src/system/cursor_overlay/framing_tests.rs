use super::{MAX_CONTROL_BYTES, decode, encode, is_acknowledged, may_spawn};
use agent_desktop_core::{
    CursorOverlayConfig, CursorOverlayControl, CursorOverlayInstruction, CursorOverlayStyle,
    CursorPhase, Point,
};

fn session() -> String {
    "s0000001".to_owned()
}

fn instruction(click: bool, phase: CursorPhase) -> CursorOverlayInstruction {
    let config = CursorOverlayConfig::enabled(Some("open the file".into()), 6)
        .expect("an enabled overlay config");
    CursorOverlayInstruction::new(Point { x: 120.0, y: 240.0 }, &config, click)
        .expect("an instruction with a valid destination")
        .with_phase(phase)
}

#[test]
fn a_control_round_trips_unchanged() {
    let control = CursorOverlayControl::present(session(), instruction(true, CursorPhase::Travel));

    let decoded = decode(&encode(&control).expect("encodes")).expect("decodes");

    assert_eq!(decoded, control);
}

#[test]
fn every_variant_round_trips() {
    for control in [
        CursorOverlayControl::enable(session(), CursorOverlayStyle::default()),
        CursorOverlayControl::present(session(), instruction(false, CursorPhase::Effect)),
        CursorOverlayControl::hide(session()),
        CursorOverlayControl::show(session()),
        CursorOverlayControl::disable(session()),
    ] {
        let decoded = decode(&encode(&control).expect("encodes")).expect("decodes");
        assert_eq!(decoded, control);
    }
}

#[test]
fn motion_and_images_decode_and_validate_without_loading_files() {
    let bytes = br#"{
        "action":"enable","session_id":"s0000001","label":"hello",
        "motion":{"travel_min_ms":100,"travel_max_ms":400,"bow":2.0,
            "overshoot":0.1,"tremor":2.0,"dwell_ms":100,"seed":42},
        "style":{"images":{
            "arrow":{"path":"C:\\missing\\cursor.png","hotspot":{"x":4.0,"y":2.0}},
            "pointer":{"path":"C:\\missing\\hand.png","hotspot":{"x":8.0,"y":0.0}}
        }}
    }"#;
    let control = decode(bytes).expect("new presentation keys decode");
    control
        .validate()
        .expect("missing artwork is not a protocol error");
    let motion = control.motion().expect("motion profile");
    assert_eq!(motion.travel_ms(), (100, 400));
    assert_eq!(motion.bow(), 2.0);
    assert_eq!(motion.overshoot(), 0.1);
    assert_eq!(motion.tremor(), 2.0);
    assert_eq!(motion.dwell_ms(), 100);
    assert_eq!(motion.seed(), Some(42));
    let style = control.style().expect("style");
    assert_eq!(
        style.image().expect("arrow").hotspot(),
        &Point { x: 4.0, y: 2.0 }
    );
    assert_eq!(
        style.pointer_image().expect("pointer").hotspot(),
        &Point { x: 8.0, y: 0.0 }
    );
}

#[test]
fn an_oversized_payload_is_refused_rather_than_truncated() {
    let oversized = vec![b'x'; MAX_CONTROL_BYTES + 1];

    let error = decode(&oversized).expect_err("an oversized control is refused");

    assert_eq!(error.code, agent_desktop_core::ErrorCode::InvalidArgs);
}

#[test]
fn a_payload_that_is_not_a_control_is_refused() {
    assert!(decode(b"{\"action\":\"unknown\"}").is_err());
    assert!(decode(b"not json at all").is_err());
}

/// The enable is acknowledged and macOS's send path does not acknowledge it.
/// `data.rendered` is answered from that byte, and the stdin bootstrap that
/// starts the child cannot answer anything, so the divergence is the point.
#[test]
fn the_controls_a_caller_waits_on_are_the_ones_that_answer_something() {
    assert!(is_acknowledged(&CursorOverlayControl::enable(
        session(),
        CursorOverlayStyle::default()
    )));
    assert!(is_acknowledged(&CursorOverlayControl::disable(session())));
    assert!(is_acknowledged(&CursorOverlayControl::hide(session())));
    assert!(is_acknowledged(&CursorOverlayControl::present(
        session(),
        instruction(true, CursorPhase::Travel)
    )));

    assert!(
        !is_acknowledged(&CursorOverlayControl::present(
            session(),
            instruction(true, CursorPhase::Effect)
        )),
        "an effect plays after dispatch has already confirmed, so waiting on it adds latency \
         to nothing"
    );
    assert!(!is_acknowledged(&CursorOverlayControl::show(session())));
}

/// A disable that spawned a renderer would start one in order to tell it to
/// stop, and hide/show are sent around every mutating command in a headed
/// session - which would fork a detached renderer per command.
#[test]
fn only_an_enable_or_a_present_may_bring_a_renderer_into_existence() {
    assert!(may_spawn(&CursorOverlayControl::enable(
        session(),
        CursorOverlayStyle::default()
    )));
    assert!(may_spawn(&CursorOverlayControl::present(
        session(),
        instruction(false, CursorPhase::Travel)
    )));

    assert!(!may_spawn(&CursorOverlayControl::disable(session())));
    assert!(!may_spawn(&CursorOverlayControl::hide(session())));
    assert!(!may_spawn(&CursorOverlayControl::show(session())));
}
