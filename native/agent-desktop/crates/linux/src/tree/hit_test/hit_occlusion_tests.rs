use super::*;
use crate::system::x11::FrameExtents;
use crate::tree::hit_test::tests::{rect, stacked, windowing};

const TARGET: u32 = 10;
const POINT: (i32, i32) = (310, 154);

fn read(stack: Vec<StackedWindow>) -> StackingSnapshot {
    let mut snapshot = windowing((100, 100), vec![]).snapshot;
    snapshot.stack = stack;
    snapshot
}

fn target() -> StackedWindow {
    stacked(TARGET, rect(100, 100, 400, 300))
}

#[test]
fn managed_stack_and_desktop_contract() {
    let cover = stacked(20, rect(200, 100, 400, 300));
    assert!(matches!(
        occlusion(&read(vec![cover.clone()]), TARGET, POINT),
        Occlusion::Unknown
    ));
    assert_eq!(
        occlusion(&read(vec![cover.clone(), target()]), TARGET, POINT),
        Occlusion::Clear
    );
    assert_eq!(
        occlusion(&read(vec![target(), cover.clone()]), TARGET, POINT),
        Occlusion::CoveredBy {
            window: 20,
            frame: rect(200, 100, 400, 300)
        }
    );

    let mut hidden = cover.clone();
    hidden.flags.hidden = true;
    let mut unmapped = cover.clone();
    unmapped.flags.mapped = false;
    let mut away = cover.clone();
    away.desktop = DesktopPlacement::On(1);
    let mut sticky = cover.clone();
    sticky.desktop = DesktopPlacement::Sticky;
    let mut desktop = cover.clone();
    desktop.kind = WindowKind::Desktop;
    for ignored in [hidden, unmapped, away, desktop] {
        assert_eq!(
            occlusion(&read(vec![target(), ignored]), TARGET, POINT),
            Occlusion::Clear
        );
    }
    assert!(matches!(
        occlusion(&read(vec![target(), sticky]), TARGET, POINT),
        Occlusion::CoveredBy { window: 20, .. }
    ));

    let mut unknown = cover.clone();
    unknown.desktop = DesktopPlacement::Unknown;
    assert_eq!(
        occlusion(&read(vec![target(), unknown.clone()]), TARGET, POINT),
        Occlusion::Unknown
    );
    unknown.client = rect(900, 900, 10, 10);
    assert_eq!(
        occlusion(&read(vec![target(), unknown]), TARGET, POINT),
        Occlusion::Clear
    );

    let mut invisible_target = target();
    invisible_target.flags.hidden = true;
    assert_eq!(
        occlusion(&read(vec![invisible_target]), TARGET, POINT),
        Occlusion::Unknown
    );
    let mut invisible_target = target();
    invisible_target.flags.mapped = false;
    assert_eq!(
        occlusion(&read(vec![invisible_target]), TARGET, POINT),
        Occlusion::Unknown
    );
    let mut other_desktop_target = target();
    other_desktop_target.desktop = DesktopPlacement::On(2);
    assert_eq!(
        occlusion(&read(vec![other_desktop_target]), TARGET, POINT),
        Occlusion::Unknown
    );
}

#[test]
fn frame_geometry_and_topmost_cover() {
    let mut titled = stacked(20, rect(200, 160, 400, 240));
    titled.extents = FrameExtents {
        left: 1,
        right: 1,
        top: 30,
        bottom: 1,
    };
    assert!(matches!(
        occlusion(&read(vec![target(), titled.clone()]), TARGET, (310, 140)),
        Occlusion::CoveredBy { window: 20, .. }
    ));
    titled.extents = FrameExtents {
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
    };
    assert_eq!(
        occlusion(&read(vec![target(), titled]), TARGET, (310, 140)),
        Occlusion::Clear
    );
    assert_eq!(
        occlusion(
            &read(vec![target(), stacked(20, rect(600, 100, 100, 100))]),
            TARGET,
            POINT
        ),
        Occlusion::Clear
    );

    let mut lower = stacked(20, rect(200, 100, 400, 300));
    lower.flags.above = false;
    let upper = stacked(30, rect(250, 100, 100, 100));
    assert!(matches!(
        occlusion(&read(vec![target(), lower, upper]), TARGET, (300, 150)),
        Occlusion::CoveredBy { window: 30, .. }
    ));
}

#[test]
fn override_redirect_input_contract() {
    let mut snapshot = read(vec![target()]);
    snapshot.override_redirect_above = vec![rect(300, 150, 50, 50)];
    assert_eq!(
        occlusion(&snapshot, TARGET, POINT),
        Occlusion::OverrideRedirectOver
    );

    snapshot.override_redirect_receiving = vec![(77, rect(300, 150, 50, 50))];
    assert_eq!(
        occlusion(&snapshot, TARGET, POINT),
        Occlusion::CoveredBy {
            window: 77,
            frame: rect(300, 150, 50, 50)
        }
    );
    snapshot.override_redirect_receiving = vec![(77, rect(300, 150, 10, 10))];
    assert_eq!(
        occlusion(&snapshot, TARGET, POINT),
        Occlusion::OverrideRedirectOver
    );

    snapshot.stack.push(stacked(20, rect(200, 100, 400, 300)));
    assert!(matches!(
        occlusion(&snapshot, TARGET, POINT),
        Occlusion::CoveredBy { window: 20, .. }
    ));

    let mut malformed = read(vec![target()]);
    malformed.stack[0].flags.hidden = true;
    malformed.stack[0].flags.mapped = false;
    assert_eq!(occlusion(&malformed, TARGET, POINT), Occlusion::Unknown);
}
