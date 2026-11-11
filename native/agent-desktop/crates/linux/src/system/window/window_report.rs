use agent_desktop_core::{WindowOp, WindowReadback};

use super::window_op::window_op_verdict::POSITION_TOLERANCE;

/// What a successful window operation read back before it answered. A
/// restore is left unverified because its branches can lift a minimized
/// window, clear maximization, return a saved place, or change nothing; no
/// single readback scope describes every successful restore.
pub(in crate::system) fn window_readback(op: &WindowOp) -> Option<WindowReadback> {
    match op {
        WindowOp::Resize { .. } => Some(WindowReadback::geometry(
            "window_size",
            f64::from(POSITION_TOLERANCE),
            "pixels",
        )),
        WindowOp::Move { .. } => Some(WindowReadback::geometry(
            "window_position",
            f64::from(POSITION_TOLERANCE),
            "pixels",
        )),
        WindowOp::Minimize => Some(WindowReadback::state("window_minimized_state")),
        WindowOp::Maximize => Some(WindowReadback::state("window_maximized_state")),
        WindowOp::Restore => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_desktop_core::{
        DeliverySemantics, OperationReport, OperationTarget, ProcessIdentity,
    };

    fn report(op: &WindowOp) -> OperationReport {
        let target = OperationTarget::Window {
            id: "w-1".into(),
            title: "Doc".into(),
            process: ProcessIdentity::new(7u32, "boot"),
        };
        OperationReport::window_operation(target, op, window_readback(op))
    }

    #[test]
    fn a_restore_stays_unverified_without_a_uniform_readback_scope() {
        assert_eq!(
            report(&WindowOp::Restore).disposition(),
            DeliverySemantics::delivered_unverified()
        );
    }

    #[test]
    fn geometry_names_its_scope_with_the_real_tolerance_in_pixels() {
        for (op, scope) in [
            (WindowOp::Move { x: 1.0, y: 2.0 }, "window_position"),
            (
                WindowOp::Resize {
                    width: 3.0,
                    height: 4.0,
                },
                "window_size",
            ),
        ] {
            let details = report(&op).result.details.unwrap();
            assert_eq!(details["verification_scope"], scope);
            assert_eq!(details["units"], "pixels");
            assert_eq!(details["tolerance"], f64::from(POSITION_TOLERANCE));
        }
    }

    #[test]
    fn minimize_and_maximize_report_a_state_scope_without_a_tolerance() {
        for (op, scope) in [
            (WindowOp::Minimize, "window_minimized_state"),
            (WindowOp::Maximize, "window_maximized_state"),
        ] {
            let details = report(&op).result.details.unwrap();
            assert_eq!(details["verification_scope"], scope);
            assert!(details.get("tolerance").is_none());
        }
    }
}
