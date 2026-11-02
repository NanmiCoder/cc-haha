//! `ref_action.rs`'s actionability-tracing plumbing, split out purely to
//! keep both files under the 400-line cap.

use crate::{
    AdapterError, AppError, actionability,
    actions::action_request::ActionRequest,
    ref_action::{ActionabilityPreflight, ResolvedRefAction},
};
use serde_json::json;

pub(crate) fn preflight_from_report(
    report: &actionability::ActionabilityReport,
) -> ActionabilityPreflight {
    ActionabilityPreflight {
        verified_point: report.verified_point.clone(),
        presentation_point: report.presentation_point.clone(),
        presentation_bounds: report.presentation_bounds,
        pointer_delivery: report.pointer_delivery,
    }
}

/// Shared tracing wrapper over either actionability entry point
/// (`check_live_with_stability`'s terminal-on-any-gap form or
/// `check_live_with_stability_or_gap`'s stability-deferring form) - which
/// one runs is the caller's choice, not this function's; it only owns the
/// `actionability.check.*` trace triple around whichever is passed in.
pub(crate) fn check_report_with_trace(
    target: &ResolvedRefAction<'_>,
    request: &ActionRequest,
    stability: actionability::StabilityExpectation,
    check: fn(
        &actionability::LiveCheckTarget<'_>,
        &ActionRequest,
        actionability::StabilityExpectation,
    ) -> Result<actionability::ActionabilityReport, AdapterError>,
) -> Result<actionability::ActionabilityReport, AppError> {
    target.context.trace_lazy(
        "actionability.check.start",
        || json!({ "ref": target.ref_id, "action": request.action.name() }),
    )?;
    let report = check(
        &actionability::LiveCheckTarget {
            entry: target.entry,
            handle: target.handle,
            adapter: target.adapter,
            deadline: target.deadline,
        },
        request,
        stability,
    )
    .inspect_err(|err| {
        let _ = target.context.trace_lazy("actionability.check.error", || {
            json!({
                "ref": target.ref_id,
                "action": request.action.name(),
                "code": err.code.as_str(),
                "message": err.message.clone(),
                "details": err.details.clone()
            })
        });
    })?;
    target.context.trace_lazy("actionability.check.ok", || {
        json!({ "ref": target.ref_id, "action": request.action.name(), "report": json!(&report) })
    })?;
    Ok(report)
}
