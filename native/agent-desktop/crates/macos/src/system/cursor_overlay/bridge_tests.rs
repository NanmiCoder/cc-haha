use super::*;
use agent_desktop_core::CursorOverlayConfig;

fn instruction(phase: CursorPhase, pointer: bool) -> CursorOverlayInstruction {
    let config = CursorOverlayConfig::enabled(None, 6).expect("valid config");
    CursorOverlayInstruction::new(Point { x: 5.0, y: 5.0 }, &config, false)
        .expect("valid instruction")
        .with_phase(phase)
        .with_pointer(pointer)
}

#[test]
fn travel_departs_as_the_arrow_and_arrives_as_the_pointer_only_when_asked() {
    assert_eq!(
        pointer_flags(&instruction(CursorPhase::Travel, true)),
        ARROW_ON_DEPARTURE | POINT_ON_ARRIVAL
    );
    assert_eq!(
        pointer_flags(&instruction(CursorPhase::Travel, false)),
        ARROW_ON_DEPARTURE
    );
}

#[test]
fn drags_use_the_arrow_and_effects_return_to_it() {
    assert_eq!(
        pointer_flags(&instruction(CursorPhase::Drag, true)),
        ARROW_ON_DEPARTURE
    );
    assert_eq!(
        pointer_flags(&instruction(CursorPhase::Effect, true)),
        ARROW_AFTER_EFFECT
    );
    assert_eq!(
        pointer_flags(&instruction(CursorPhase::Effect, false)),
        ARROW_AFTER_EFFECT
    );
}

#[test]
fn pointer_flags_do_not_collide_with_render_flags() {
    let all = [
        REDUCE_MOTION,
        HIGHLIGHT,
        POINT_ON_ARRIVAL,
        ARROW_ON_DEPARTURE,
        ARROW_AFTER_EFFECT,
    ];
    for (index, flag) in all.iter().enumerate() {
        for other in &all[index + 1..] {
            assert_eq!(flag & other, 0);
        }
    }
}

#[test]
fn both_caret_phases_draw_only_the_caret_and_leave_the_pointer_alone() {
    for phase in [CursorPhase::Caret, CursorPhase::CaretFollow] {
        assert!(is_caret(&instruction(phase, true)), "{phase:?}");
        assert_eq!(pointer_flags(&instruction(phase, true)), 0, "{phase:?}");
    }
    for phase in [CursorPhase::Travel, CursorPhase::Drag, CursorPhase::Effect] {
        assert!(!is_caret(&instruction(phase, false)), "{phase:?}");
    }
}
