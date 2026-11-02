use super::*;
use std::thread;

#[test]
fn accepted_stream_waits_for_a_delayed_control() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path =
        std::path::Path::new("/tmp").join(format!("cd-{}-{unique:x}.sock", std::process::id()));
    let result = std::panic::catch_unwind(|| {
        let listener = UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut client = UnixStream::connect(&path).unwrap();
        let (stream, _) = listener.accept().unwrap();
        prepare_stream(&stream).unwrap();
        let sender = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            let control = CursorOverlayControl::hide("run-delayed".into());
            client
                .write_all(&serde_json::to_vec(&control).unwrap())
                .unwrap();
        });
        assert_eq!(read_control(stream).unwrap().session_id(), "run-delayed");
        sender.join().unwrap();
    });
    let _ = std::fs::remove_file(path);
    result.unwrap();
}

fn state(at: Option<Point>) -> OverlayState {
    OverlayState {
        at,
        ..OverlayState::default()
    }
}

fn screen() -> agent_desktop_core::Rect {
    agent_desktop_core::Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    }
}

fn instruction(destination: Point, click: bool) -> CursorOverlayInstruction {
    let config = CursorOverlayConfig::enabled(None, 6).expect("valid config");
    CursorOverlayInstruction::new(destination, &config, click).expect("valid instruction")
}

#[test]
fn sampled_motion_ends_at_the_requested_destination() {
    let destination = Point { x: 900.0, y: 500.0 };
    let frames = motion_frames(
        &state(None),
        &instruction(destination.clone(), false),
        &screen(),
        120,
    );

    assert_eq!(frames.last().map(|pose| &pose.point), Some(&destination));
    let biggest_step = frames
        .windows(2)
        .map(|pair| (pair[1].point.x - pair[0].point.x).hypot(pair[1].point.y - pair[0].point.y))
        .fold(0.0_f64, f64::max);
    assert!(frames.len() >= 20, "the path is sampled per frame");
    assert!(
        biggest_step < 40.0,
        "no visible jump between frames: {biggest_step}"
    );
}

#[test]
fn subsequent_motion_starts_from_the_previous_destination() {
    let start = Point { x: 200.0, y: 300.0 };
    let destination = Point { x: 900.0, y: 500.0 };
    let frames = motion_frames(
        &state(Some(start.clone())),
        &instruction(destination.clone(), false),
        &screen(),
        120,
    );

    assert_eq!(frames.first().map(|pose| &pose.point), Some(&start));
    assert_eq!(frames.last().map(|pose| &pose.point), Some(&destination));
}

#[test]
fn a_click_instruction_adds_ripple_frames_at_the_destination() {
    let destination = Point { x: 900.0, y: 500.0 };
    let moved = motion_frames(
        &state(None),
        &instruction(destination.clone(), false),
        &screen(),
        120,
    );
    let clicked = motion_frames(
        &state(None),
        &instruction(destination.clone(), true),
        &screen(),
        120,
    );

    assert!(clicked.len() > moved.len());
    assert!(clicked.iter().any(|pose| pose.ripple > 0.0));
    assert_eq!(clicked.last().map(|pose| &pose.point), Some(&destination));
}

#[test]
fn click_effect_returns_immediately_to_the_control_loop() {
    let destination = Point { x: 900.0, y: 500.0 };
    let effect =
        instruction(destination.clone(), true).with_phase(agent_desktop_core::CursorPhase::Effect);

    let frames = motion_frames(&state(Some(destination.clone())), &effect, &screen(), 120);

    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0], CursorPose::still(destination.clone()));
    assert_eq!(frames[1].point, destination);
    assert_eq!(frames[1].ripple, 1.0);
}

fn overlay_config() -> CursorOverlayConfig {
    CursorOverlayConfig::enabled(None, 6).expect("valid config")
}

fn drag_instruction(drag_from: Point, destination: Point) -> CursorOverlayInstruction {
    CursorOverlayInstruction::new(destination, &overlay_config(), false)
        .expect("valid instruction")
        .with_drag_from(Some(drag_from))
        .with_phase(agent_desktop_core::CursorPhase::Drag)
}

fn presented(session: &str, instruction: CursorOverlayInstruction) -> CursorOverlayControl {
    CursorOverlayControl::present(session.into(), instruction)
}

#[test]
fn hide_clears_the_remembered_landing_for_the_next_travel() {
    let mut remembered = state(Some(Point { x: 100.0, y: 100.0 }));
    let control = CursorOverlayControl::hide("run-failed-drag".into());

    apply_landing_memory(&control, &mut remembered, None);

    assert_eq!(remembered.at, None);
}

#[test]
fn show_leaves_the_remembered_landing_unchanged() {
    let previous = Point { x: 100.0, y: 100.0 };
    let mut remembered = state(Some(previous.clone()));
    let control = CursorOverlayControl::show("run-resume".into());

    apply_landing_memory(&control, &mut remembered, None);

    assert_eq!(remembered.at, Some(previous));
}

