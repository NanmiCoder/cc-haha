use serde_json::json;

use crate::{
    ActionResult, ActionStep, DragParams, MouseEvent, MouseEventKind, OperationReport,
    OperationTarget, StepMechanism, WindowOp, WindowReadback,
};

impl OperationReport {
    pub fn pointer_dispatched(event: &MouseEvent, position_verified: bool) -> Self {
        let (action, label) = match event.kind {
            MouseEventKind::Move => ("mouse-move", "pointer_move"),
            MouseEventKind::Down => ("mouse-down", "pointer_down"),
            MouseEventKind::Up => ("mouse-up", "pointer_up"),
            MouseEventKind::Click { .. } => ("mouse-click", "pointer_click"),
            MouseEventKind::Wheel { .. } => ("mouse-wheel", "pointer_wheel"),
        };
        let target = OperationTarget::Pointer {
            point: event.point.clone(),
        };
        let step = physical_step(label);
        if !position_verified {
            return Self::new(
                ActionResult::delivered_unverified(action).with_steps(vec![step]),
                target,
            );
        }
        Self::new(
            ActionResult::delivered_unverified(action)
                .with_steps(vec![step.with_verified(true)])
                .with_details(json!({ "verification_scope": "pointer_position" }))
                .with_verified_delivery(),
            target,
        )
    }

    pub fn drag_dispatched(params: &DragParams) -> Self {
        Self::new(
            ActionResult::delivered_unverified("drag")
                .with_steps(vec![physical_step("pointer_drag")]),
            OperationTarget::Drag {
                from: params.from.clone(),
                to: params.to.clone(),
            },
        )
    }

    pub fn window_operation(
        target: OperationTarget,
        op: &WindowOp,
        readback: Option<WindowReadback>,
    ) -> Self {
        let (action, label) = match op {
            WindowOp::Resize { .. } => ("resize-window", "window_resize"),
            WindowOp::Move { .. } => ("move-window", "window_move"),
            WindowOp::Minimize => ("minimize", "window_minimize"),
            WindowOp::Maximize => ("maximize", "window_maximize"),
            WindowOp::Restore => ("restore", "window_restore"),
        };
        let step = window_step(label);
        let Some(readback) = readback else {
            return Self::new(
                ActionResult::delivered_unverified(action).with_steps(vec![step]),
                target,
            );
        };
        Self::new(
            ActionResult::delivered_unverified(action)
                .with_steps(vec![step.with_verified(true)])
                .with_details(readback.details())
                .with_verified_delivery(),
            target,
        )
    }

    pub fn app_exited(target: OperationTarget) -> Self {
        Self::new(
            ActionResult::delivered_unverified("close-app")
                .with_steps(vec![
                    ActionStep::succeeded("terminate_request")
                        .with_mechanism(StepMechanism::SemanticApi),
                    ActionStep::succeeded("process_exit")
                        .with_mechanism(StepMechanism::SemanticApi)
                        .with_verified(true),
                ])
                .with_details(json!({ "evidence": "process_instance_exited" }))
                .with_verified_delivery(),
            target,
        )
    }

    pub fn app_already_gone(target: OperationTarget) -> Self {
        Self::new(
            ActionResult::satisfied_without_delivery("close-app")
                .with_details(json!({ "evidence": "process_instance_not_running" })),
            target,
        )
    }

    pub fn clipboard_written(action: &'static str, content_verified: bool) -> Self {
        let step =
            ActionStep::succeeded("clipboard_write").with_mechanism(StepMechanism::SemanticApi);
        if !content_verified {
            return Self::new(
                ActionResult::delivered_unverified(action).with_steps(vec![step]),
                OperationTarget::Clipboard,
            );
        }
        Self::new(
            ActionResult::delivered_unverified(action)
                .with_steps(vec![step.with_verified(true)])
                .with_details(json!({ "verification_scope": "clipboard_content" }))
                .with_verified_delivery(),
            OperationTarget::Clipboard,
        )
    }
}

pub(crate) fn window_step(label: &'static str) -> ActionStep {
    ActionStep::succeeded(label).with_mechanism(StepMechanism::SemanticApi)
}

fn physical_step(label: &'static str) -> ActionStep {
    ActionStep::succeeded(label).with_mechanism(StepMechanism::PhysicalSynthetic)
}

#[cfg(test)]
#[path = "operation_report_build_tests.rs"]
mod tests;
