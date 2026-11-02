use super::completed;
use crate::system::cursor_overlay::monitors::OverlayMonitor;
use agent_desktop_core::Rect;

fn monitor() -> OverlayMonitor {
    OverlayMonitor {
        bounds: Rect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        },
        work_area: Rect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1040.0,
        },
        scale: 1.0,
        is_primary: true,
    }
}

/// The ordinary case: a walk that finished answers what it saw.
#[test]
fn a_completed_walk_answers_the_monitors_it_collected() {
    let collected = vec![monitor(), monitor()];

    assert_eq!(completed(1, collected).len(), 2);
}

/// The defect this guards is a partial list being adopted as the desktop. A
/// walk stops on the first monitor whose info cannot be read, so the monitors
/// it had already collected are a strict subset of the real desktop - and a
/// cursor standing on the one that dropped out would map to the fallback
/// screen and draw somewhere else entirely, with nothing reporting it.
#[test]
fn a_walk_that_stopped_early_answers_nothing_rather_than_a_subset() {
    let collected = vec![monitor(), monitor()];

    assert!(
        completed(0, collected).is_empty(),
        "a partial desktop must not be handed back as the whole desktop"
    );
}

/// The empty answer has to be reachable from a failed walk that collected
/// nothing too, or the caller would tell the two apart by length and act on
/// a distinction that does not exist.
#[test]
fn a_walk_that_failed_before_collecting_anything_answers_the_same_way() {
    assert!(completed(0, Vec::new()).is_empty());
}
