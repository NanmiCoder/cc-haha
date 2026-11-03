use super::super::{
    CursorOverlayConfig, CursorOverlayControl, CursorOverlayInstruction, CursorPhase,
};

#[test]
fn a_caret_instruction_round_trips_through_the_overlay_transport() {
    let config = CursorOverlayConfig::enabled(None, 6).expect("valid config");
    let caret = crate::Rect {
        x: 50.0,
        y: 78.0,
        width: 2.0,
        height: 25.0,
    };
    let instruction =
        CursorOverlayInstruction::new(crate::Point { x: 50.0, y: 90.5 }, &config, false)
            .expect("valid instruction")
            .with_target(Some(caret))
            .with_phase(CursorPhase::Caret);
    let control = CursorOverlayControl::present_with_style(
        "run-1".into(),
        instruction,
        config.style().clone(),
    );
    let wire = serde_json::to_vec(&control).expect("encodes");
    let decoded: CursorOverlayControl = serde_json::from_slice(&wire).expect("decodes");
    assert_eq!(decoded, control);
    assert!(decoded.expects_acknowledgement());
}
