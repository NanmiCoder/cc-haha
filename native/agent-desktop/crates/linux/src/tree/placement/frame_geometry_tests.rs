use super::*;

fn rect(x: i32, y: i32, width: i32, height: i32) -> Extents {
    Extents {
        x,
        y,
        width,
        height,
    }
}

fn toolkit(name: &str, version: &str) -> ToolkitId {
    ToolkitId {
        name: Some(name.to_owned()),
        version: Some(version.to_owned()),
    }
}

#[test]
fn global_and_gtk4_bounds_use_their_distinct_coordinate_sources() {
    let screen = rect(100, 137, 420, 34);
    assert_eq!(
        pointer_bounds(&toolkit("gtk", "3.24"), screen, rect(0, 0, 420, 34), None),
        Some(screen)
    );
    assert_eq!(
        pointer_bounds(
            &toolkit("gtk", "4.14"),
            rect(0, 0, 558, 54),
            rect(329, 285, 558, 54),
            Some((302, 260))
        ),
        Some(rect(631, 545, 558, 54))
    );
    assert_eq!(
        pointer_bounds(
            &toolkit("gtk", "4.14"),
            rect(0, 0, 558, 54),
            rect(329, 285, 558, 54),
            None
        ),
        None
    );
    let unknown = ToolkitId::default();
    assert_eq!(
        pointer_bounds(&unknown, rect(0, 0, 9, 9), rect(5, 6, 9, 9), Some((10, 20))),
        Some(rect(15, 26, 9, 9))
    );
    assert_eq!(
        pointer_bounds(
            &toolkit("gtk", "4.14"),
            rect(0, 0, 9, 9),
            rect(i32::MIN, i32::MIN, 9, 9),
            Some((1, 1))
        ),
        None
    );
}

#[test]
fn calibration_requires_agreeing_global_origins_and_uses_client_origin_for_gtk4() {
    let gtk3 = toolkit("gtk", "3.24");
    let screen = rect(100, 137, 420, 34);
    let window = rect(0, 0, 420, 34);
    for (origin, expected) in [
        ((100, 137), true),
        ((101, 136), true),
        ((102, 137), false),
        ((100, 139), false),
    ] {
        assert_eq!(
            origins_agree(screen, window, origin),
            expected,
            "{origin:?}"
        );
    }
    assert!(origins_agree(
        rect(117, 142, 420, 34),
        rect(17, 5, 420, 34),
        (100, 137)
    ));
    assert!(!origins_agree(rect(117, 142, 420, 34), window, (100, 137)));
    assert!(calibrate(&gtk3, screen, window, Some((100, 137))).is_some());
    assert_eq!(calibrate(&gtk3, screen, window, Some((300, 137))), None);
    assert_eq!(calibrate(&gtk3, screen, window, None), None);

    let gtk4 = toolkit("gtk", "4.14");
    let calibrated = calibrate(
        &gtk4,
        rect(0, 0, 558, 54),
        rect(329, 285, 558, 54),
        Some((302, 260)),
    )
    .expect("client origin calibrates a non-global toolkit");
    assert_eq!(calibrated.rect, rect(631, 545, 558, 54));
    assert_eq!(calibrated.window_origin, (302, 260));
    assert_eq!(
        window_point(calibrated.window_origin, (700, 560)),
        Some((398, 300))
    );
}

#[test]
fn popup_translation_uses_popup_root_and_checked_arithmetic_rejects_overflow() {
    let origin = popup_origin((541, 189), rect(196, 6, 274, 418));
    assert_eq!(origin, Some((345, 183)));
    assert_eq!(
        pointer_bounds(
            &toolkit("gtk", "4.14"),
            rect(0, 0, 214, 32),
            rect(208, 50, 214, 32),
            origin
        ),
        Some(rect(553, 233, 214, 32))
    );
    assert_eq!(popup_origin((i32::MIN, 0), rect(1, 0, 1, 1)), None);
    assert_eq!(window_point((i32::MIN, 0), (i32::MAX, 0)), None);
    assert_eq!(to_pointer_frame((i32::MAX, 0), rect(1, 0, 1, 1)), None);
}

#[test]
fn a_nonzero_window_offset_keeps_the_global_client_origin() {
    let gtk3 = toolkit("gtk", "3.24");
    let calibrated = calibrate(
        &gtk3,
        rect(117, 142, 420, 34),
        rect(17, 5, 420, 34),
        Some((100, 137)),
    )
    .expect("the window offset participates in calibration");
    assert_eq!(calibrated.window_origin, (100, 137));
    assert_eq!(
        window_point(calibrated.window_origin, (310, 154)),
        Some((210, 17))
    );
}
