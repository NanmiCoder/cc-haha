use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

use super::admit::admit_children;
use super::walker_expand::LevelReader;
use crate::system::SharedBus;
use crate::tree::properties::read_purpose::ReadPurpose;
use crate::tree::{
    AtspiElement, Expansion, NodeClass, ObservedRead, Walk, WalkCounts, WalkLimits, WalkedNode,
};

struct Pending<K> {
    key: K,
    parent: Option<usize>,
    raw: usize,
    logical: usize,
    index: usize,
    in_web: bool,
}

struct Slot<K, P> {
    key: K,
    parent: Option<usize>,
    children: Vec<usize>,
    listed: Option<u32>,
    raw: usize,
    node: WalkedNode<P>,
}

impl<K, P> Slot<K, P> {
    fn cut_short(&mut self) {
        self.node.truncated = true;
        self.node.child_count = self.listed;
    }
}

fn ancestor_path<K, P>(slots: &[Slot<K, P>], index: usize) -> Vec<&K> {
    let mut path = Vec::new();
    let mut cursor = Some(index);
    while let Some(current) = cursor {
        path.push(&slots[current].key);
        cursor = slots[current].parent;
    }
    path
}

fn mark_parents_truncated<K, P>(slots: &mut [Slot<K, P>], frontier: &[Pending<K>]) {
    for pending in frontier {
        if let Some(parent) = pending.parent {
            slots[parent].cut_short();
        }
    }
}

fn assemble<K, P>(slots: Vec<Slot<K, P>>) -> Option<WalkedNode<P>> {
    let mut built: Vec<Option<WalkedNode<P>>> = (0..slots.len()).map(|_| None).collect();
    for (index, slot) in slots.into_iter().enumerate().rev() {
        let mut node = slot.node;
        node.children = slot
            .children
            .iter()
            .filter_map(|child| built[*child].take())
            .collect();
        built[index] = Some(node);
    }
    built.first_mut().and_then(Option::take)
}

fn listed_count<K>(children: &[K], unreadable: bool) -> Option<u32> {
    (!unreadable && !children.is_empty()).then(|| u32::try_from(children.len()).unwrap_or(u32::MAX))
}

/// Breadth-first walk. `expand` reads a whole level at once and returns, for
/// each key in order, its payload and its children; `classify` says, from a
/// node's payload, whether it is a wrapper that costs no logical depth and
/// whether it opens a web document. Stops descending when the deadline has
/// passed, marking the parents of the unread level.
///
/// A node whose children would sit below the logical depth limit keeps none
/// and stays complete: the omission is the request's, and it carries the
/// length of its child list. A node at the raw depth limit, or cut short by
/// the deadline or a budget, is incomplete and carries that length too when
/// the list was read. A node whose child list could not be read, or that
/// vanished, is kept without a count and the walk is incomplete.
pub(crate) fn walk_levels<K, P>(
    root: K,
    limits: &WalkLimits,
    deadline: Deadline,
    mut expand: impl FnMut(&[K]) -> Result<Vec<Expansion<P, K>>, AdapterError>,
    classify: impl Fn(&P) -> NodeClass,
) -> Result<Walk<P>, AdapterError>
where
    K: Clone + PartialEq,
{
    let mut slots: Vec<Slot<K, P>> = Vec::new();
    let mut frontier = vec![Pending {
        key: root,
        parent: None,
        raw: 0,
        logical: 0,
        index: 0,
        in_web: limits.root_in_web,
    }];
    let (mut admitted, mut edges) = (1, 0);
    let mut complete = true;
    let mut counts = WalkCounts::default();
    while !frontier.is_empty() {
        if deadline.is_expired() {
            mark_parents_truncated(&mut slots, &frontier);
            complete = false;
            break;
        }
        let keys: Vec<K> = frontier.iter().map(|pending| pending.key.clone()).collect();
        let reads = match expand(&keys) {
            Ok(reads) => reads,
            Err(error) if error.code == ErrorCode::Timeout && !slots.is_empty() => {
                mark_parents_truncated(&mut slots, &frontier);
                complete = false;
                break;
            }
            Err(error) => return Err(error),
        };
        let mut next = Vec::new();
        for (pending, read) in frontier.into_iter().zip(reads) {
            let Expansion {
                payload,
                children,
                children_unread,
                gone,
            } = read;
            let class = classify(&payload);
            counts.note_node(class, pending.logical);
            let unreadable = children_unread || gone;
            let index = slots.len();
            if let Some(parent) = pending.parent {
                slots[parent].children.push(index);
                if gone {
                    slots[parent].cut_short();
                }
            }
            slots.push(Slot {
                key: pending.key,
                parent: pending.parent,
                children: Vec::new(),
                listed: listed_count(&children, unreadable),
                raw: pending.raw,
                node: WalkedNode {
                    payload,
                    children: Vec::new(),
                    truncated: unreadable,
                    child_count: None,
                    source_index: pending.index,
                    in_web_document: pending.in_web,
                },
            });
            complete &= !unreadable;
            if children.is_empty() {
                continue;
            }
            let child_logical = pending.logical + usize::from(!class.wrapper);
            if pending.raw >= limits.max_raw_depth {
                counts.limits.depth_hits += 1;
                slots[index].cut_short();
                complete = false;
            } else if child_logical > limits.max_logical_depth {
                let slot = &mut slots[index];
                slot.node.child_count = slot.listed;
            } else {
                let path = ancestor_path(&slots, index);
                let node_limits = WalkLimits {
                    max_children: if class.bulk {
                        limits.bulk_children.min(limits.max_children)
                    } else {
                        limits.max_children
                    },
                    ..*limits
                };
                let admission = admit_children(&children, &path, admitted, edges, &node_limits);
                counts.note_hits(&admission.hits, admission.cycles);
                edges += admission.considered;
                admitted += admission.indices.len();
                if admission.truncated {
                    slots[index].cut_short();
                    complete = false;
                }
                let child_in_web = pending.in_web || class.web_document;
                next.extend(admission.indices.into_iter().map(|child| Pending {
                    key: children[child].clone(),
                    parent: Some(index),
                    raw: pending.raw + 1,
                    logical: child_logical,
                    index: child,
                    in_web: child_in_web,
                }));
            }
        }
        frontier = next;
    }
    if slots.is_empty() {
        return Err(deadline.timeout_error());
    }
    let node_count = slots.len();
    let max_depth = slots.iter().map(|slot| slot.raw).max().unwrap_or(0);
    let root = assemble(slots).ok_or_else(|| {
        AdapterError::new(ErrorCode::Internal, "The accessibility walk read no nodes")
    })?;
    Ok(Walk {
        root,
        complete,
        node_count,
        max_depth,
        counts,
    })
}

