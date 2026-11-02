use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, HitTestResult, Point};

use super::identity::find_root;
use super::light::{LiveNodes, Nodes};
use super::search::walk;
use crate::system::{SharedBus, list_displays};
use crate::tree::{AtspiElement, Extents};

/// The least time between the two reads of the target's extents. A target
/// that is sliding or growing reads differently the second time.
const MOTION_GAP: Duration = Duration::from_millis(50);

fn contains(extents: Extents, point: &Point) -> bool {
    let (x, y) = (point.x, point.y);
    x >= f64::from(extents.x)
        && x < f64::from(extents.x) + f64::from(extents.width)
        && y >= f64::from(extents.y)
        && y < f64::from(extents.y) + f64::from(extents.height)
}

/// Whether a click at `point` reaches `target`. The shell answers a point
/// query only with a coarse container, so the proof is read from the tree:
/// the showing nodes are listed in paint order, the last one over the point
/// is the one a click lands on, and it must be the target or stand below it.
/// A target whose extents differ between two reads `MOTION_GAP` apart is
/// still moving. Anything that cannot be read, a tree that lost a node while
/// it was read, anything on top of the target and anything moving is
/// unproven; the answer is never "intercepted", because paint order cannot
/// tell a cover from an overlay that takes no pointer events.
pub(super) fn verdict<N: Nodes>(
    nodes: &N,
    root: &AtspiElement,
    target: &AtspiElement,
    point: &Point,
    pause: &mut dyn FnMut(Duration),
    deadline: Deadline,
) -> Result<HitTestResult, AdapterError> {
    let before = match nodes.read(target) {
        Ok(light) if light.showing => light,
        Ok(_) => return Ok(HitTestResult::Unknown),
        Err(error) if error.code == ErrorCode::ElementNotFound => {
            return Ok(HitTestResult::Unknown);
        }
        Err(error) => return Err(error),
    };
    pause(MOTION_GAP);
    let tree = walk(nodes, root, deadline, &|light| !light.showing)?;
    if !tree.complete {
        return Ok(HitTestResult::Unknown);
    }
    let Some(at) = tree.position(target) else {
        return Ok(HitTestResult::Unknown);
    };
    if tree.visits[at].light.extents != before.extents {
        return Ok(HitTestResult::Unknown);
    }
    let top = tree.visits.iter().rposition(|visit| {
        visit
            .light
            .placed()
            .is_some_and(|extents| contains(extents, point))
    });
    Ok(match top {
        Some(top) if tree.within(top, at) => HitTestResult::ReachesTarget,
        _ => HitTestResult::Unknown,
    })
}

pub(crate) fn display_extents(deadline: Deadline) -> Option<Vec<Extents>> {
    let displays = list_displays(deadline).ok()?;
    Some(
        displays
            .iter()
            .map(|display| Extents {
                x: display.bounds.x as i32,
                y: display.bounds.y as i32,
                width: display.bounds.width as i32,
                height: display.bounds.height as i32,
            })
            .collect(),
    )
}

pub(crate) fn hit_test(
    bus: &SharedBus,
    target: &AtspiElement,
    point: Point,
    deadline: Deadline,
) -> Result<HitTestResult, AdapterError> {
    let root = find_root(bus, deadline)?;
    let start = AtspiElement::new(&root.bus_name, &root.path, root.pid);
    let nodes = LiveNodes::new(bus.get(deadline)?.inner().clone(), deadline);
    verdict(
        &nodes,
        &start,
        target,
        &point,
        &mut std::thread::sleep,
        deadline,
    )
}

#[cfg(test)]
#[path = "hit_tests.rs"]
mod tests;
