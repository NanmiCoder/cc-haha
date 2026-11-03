use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode, Point};
use serde_json::json;

use crate::tree::hit_test::hit_guard::{admits, pixel};
use crate::tree::placement::Placement;
use crate::tree::properties::toolkit_trust::reports_global_position;

pub(crate) fn validate(
    point: &Point,
    placed: &Placement,
    has_container: bool,
) -> Result<(), AdapterError> {
    let inside = || {
        let node = placed.node?;
        let frame = placed.frame?;
        if placed.frame_iconified == Some(true) || placed.x11.is_some_and(|window| window.hidden) {
            return None;
        }
        let origin = placed.popup_origin.or_else(|| {
            let window = placed.x11?;
            let shadow = if reports_global_position(&placed.toolkit) {
                (0, 0, 0, 0)
            } else {
                window.shadow
            };
            Some((
                window.client_origin.0.checked_add(shadow.0)?,
                window.client_origin.1.checked_add(shadow.1)?,
            ))
        })?;
        let point = pixel(point.x - f64::from(origin.0), point.y - f64::from(origin.1))?;
        if !admits(node, point) || !admits(frame, point) {
            return None;
        }
        if has_container && !admits(placed.container?, point) {
            return None;
        }
        Some(())
    };
    inside().ok_or_else(|| {
        AdapterError::new(
            ErrorCode::StaleRef,
            "The pointer point is outside the target's proven visible area",
        )
        .with_suggestion("Reveal the target and find it again before sending pointer input")
        .with_details(json!({
            "kind": "pointer_target_not_visible",
            "physical_delivery_started": false,
        }))
        .with_disposition(DeliverySemantics::not_delivered())
    })
}
