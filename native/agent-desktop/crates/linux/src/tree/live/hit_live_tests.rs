mod cases;

use agent_desktop_core::{AdapterError, HitTestResult, ObservationOps, Point};

use super::live_rig::{Rig, deadline};
use crate::tree::surfaces::window_extents::read_window_extents;
use crate::tree::{AtspiElement, Extents, WalkedNode};

pub(in crate::tree) fn hit(
    rig: &Rig,
    target: &AtspiElement,
    point: (i32, i32),
) -> Result<HitTestResult, AdapterError> {
    let handle = target.clone().into_native_handle();
    rig.adapter.hit_test(
        &handle,
        Point {
            x: f64::from(point.0),
            y: f64::from(point.1),
        },
        deadline(5_000),
    )
}

/// Collect the descendants with the same frame ancestry used by resolved refs.
pub(in crate::tree) fn candidates(
    frame: &AtspiElement,
    node: &WalkedNode<crate::tree::ObservedRead>,
    out: &mut Vec<AtspiElement>,
) {
    for child in &node.children {
        let mut element = child.payload.node.element.clone();
        element.set_ancestry(crate::tree::element::ancestry::of_root(frame));
        out.push(element);
        candidates(frame, child, out);
    }
}

pub(in crate::tree) fn window_extents(rig: &Rig, element: &AtspiElement) -> Option<Extents> {
    read_window_extents(&rig.bus, element, deadline(3_000))
}
