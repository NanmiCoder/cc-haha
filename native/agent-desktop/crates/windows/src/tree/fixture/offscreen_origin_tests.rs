use super::*;

fn rect(left: i32, top: i32, width: i32, height: i32) -> VirtualScreenRect {
    VirtualScreenRect {
        left,
        top,
        width,
        height,
    }
}

#[test]
fn this_boxs_display_resolves_to_an_unserialized_park_point() {
    let injected = rect(0, 0, 1_639, 732);
    let decision = stage(Some(injected), 420, 320);
    match decision {
        Stage::Parked { origin } => assert!(
            !injected.contains(origin.0, origin.1),
            "parked origin {origin:?} must sit outside the injected rect {injected:?}"
        ),
        Stage::OnScreen { .. } => {
            panic!("a 1639x732 virtual screen must resolve off-screen, not fall back on-screen")
        }
    }
}

#[test]
fn a_virtual_screen_too_large_to_clear_takes_the_on_screen_stage() {
    let injected = rect(0, 0, 4_000, 3_000);
    let decision = stage(Some(injected), 420, 320);
    assert!(
        matches!(decision, Stage::OnScreen { .. }),
        "an oversized rect must fall back to the serialized on-screen stage, got {decision:?}"
    );
}

#[test]
fn a_side_by_side_dual_monitor_rect_still_parks_rather_than_falling_back() {
    let injected = rect(0, 0, 3_840, 1_080);
    let decision = stage(Some(injected), 420, 320);
    match decision {
        Stage::Parked { origin } => assert!(!injected.contains(origin.0, origin.1)),
        Stage::OnScreen { .. } => panic!(
            "a 3840x1080 side-by-side rect leaves room below the rect and must not fall back \
             on-screen"
        ),
    }
}

#[test]
fn resolver_origin_is_never_inside_the_injected_rect() {
    let table = [
        rect(0, 0, 1_639, 732),
        rect(0, 0, 1_920, 1_080),
        rect(0, 0, 3_840, 1_080),
        rect(-1_920, 0, 3_840, 1_080),
        rect(0, -1_080, 1_920, 2_160),
        rect(-1_920, -1_080, 3_840, 2_160),
    ];
    for candidate in table {
        if let Some(origin) = resolve_offscreen_origin(candidate, 420, 320) {
            assert!(
                !candidate.contains(origin.0, origin.1),
                "origin {origin:?} landed inside rect {candidate:?}"
            );
        }
    }
}

#[test]
fn resolver_returns_none_when_both_axes_exceed_the_reach_bound() {
    let injected = rect(0, 0, 4_000, 3_000);
    assert_eq!(resolve_offscreen_origin(injected, 420, 320), None);
}
