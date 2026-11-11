use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

use super::light::{Light, Nodes, same_object};
use crate::tree::AtspiElement;

const MAX_NODES: usize = 8_000;

/// One node of a walk with the place it holds in the tree. `parent` and
/// `children` index the walk's own list.
#[derive(Debug, Clone)]
pub(crate) struct Visit {
    pub(crate) light: Light,
    pub(crate) parent: Option<usize>,
    pub(crate) children: Vec<usize>,
}

/// The nodes under a root in paint order: a node comes before its children
/// and an earlier child before a later one, so of two nodes over the same
/// point the later one is on top. `complete` is false when a node left the
/// tree between its parent's listing and its own read.
#[derive(Debug, Clone)]
pub(crate) struct Walk {
    pub(crate) visits: Vec<Visit>,
    pub(crate) complete: bool,
}

impl Walk {
    /// Whether `node` is `ancestor` or stands below it.
    pub(crate) fn within(&self, mut node: usize, ancestor: usize) -> bool {
        loop {
            if node == ancestor {
                return true;
            }
            match self.visits[node].parent {
                Some(parent) => node = parent,
                None => return false,
            }
        }
    }

    pub(crate) fn position(&self, element: &AtspiElement) -> Option<usize> {
        self.visits
            .iter()
            .position(|visit| same_object(&visit.light.element, element))
    }
}

/// Reads the tree under `root` level by level and lists it in paint order.
/// Nodes `prune` accepts are neither listed nor entered. A budget spent or
/// exceeded is an error, never a shorter tree.
pub(crate) fn walk<N: Nodes>(
    nodes: &N,
    root: &AtspiElement,
    deadline: Deadline,
    prune: &dyn Fn(&Light) -> bool,
) -> Result<Walk, AdapterError> {
    let mut arena: Vec<Visit> = Vec::new();
    let mut complete = true;
    let mut frontier: Vec<(AtspiElement, Option<usize>)> = vec![(root.clone(), None)];
    while !frontier.is_empty() {
        if deadline.is_expired() {
            return Err(deadline.timeout_error());
        }
        let elements: Vec<AtspiElement> = frontier
            .iter()
            .map(|(element, _)| element.clone())
            .collect();
        let reads = nodes.read_level(&elements);
        let mut next = Vec::new();
        for ((_, parent), read) in frontier.drain(..).zip(reads) {
            let light = match read {
                Ok(light) => light,
                Err(error) if error.code == ErrorCode::ElementNotFound => {
                    complete = false;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if prune(&light) {
                continue;
            }
            let index = arena.len();
            next.extend(
                light
                    .children
                    .iter()
                    .map(|child| (child.clone(), Some(index))),
            );
            if let Some(parent) = parent {
                arena[parent].children.push(index);
            }
            arena.push(Visit {
                light,
                parent,
                children: Vec::new(),
            });
        }
        if arena.len() > MAX_NODES {
            return Err(AdapterError::timeout(
                "The shell tree exceeded the search budget",
            ));
        }
        frontier = next;
    }
    Ok(Walk {
        visits: in_paint_order(arena),
        complete,
    })
}

fn in_paint_order(arena: Vec<Visit>) -> Vec<Visit> {
    let mut order = Vec::with_capacity(arena.len());
    let mut stack = if arena.is_empty() { vec![] } else { vec![0] };
    while let Some(index) = stack.pop() {
        order.push(index);
        stack.extend(arena[index].children.iter().rev());
    }
    let mut place = vec![0; arena.len()];
    for (new, old) in order.iter().enumerate() {
        place[*old] = new;
    }
    let mut slots: Vec<Option<Visit>> = arena.into_iter().map(Some).collect();
    order
        .into_iter()
        .filter_map(|old| slots[old].take())
        .map(|mut visit| {
            visit.parent = visit.parent.map(|parent| place[parent]);
            visit.children = visit.children.iter().map(|child| place[*child]).collect();
            visit
        })
        .collect()
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;
