use crate::{
    AppError, DragParams,
    adapter::PlatformAdapter,
    commands::{
        helpers::{apply_post_action_wait, validate_post_action_wait},
        operation_response::operation_response,
        point_resolve::{PointResolveArgs, require_cursor_policy, require_pointer_capability},
        pointer_action::{
            PointResolveAttempt, before_first_event, ensure_point_deadline,
            focus_point_under_lease, point_deadline, resolve_point_under_lease,
            retry_leased_point_phase, wait_for_point_with_deadline,
        },
    },
    context::CommandContext,
};
use serde_json::{Value, json};

pub struct DragEndpoint {
    pub ref_id: Option<String>,
    pub xy: Option<(f64, f64)>,
}

/// Selects which drag endpoint's window scopes the post-action `--wait-for` /
/// `--wait-for-gone` verification. A drag has two endpoints, only one of which
/// `apply_post_action_wait` can poll, so the caller must be able to target the
/// window where the confirmation (or its absence) appears rather than always
/// the pickup window. Defaults to the drop target (`To`), since a drag's
/// defining effect is the drop; falls back to the other endpoint when the
/// chosen one carries no `source_entry` (e.g. an `--from-xy` pickup).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WaitForScope {
    From,
    #[default]
    To,
}

pub struct DragArgs {
    pub from: DragEndpoint,
    pub to: DragEndpoint,
    pub duration_ms: Option<u64>,
    pub drop_delay_ms: Option<u64>,
    pub timeout_ms: Option<u64>,
    pub wait_for_scope: WaitForScope,
}

pub fn execute(
    args: DragArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    require_cursor_policy(context, "drag")?;
    require_pointer_capability(adapter)?;
    validate_post_action_wait(context)?;
    let deadline = point_deadline(args.timeout_ms)?;
    DragParams::validate_timing(args.duration_ms, args.drop_delay_ms, deadline)?;
    let from_args = PointResolveArgs {
        ref_id: args.from.ref_id.as_deref(),
        xy: args.from.xy,
        missing_input_message: "Provide --from <ref> or --from-xy x,y",
        headed_requirement: crate::HeadedRequirement::FocusedWindowAndCursor,
    };
    let to_args = PointResolveArgs {
        ref_id: args.to.ref_id.as_deref(),
        xy: args.to.xy,
        missing_input_message: "Provide --to <ref> or --to-xy x,y",
        headed_requirement: crate::HeadedRequirement::None,
    };
    let auto_wait = args.timeout_ms.is_some_and(|timeout_ms| timeout_ms > 0);
    let cursor = crate::cursor_overlay::hold_cursor(context, deadline);
    let (from, to, lease, params) = before_first_event(|| {
        if auto_wait {
            wait_for_point_with_deadline(from_args, deadline, adapter, context)?;
            wait_for_point_with_deadline(to_args, deadline, adapter, context)?;
        }
        let (from, to, lease) = retry_leased_point_phase(args.timeout_ms, deadline, || {
            let lease = adapter.acquire_interaction_lease(deadline)?;
            let focused = focus_point_under_lease(from_args, &lease, adapter, context)?;
            let from = resolve_point_under_lease(
                PointResolveAttempt {
                    args: from_args,
                    stability: None,
                    allow_scroll: !auto_wait,
                },
                deadline,
                &lease,
                adapter,
                context,
            )?;
            let to = resolve_point_under_lease(
                PointResolveAttempt {
                    args: to_args,
                    stability: None,
                    allow_scroll: !auto_wait,
                },
                deadline,
                &lease,
                adapter,
                context,
            )?;
            let mut from = resolve_point_under_lease(
                PointResolveAttempt {
                    args: from_args,
                    stability: Some(from.bounds_hash),
                    allow_scroll: false,
                },
                deadline,
                &lease,
                adapter,
                context,
            )?;
            let to = resolve_point_under_lease(
                PointResolveAttempt {
                    args: to_args,
                    stability: Some(to.bounds_hash),
                    allow_scroll: false,
                },
                deadline,
                &lease,
                adapter,
                context,
            )?;
            from.focused = focused;
            Ok((from, to, lease))
        })?;
        ensure_point_deadline(
            deadline,
            Some(json!({
                "status": "actionable",
                "from": { "x": from.point.x, "y": from.point.y },
                "to": { "x": to.point.x, "y": to.point.y }
            })),
        )?;
        let params = DragParams {
            from: from.point.clone(),
            to: to.point.clone(),
            duration_ms: args.duration_ms,
            drop_delay_ms: args.drop_delay_ms,
        };
        params.validate(deadline)?;
        Ok((from, to, lease, params))
    })?;
    crate::cursor_overlay::submit_travel(adapter, context, from.point.clone(), &lease, false);
    let drag_tracking = crate::cursor_overlay::submit_drag(
        adapter,
        context,
        from.point.clone(),
        to.point.clone(),
        &lease,
    );
    let result = adapter.drag(params, &lease);
    let delivered = result
        .as_ref()
        .is_ok_and(|report| crate::cursor_overlay::confirms_delivery(report.disposition()));
    if delivered && drag_tracking {
        crate::cursor_overlay::submit_drag_effect(
            adapter,
            context,
            from.point.clone(),
            to.point.clone(),
        );
    } else if delivered {
        crate::cursor_overlay::submit(
            adapter,
            context,
            to.point.clone(),
            None,
            false,
            crate::CursorPhase::Effect,
        );
    } else {
        crate::cursor_overlay::cancel_drag(adapter, context);
    }
    let mut response = operation_response(
        &result?,
        json!({
            "from": { "x": from.point.x, "y": from.point.y },
            "to": { "x": to.point.x, "y": to.point.y }
        }),
    )?;
    if let Some(drop_delay_ms) = args.drop_delay_ms {
        response["drop_delay_ms"] = json!(drop_delay_ms);
    }
    if from.focused {
        response["focused"] = json!(true);
    }
    drop(lease);
    drop(cursor);
    let wait_entry = match args.wait_for_scope {
        WaitForScope::To => to.source_entry.as_ref().or(from.source_entry.as_ref()),
        WaitForScope::From => from.source_entry.as_ref().or(to.source_entry.as_ref()),
    };
    apply_post_action_wait(response, wait_entry, adapter, context)
}

#[cfg(test)]
#[path = "drag_tests.rs"]
mod tests;