/// Walks the tree under `root` on the shared accessibility connection.
pub(crate) fn walk_tree(
    bus: &SharedBus,
    root: &AtspiElement,
    limits: &WalkLimits,
    deadline: Deadline,
) -> Result<Walk<ObservedRead>, AdapterError> {
    walk_tree_for(bus, root, limits, deadline, ReadPurpose::Snapshot)
}

pub(in crate::tree) fn walk_tree_for(
    bus: &SharedBus,
    root: &AtspiElement,
    limits: &WalkLimits,
    deadline: Deadline,
    purpose: ReadPurpose,
) -> Result<Walk<ObservedRead>, AdapterError> {
    let connection = bus.get(deadline)?;
    let mut reader =
        LevelReader::new(connection.inner(), root, limits, deadline).for_purpose(purpose);
    walk_levels(
        root.clone(),
        limits,
        deadline,
        |level| reader.expand(level),
        super::wrapper::classify,
    )
}

pub(crate) fn walk_native_tree(
    bus: &SharedBus,
    root: &AtspiElement,
    deadline: Deadline,
) -> Result<Walk<ObservedRead>, AdapterError> {
    walk_structure(
        bus,
        root,
        &WalkLimits::default(),
        deadline,
        ReadPurpose::Gate,
    )
}

/// Walks the structure under `root`, reading what `purpose` names, and stops at
/// web documents, whose content a structural scan never classifies.
pub(crate) fn walk_structure(
    bus: &SharedBus,
    root: &AtspiElement,
    limits: &WalkLimits,
    deadline: Deadline,
    purpose: ReadPurpose,
) -> Result<Walk<ObservedRead>, AdapterError> {
    let connection = bus.get(deadline)?;
    let mut reader =
        LevelReader::new(connection.inner(), root, limits, deadline).for_purpose(purpose);
    walk_levels(
        root.clone(),
        limits,
        deadline,
        |level| {
            let mut reads = reader.expand(level)?;
            for read in &mut reads {
                if crate::tree::vocabulary::role_numbers::is_web_document(
                    read.payload.node.traits.role.present().copied(),
                ) {
                    read.children.clear();
                }
            }
            Ok(reads)
        },
        |read| NodeClass {
            web_document: crate::tree::vocabulary::role_numbers::is_web_document(
                read.node.traits.role.present().copied(),
            ),
            ..NodeClass::default()
        },
    )
}
