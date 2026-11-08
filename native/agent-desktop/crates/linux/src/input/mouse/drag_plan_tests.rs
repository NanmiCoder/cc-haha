use super::*;

fn params(duration_ms: Option<u64>, drop_delay_ms: Option<u64>) -> DragParams {
    DragParams {
        from: Point { x: 10.0, y: 10.0 },
        to: Point { x: 110.0, y: 50.0 },
        duration_ms,
        drop_delay_ms,
    }
}

fn deadline(ms: u64) -> Deadline {
    Deadline::after(ms).unwrap()
}

#[test]
fn drag_safety_and_refusals() {
    let left = |down| Step::Button {
        code: BUTTON_LEFT,
        down,
    };
    let pickup = Step::Pause(Duration::from_millis(PICKUP_DELAY_MS));
    for (duration, dwell) in [(MIN_DURATION_MS, 150), (MIN_DURATION_MS + 32, 200)] {
        let plan = plan_drag(&params(Some(duration), Some(dwell)), deadline(5_000)).unwrap();
        let down = plan
            .steps
            .iter()
            .position(|step| *step == left(true))
            .unwrap();
        let up = plan
            .steps
            .iter()
            .position(|step| *step == left(false))
            .unwrap();
        assert_eq!(
            &plan.steps[..=down],
            &[Step::MoveTo { x: 10, y: 10 }, pickup.clone(), left(true)]
        );
        let travel = &plan.steps[down + 1..up];
        assert!(travel.contains(&Step::MoveTo { x: 110, y: 50 }));
        assert_eq!(
            &plan.steps[up - 1..],
            &[Step::Pause(Duration::from_millis(dwell)), left(false)]
        );
        assert_eq!(plan.release_origin, Some((10, 10)));
    }

    let short = plan_drag(&params(Some(300), Some(500)), deadline(1_000)).unwrap_err();
    assert_eq!(short.code, ErrorCode::Timeout);
    let details = short.details.unwrap();
    assert_eq!(details["physical_delivery_started"], false);
    assert_eq!(details["required_ms"], 1_200);
    for (invalid, message) in [
        (
            params(Some(MAX_DRAG_DURATION_MS + 1), None),
            format!("Drag duration must not exceed {MAX_DRAG_DURATION_MS}ms"),
        ),
        (
            params(None, Some(MAX_DRAG_DROP_DELAY_MS + 1)),
            format!("Drag drop delay must not exceed {MAX_DRAG_DROP_DELAY_MS}ms"),
        ),
    ] {
        let error = plan_drag(&invalid, deadline(5_000)).unwrap_err();
        assert_eq!(
            (error.code, error.message.as_str()),
            (ErrorCode::InvalidArgs, message.as_str())
        );
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    }
    for too_short in [0, 30, MIN_DURATION_MS - 1] {
        let error = plan_drag(&params(Some(too_short), None), deadline(5_000)).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert!(error.message.contains("at least 100ms"));
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    }
    let mut non_finite = params(None, None);
    non_finite.to.x = f64::INFINITY;
    assert_eq!(
        plan_drag(&non_finite, deadline(5_000)).unwrap_err().code,
        ErrorCode::InvalidArgs
    );
}