#[test]
fn drag_phase_pins_the_remembered_landing_to_the_grab_origin() {
    let drag_from = Point { x: 100.0, y: 100.0 };
    let instruction = drag_instruction(drag_from.clone(), Point { x: 500.0, y: 400.0 });
    let control = presented("run-drag", instruction.clone());
    let mut remembered = state(None);

    apply_landing_memory(&control, &mut remembered, Some(&instruction));

    assert_eq!(remembered.at, Some(drag_from));
}

#[test]
fn drag_phase_without_a_grab_origin_remembers_the_destination() {
    let destination = Point { x: 500.0, y: 400.0 };
    let instruction = CursorOverlayInstruction::new(destination.clone(), &overlay_config(), false)
        .expect("valid instruction")
        .with_phase(agent_desktop_core::CursorPhase::Drag);
    let control = presented("run-drag", instruction.clone());
    let mut remembered = state(None);

    apply_landing_memory(&control, &mut remembered, Some(&instruction));

    assert_eq!(remembered.at, Some(destination));
}

#[test]
fn travel_phase_remembers_the_destination_as_the_landing() {
    let destination = Point { x: 800.0, y: 300.0 };
    let instruction = instruction(destination.clone(), false);
    let control = presented("run-travel", instruction.clone());
    let mut remembered = state(None);

    apply_landing_memory(&control, &mut remembered, Some(&instruction));

    assert_eq!(remembered.at, Some(destination));
}

#[test]
fn effect_phase_remembers_the_destination_as_the_landing() {
    let destination = Point { x: 800.0, y: 300.0 };
    let instruction =
        instruction(destination.clone(), false).with_phase(agent_desktop_core::CursorPhase::Effect);
    let control = presented("run-effect", instruction.clone());
    let mut remembered = state(None);

    apply_landing_memory(&control, &mut remembered, Some(&instruction));

    assert_eq!(remembered.at, Some(destination));
}

#[test]
fn travel_after_a_failed_drag_starts_near_the_new_destination_not_the_stale_grab_origin() {
    let screen = screen();
    let drag_from = Point { x: 100.0, y: 100.0 };
    let new_destination = Point { x: 800.0, y: 300.0 };

    let drag = drag_instruction(drag_from.clone(), Point { x: 500.0, y: 400.0 });
    let drag_control = presented("run-failed-drag", drag.clone());
    let mut remembered = state(None);

    apply_landing_memory(&drag_control, &mut remembered, Some(&drag));
    assert_eq!(remembered.at, Some(drag_from.clone()));

    let hide_control = CursorOverlayControl::hide("run-failed-drag".into());
    apply_landing_memory(&hide_control, &mut remembered, None);

    let fresh_travel = instruction(new_destination.clone(), false);
    let frames = motion_frames(&remembered, &fresh_travel, &screen, 120);

    let fresh_entry = Point {
        x: (new_destination.x - 180.0).clamp(screen.x, screen.x + screen.width),
        y: (new_destination.y + 108.0).clamp(screen.y, screen.y + screen.height),
    };
    assert_eq!(frames.first().map(|pose| &pose.point), Some(&fresh_entry));
    assert_ne!(frames.first().map(|pose| &pose.point), Some(&drag_from));
    assert_eq!(
        frames.last().map(|pose| &pose.point),
        Some(&new_destination)
    );
}

#[test]
fn travel_after_a_successful_drag_animates_from_the_drag_destination() {
    let screen = screen();
    let drag_from = Point { x: 100.0, y: 100.0 };
    let drag_destination = Point { x: 500.0, y: 400.0 };
    let new_destination = Point { x: 800.0, y: 300.0 };

    let drag = drag_instruction(drag_from.clone(), drag_destination.clone());
    let drag_control = presented("run-drag", drag.clone());
    let mut remembered = state(None);
    apply_landing_memory(&drag_control, &mut remembered, Some(&drag));
    assert_eq!(remembered.at, Some(drag_from.clone()));

    let effect = CursorOverlayInstruction::new(drag_destination.clone(), &overlay_config(), false)
        .expect("valid instruction")
        .with_drag_from(Some(drag_from))
        .with_phase(agent_desktop_core::CursorPhase::Effect);
    let effect_control = presented("run-drag", effect.clone());
    apply_landing_memory(&effect_control, &mut remembered, Some(&effect));
    assert_eq!(remembered.at, Some(drag_destination.clone()));

    let fresh_travel = instruction(new_destination.clone(), false);
    let frames = motion_frames(&remembered, &fresh_travel, &screen, 120);

    assert_eq!(
        frames.first().map(|pose| &pose.point),
        Some(&drag_destination)
    );
    assert_eq!(
        frames.last().map(|pose| &pose.point),
        Some(&new_destination)
    );
}
