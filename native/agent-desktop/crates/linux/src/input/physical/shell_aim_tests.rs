use agent_desktop_core::{DeliverySemantics, DisplayInfo, ErrorCode, Rect};

use crate::input::physical::shell_aim::aim;

fn display(x: f64, width: f64, scale: f64) -> DisplayInfo {
    DisplayInfo {
        id: format!("display-{x}"),
        bounds: Rect {
            x,
            y: 0.0,
            width,
            height: 800.0,
        },
        is_primary: x == 0.0,
        scale,
    }
}

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

#[test]
fn visible_target_and_geometry_refusals() {
    let displays = [display(0.0, 1280.0, 1.0), display(1280.0, 1280.0, 2.0)];
    let point = aim(rect(1300.0, -1.0, 60.0, 84.0), &displays).expect("visible overlap");
    assert_eq!((point.x, point.y), (1330.0, 41.0));
    let sentinel = f64::from(i32::MIN);
    for extents in [
        rect(-84.0, 549.0, 84.0, 60.0),
        rect(sentinel, sentinel, sentinel, sentinel),
        rect(10.0, 10.0, 0.0, 30.0),
        rect(10.0, 10.0, 30.0, 0.0),
        rect(f64::NAN, 10.0, 30.0, 30.0),
    ] {
        let error = aim(extents, &displays).expect_err("invalid or off-display geometry");
        assert_eq!(
            (
                error.code,
                error.details.as_ref().unwrap()["physical_delivery_started"].as_bool(),
                error.disposition
            ),
            (
                ErrorCode::ActionFailed,
                Some(false),
                DeliverySemantics::not_delivered()
            )
        );
    }
    assert!(aim(rect(2600.0, 10.0, 50.0, 30.0), &displays).is_err());
    assert!(aim(rect(0.0, 0.0, 72.0, 32.0), &[]).is_err());
}
