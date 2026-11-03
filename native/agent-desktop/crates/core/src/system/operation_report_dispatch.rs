use serde_json::{Map, Value, json};

use crate::system::operation_report_build::window_step;
use crate::{
    ActionStep, AdapterError, AppInfo, DeliverySemantics, OperationReport, OperationTarget,
    WindowInfo, WindowOp, WindowReadback,
};

const IDENTITY_UNAVAILABLE: &str = "process_instance_unavailable";

impl OperationReport {
    /// Joins a window operation's outcome with the target it acted on. A
    /// failure keeps its code, details and disposition and gains the target,
    /// and the completed dispatch step when the write is known to have
    /// happened. A missing process instance never turns a done operation
    /// into an error.
    pub fn from_window_dispatch(
        window: &WindowInfo,
        op: &WindowOp,
        readback: Option<WindowReadback>,
        dispatched: Result<(), AdapterError>,
    ) -> Result<Self, AdapterError> {
        let resolved = OperationTarget::for_window(window);
        match (dispatched, resolved) {
            (Ok(()), Ok(target)) => Ok(Self::window_operation(target, op, readback)),
            (Ok(()), Err(_)) => Ok(Self::window_operation(
                OperationTarget::window_without_instance(window),
                op,
                readback,
            )
            .with_identity_note()),
            (Err(error), Ok(target)) => Err(with_failure_evidence(
                error,
                &target,
                window_step(window_label(op)),
            )),
            (Err(error), Err(_)) => Err(error),
        }
    }

    /// As [`Self::from_window_dispatch`] for closing an application.
    /// `dispatched` carries `true` when the process was observed exiting and
    /// `false` when it was already gone.
    pub fn from_close_dispatch(
        app: &AppInfo,
        dispatched: Result<bool, AdapterError>,
    ) -> Result<Self, AdapterError> {
        let resolved = OperationTarget::for_app(app);
        match (dispatched, resolved) {
            (Ok(exited), Ok(target)) => Ok(close_report(target, exited)),
            (Ok(exited), Err(_)) => Ok(close_report(
                OperationTarget::app_without_instance(app),
                exited,
            )
            .with_identity_note()),
            (Err(error), Ok(target)) => Err(with_failure_evidence(
                error,
                &target,
                window_step("terminate_request"),
            )),
            (Err(error), Err(_)) => Err(error),
        }
    }

    fn with_identity_note(mut self) -> Self {
        let mut details = match self.result.details.take() {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        details.insert("target_identity".into(), json!(IDENTITY_UNAVAILABLE));
        self.result.details = Some(Value::Object(details));
        self
    }
}

fn close_report(target: OperationTarget, exited: bool) -> OperationReport {
    if exited {
        OperationReport::app_exited(target)
    } else {
        OperationReport::app_already_gone(target)
    }
}

fn window_label(op: &WindowOp) -> &'static str {
    match op {
        WindowOp::Resize { .. } => "window_resize",
        WindowOp::Move { .. } => "window_move",
        WindowOp::Minimize => "window_minimize",
        WindowOp::Maximize => "window_maximize",
        WindowOp::Restore => "window_restore",
    }
}

fn with_failure_evidence(
    error: AdapterError,
    target: &OperationTarget,
    completed: ActionStep,
) -> AdapterError {
    let Some(Value::Object(mut details)) = error.details.clone().or(Some(json!({}))) else {
        return error;
    };
    details.entry("target").or_insert_with(|| json!(target));
    if error.disposition == DeliverySemantics::delivered_unverified() {
        details
            .entry("steps")
            .or_insert_with(|| json!([completed.with_verified(false)]));
    }
    error.with_details(Value::Object(details))
}

#[cfg(test)]
#[path = "operation_report_dispatch_tests.rs"]
mod tests;
