use super::{
    PointerDelivery,
    check::ActionabilityCheck,
    check_result::{occluded, pass, unknown},
    hit_test_evidence::HitTestEvidence,
    report::ActionabilityReport,
};
use crate::{
    AdapterError, ErrorCode, Point,
    actions::action_request::ActionRequest,
    adapter::hit_test::HitTestResult,
    adapter::{NativeHandle, PlatformAdapter},
};
use serde_json::json;

pub(super) fn receives_events_check(
    bounds: Option<crate::Rect>,
    handle: &NativeHandle,
    adapter: &dyn PlatformAdapter,
    request: &ActionRequest,
    deadline: crate::Deadline,
) -> Result<(ActionabilityCheck, Option<Point>), AdapterError> {
    if !request.action.requires_hit_test() {
        return Ok((pass("receives_events"), None));
    }
    let Some(bounds) = bounds else {
        return Ok((unknown("receives_events", "bounds unavailable"), None));
    };
    let mut first_occlusion = None;
    let mut evidence = HitTestEvidence {
        attempted: 0,
        unknown: 0,
        occluded: 0,
    };
    for point in candidate_points(bounds) {
        evidence.attempted += 1;
        match adapter.hit_test(handle, point.clone(), deadline) {
            Ok(HitTestResult::ReachesTarget) => {
                let mut check = pass("receives_events");
                check.hit_test = Some(evidence);
                return Ok((check, Some(point)));
            }
            Ok(HitTestResult::InterceptedBy { role, name, bounds }) => {
                evidence.occluded += 1;
                first_occlusion.get_or_insert_with(|| occluded(role, name, bounds));
            }
            Ok(HitTestResult::Unknown) => evidence.unknown += 1,
            Err(error) if error.code == ErrorCode::PlatformNotSupported => {
                evidence.unknown += 1;
                let mut check = unknown("receives_events", "hit testing is not supported");
                check.hit_test = Some(evidence);
                return Ok((check, None));
            }
            Err(error) => return Err(error),
        }
    }
    let mut check = if evidence.unknown > 0 && evidence.occluded > 0 {
        let mut mixed = first_occlusion.unwrap_or_else(|| {
            unknown(
                "receives_events",
                "hit test evidence mixed unknown and occluded outcomes",
            )
        });
        mixed.status = super::status::ActionabilityStatus::Unknown;
        mixed.reason = Some("hit test evidence mixed unknown and occluded outcomes".into());
        mixed
    } else if evidence.unknown > 0 {
        unknown("receives_events", "hit test result inconclusive")
    } else {
        first_occlusion
            .unwrap_or_else(|| unknown("receives_events", "hit test result inconclusive"))
    };
    check.hit_test = Some(evidence);
    Ok((check, None))
}

fn candidate_points(bounds: crate::Rect) -> [Point; 5] {
    let point = |x: f64, y: f64| Point {
        x: bounds.x + bounds.width * x,
        y: bounds.y + bounds.height * y,
    };
    [
        point(0.5, 0.5),
        point(0.25, 0.25),
        point(0.75, 0.25),
        point(0.25, 0.75),
        point(0.75, 0.75),
    ]
}

pub(crate) fn require_receives_events(
    handle: &NativeHandle,
    point: Point,
    adapter: &dyn PlatformAdapter,
    deadline: crate::Deadline,
) -> Result<(), AdapterError> {
    let check = match adapter.hit_test(handle, point, deadline) {
        Ok(HitTestResult::ReachesTarget) => return Ok(()),
        Ok(HitTestResult::Unknown) => return Ok(()),
        Err(error) if error.code == ErrorCode::PlatformNotSupported => return Ok(()),
        Err(error) => return Err(error),
        Ok(HitTestResult::InterceptedBy { role, name, bounds }) => occluded(role, name, bounds),
    };
    let report =
        ActionabilityReport::from_checks(vec![check], None, None, None, PointerDelivery::Physical);
    Err(AdapterError::new(
        ErrorCode::ActionFailed,
        format!("Target is not actionable: {}", report.failure_reasons()),
    )
    .with_details(json!(report))
    .with_suggestion(
        "Wait for the target to become actionable, refresh the snapshot, or use an explicit physical/focus command if intended.",
    )
    .with_disposition(crate::DeliverySemantics::not_delivered()))
}
