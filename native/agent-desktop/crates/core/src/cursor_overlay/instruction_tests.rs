use super::{CursorOverlayConfig, CursorOverlayInstruction, CursorPhase};
use crate::Point;

fn instruction(x: f64, phase: CursorPhase) -> CursorOverlayInstruction {
    let config = CursorOverlayConfig::enabled(None, 6).expect("valid config");
    CursorOverlayInstruction::new(Point { x, y: 50.0 }, &config, false)
        .expect("valid instruction")
        .with_phase(phase)
}

#[test]
fn a_travel_somewhere_else_departs_and_one_that_stays_put_does_not() {
    let at = Point { x: 100.0, y: 50.0 };

    assert!(instruction(140.0, CursorPhase::Travel).departs_from(Some(&at)));
    assert!(!instruction(101.0, CursorPhase::Travel).departs_from(Some(&at)));
    assert!(instruction(101.0, CursorPhase::Travel).departs_from(None));
}

#[test]
fn only_travels_and_drags_depart() {
    let at = Point { x: 100.0, y: 50.0 };
    for phase in [CursorPhase::Effect, CursorPhase::Caret] {
        assert!(
            !instruction(400.0, phase).departs_from(Some(&at)),
            "{phase:?}"
        );
    }
    let drag = instruction(400.0, CursorPhase::Drag).with_drag_from(Some(at.clone()));
    assert!(
        !drag.departs_from(Some(&at)),
        "a drag sets off from its origin, where the cursor already is"
    );
}
