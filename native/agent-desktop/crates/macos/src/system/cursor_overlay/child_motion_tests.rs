use super::*;

fn screen() -> agent_desktop_core::Rect {
    agent_desktop_core::Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    }
}

fn tuned() -> CursorMotionProfile {
    let mut motion = CursorMotionProfile::default();
    motion.set_travel_ms(400, 600);
    motion.set_dwell_ms(100);
    motion.set_seed(Some(7));
    motion
}

fn travel(destination: Point) -> CursorOverlayInstruction {
    let config = CursorOverlayConfig::enabled(None, 6).expect("valid config");
    CursorOverlayInstruction::new(destination, &config, false).expect("valid instruction")
}

fn present(instruction: CursorOverlayInstruction) -> CursorOverlayControl {
    CursorOverlayControl::present_with_style("run".into(), instruction, Default::default())
        .with_motion(tuned())
}

#[test]
fn motion_from_a_control_reaches_the_renderer_state() {
    let mut state = OverlayState::default();
    let control = present(travel(Point { x: 10.0, y: 10.0 }));
    assert!(absorb_settings(&control, &mut state).is_some());
    assert_eq!(state.motion, tuned());
    let enable = CursorOverlayControl::enable("run".into(), Default::default());
    assert!(absorb_settings(&enable, &mut state).is_some());
    assert!(state.motion.is_default());
    let hide = CursorOverlayControl::hide("run".into());
    state.motion = tuned();
    assert!(absorb_settings(&hide, &mut state).is_none());
    assert_eq!(state.motion, tuned());
}

#[test]
fn frames_cover_travel_and_dwell_at_every_refresh_rate() {
    let destination = Point {
        x: 1_500.0,
        y: 900.0,
    };
    let state = OverlayState {
        motion: tuned(),
        moves: 3,
        at: Some(Point { x: 100.0, y: 100.0 }),
        ..OverlayState::default()
    };
    let motion = CursorMotion::shaped(
        Point { x: 100.0, y: 100.0 },
        destination.clone(),
        &tuned(),
        3,
    );
    let settled = motion.duration_ms() + motion.dwell_ms();
    for fps in [60_u32, 120] {
        let frames = frames_for(&state, &travel(destination.clone()), &screen(), fps, false);
        let expected = (settled as f64 / (1_000.0 / f64::from(fps))).ceil() as usize + 1;
        assert_eq!(frames.len(), expected, "{fps} fps");
        let frame_ms = 1_000.0 / f64::from(fps);
        let dwell_frames = frames
            .iter()
            .rev()
            .take_while(|pose| pose.point == destination)
            .count();
        assert!(dwell_frames as f64 * frame_ms >= 100.0, "{fps} fps dwell");
    }
}

#[test]
fn reduce_motion_draws_one_still_pose_for_any_profile() {
    let destination = Point { x: 700.0, y: 300.0 };
    let state = OverlayState {
        motion: tuned(),
        at: Some(Point { x: 0.0, y: 0.0 }),
        ..OverlayState::default()
    };
    let frames = frames_for(&state, &travel(destination.clone()), &screen(), 120, true);
    assert_eq!(frames, vec![CursorPose::still(destination)]);
}

#[test]
fn moves_advance_only_on_travel_presents() {
    let mut state = OverlayState::default();
    let destination = Point { x: 50.0, y: 50.0 };
    advance_moves(&present(travel(destination.clone())), &mut state);
    assert_eq!(state.moves, 1);
    let effect = travel(destination.clone()).with_phase(CursorPhase::Effect);
    advance_moves(&present(effect), &mut state);
    let drag = travel(destination.clone())
        .with_drag_from(Some(destination))
        .with_phase(CursorPhase::Drag);
    advance_moves(&present(drag), &mut state);
    advance_moves(
        &CursorOverlayControl::enable("run".into(), Default::default()),
        &mut state,
    );
    advance_moves(&CursorOverlayControl::hide("run".into()), &mut state);
    assert_eq!(state.moves, 1);
}

#[test]
fn seeded_renderer_moves_differ_from_one_travel_to_the_next() {
    let destination = Point {
        x: 1_200.0,
        y: 700.0,
    };
    let mut state = OverlayState {
        motion: tuned(),
        at: Some(Point { x: 100.0, y: 100.0 }),
        ..OverlayState::default()
    };
    let first = frames_for(&state, &travel(destination.clone()), &screen(), 120, false);
    state.moves += 1;
    let second = frames_for(&state, &travel(destination.clone()), &screen(), 120, false);
    assert_ne!(first, second);
    assert_eq!(first.last(), second.last());
}

#[test]
fn enable_restarts_the_seeded_move_sequence() {
    let mut state = OverlayState {
        moves: 9,
        ..OverlayState::default()
    };
    absorb_settings(&present(travel(Point { x: 1.0, y: 1.0 })), &mut state);
    assert_eq!(state.moves, 9, "a present keeps the sequence going");
    absorb_settings(
        &CursorOverlayControl::enable("run".into(), Default::default()).with_motion(tuned()),
        &mut state,
    );
    assert_eq!(
        state.moves, 0,
        "enable replays the seed from its first move"
    );
}
