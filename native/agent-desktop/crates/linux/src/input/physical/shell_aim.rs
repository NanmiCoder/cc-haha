use agent_desktop_core::{AdapterError, DeliverySemantics, DisplayInfo, ErrorCode, Point, Rect};
use serde_json::json;

fn is_sentinel(extents: Rect) -> bool {
    let lowest = f64::from(i32::MIN);
    extents.x <= lowest || extents.y <= lowest
}

pub(crate) fn display_under<'a>(
    point: &Point,
    displays: &'a [DisplayInfo],
) -> Option<&'a DisplayInfo> {
    displays.iter().find(|display| {
        let bounds = &display.bounds;
        point.x >= bounds.x
            && point.x < bounds.x + bounds.width
            && point.y >= bounds.y
            && point.y < bounds.y + bounds.height
    })
}

fn refusal(extents: Rect, why: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!(
            "The shell control at [{}, {}, {}, {}] is {why}, so no pointer event was sent",
            extents.x, extents.y, extents.width, extents.height
        ),
    )
    .with_suggestion(
        "Make the control visible, for example by showing an autohidden dock, then snapshot again",
    )
    .with_details(json!({
        "check": "geometry",
        "extents": [extents.x, extents.y, extents.width, extents.height],
        "physical_delivery_started": false,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
}

/// The point a pointer click on a shell control lands at: the centre of its
/// screen extents. Extents with no area, the invalid sentinel position, or
/// a centre outside every display are refused.
pub(crate) fn aim(extents: Rect, displays: &[DisplayInfo]) -> Result<Point, AdapterError> {
    if is_sentinel(extents) {
        return Err(refusal(extents, "at the invalid position"));
    }
    if extents.width <= 0.0 || extents.height <= 0.0 {
        return Err(refusal(extents, "without area"));
    }
    let point = Point {
        x: extents.x + extents.width / 2.0,
        y: extents.y + extents.height / 2.0,
    };
    if display_under(&point, displays).is_none() {
        return Err(refusal(extents, "centred outside every display"));
    }
    point.validate()?;
    Ok(point)
}

#[cfg(test)]
#[path = "shell_aim_tests.rs"]
mod tests;
