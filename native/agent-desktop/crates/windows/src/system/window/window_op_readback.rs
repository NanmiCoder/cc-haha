use agent_desktop_core::{WindowOp, WindowReadback};

use super::window_op::PLACEMENT_TOLERANCE_PX;

pub(crate) fn window_readback(op: &WindowOp) -> Option<WindowReadback> {
    let tolerance = f64::from(PLACEMENT_TOLERANCE_PX);
    Some(match op {
        WindowOp::Resize { .. } => WindowReadback::geometry("window_size", tolerance, "px"),
        WindowOp::Move { .. } => WindowReadback::geometry("window_position", tolerance, "px"),
        WindowOp::Minimize | WindowOp::Restore => WindowReadback::state("window_minimized_state"),
        WindowOp::Maximize => WindowReadback::state("window_maximized_state"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_desktop_core::{
        DeliverySemantics, OperationReport, OperationTarget, ProcessIdentity,
    };

    fn report(op: &WindowOp) -> OperationReport {
        OperationReport::window_operation(
            OperationTarget::Window {
                id: "w-1".into(),
                title: "Doc".into(),
                process: ProcessIdentity::new(7u32, "boot"),
            },
            op,
            window_readback(op),
        )
    }

    #[test]
    fn maximize_claims_only_the_maximized_state_it_reads_from_the_placement() {
        let maximize = report(&WindowOp::Maximize);

        assert_eq!(
            maximize.disposition(),
            DeliverySemantics::delivered_verified()
        );
        let details = maximize.result.details.unwrap();
        assert_eq!(details["verification_scope"], "window_maximized_state");
        assert!(details.get("tolerance").is_none());
    }

    #[test]
    fn geometry_scopes_carry_the_placement_tolerance_in_pixels() {
        for (op, scope) in [
            (
                WindowOp::Resize {
                    width: 3.0,
                    height: 4.0,
                },
                "window_size",
            ),
            (WindowOp::Move { x: 1.0, y: 2.0 }, "window_position"),
        ] {
            let details = report(&op).result.details.unwrap();
            assert_eq!(details["verification_scope"], scope);
            assert_eq!(details["tolerance"], f64::from(PLACEMENT_TOLERANCE_PX));
            assert_eq!(details["units"], "px");
        }
    }
}
