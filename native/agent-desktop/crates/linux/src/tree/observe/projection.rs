use crate::tree::placement::Placement;
use crate::tree::placement::snapshot_visibility::{SnapshotVisibility, append_visibility};
use agent_desktop_core::{
    IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence, LocatorStats,
    ObservedSubtree, Rect,
};

use super::decorate::Decorate;
use crate::tree::capabilities::action_names::capabilities;
use crate::tree::capabilities::value_read::truncate_to_boundary;
use crate::tree::vocabulary::resolve_vocabulary;
use crate::tree::{Extents, Field, ObservedRead, Walk, WalkLimits, WalkedNode};

/// The extents as evidence a ref can hold. A rectangle core cannot store (a
/// negative size, or the `INT32_MIN` a toolkit reports for a node off every
/// screen) is the node having no usable extents, not a failed read.
fn bounds_of(extents: &Field<Extents>) -> LocatorField<Rect> {
    match extents {
        Field::Present(extents) => {
            let rect = Rect::from(*extents);
            if rect.validate().is_ok() {
                LocatorField::Known(rect)
            } else {
                LocatorField::Absent
            }
        }
        Field::Absent => LocatorField::Absent,
        Field::Failed(_) => LocatorField::Unknown,
    }
}

fn window_bounds(read: &ObservedRead) -> LocatorField<Rect> {
    match read.evidence_bounds {
        Some((extents, agent_desktop_core::BoundsSpace::Window)) => {
            bounds_of(&Field::Present(extents))
        }
        _ if read.node.extents.is_failed() => LocatorField::Unknown,
        _ => LocatorField::Absent,
    }
}

/// Whether the node's read settled enough to say its identifier and stable
/// text do not name it. An unreadable field could hide a name, so it withholds
/// the claim.
fn identity_is_absent(
    role: &LocatorField<String>,
    name: &LocatorField<String>,
    description: &LocatorField<String>,
    value: &LocatorField<String>,
    identifiers: &IdentifierEvidence,
) -> bool {
    let settled = !role.is_unknown()
        && !name.is_unknown()
        && !description.is_unknown()
        && !value.is_unknown()
        && identifiers.is_complete();
    settled
        && !agent_desktop_core::refs::ref_identity::identity_fields_are_meaningful(
            role.known().map(String::as_str).unwrap_or_default(),
            name.known().map(String::as_str),
            value.known().map(String::as_str),
            description.known().map(String::as_str),
            identifiers.preferred_value(),
        )
}

fn value_of(read: &ObservedRead) -> LocatorField<String> {
    match &read.value.value {
        Field::Present(text) => LocatorField::Known(text.clone()),
        Field::Absent => LocatorField::Absent,
        Field::Failed(_) => LocatorField::Unknown,
    }
}

struct Projector<'a> {
    limits: &'a WalkLimits,
    stats: LocatorStats,
}

impl Projector<'_> {
    fn capped(&mut self, field: LocatorField<String>) -> LocatorField<String> {
        match field {
            LocatorField::Known(text) => {
                let (kept, cut) = truncate_to_boundary(text, self.limits.max_field_bytes);
                self.stats.traversal.limits.text_hits += u64::from(cut);
                LocatorField::Known(kept)
            }
            other => other,
        }
    }

    fn failures_of(read: &ObservedRead) -> u64 {
        let label = matches!(read.label, crate::tree::LabelOutcome::Failed);
        (read.node.failed_reads() + usize::from(read.value.value.is_failed()) + usize::from(label))
            as u64
    }

    fn evidence_of(&mut self, read: &ObservedRead, in_web_document: bool) -> LocatorEvidence {
        let vocabulary = resolve_vocabulary(&read.node, &read.label, in_web_document);
        let truncated_value = u64::from(read.value.truncated);
        self.stats.traversal.limits.text_hits += truncated_value;
        let identifiers = vocabulary.identifiers.identifiers().len() as u64;
        self.stats.identifiers.values_observed += identifiers;
        self.stats.identifiers.nodes_with_identifiers += u64::from(identifiers > 0);
        self.stats.identifiers.nodes_with_multiple_identifiers += u64::from(identifiers > 1);
        self.stats.reads.health.native_read_failures += Self::failures_of(read);
        self.stats.reads.counts.action_reads += u64::from(read.node.actions.present().is_some());
        let name = self.capped(vocabulary.name);
        let description = self.capped(vocabulary.description);
        let value = value_of(read);
        let window_bounds = window_bounds(read);
        let bounds = bounds_of(&read.node.extents);
        let identity_is_absent = identity_is_absent(
            &vocabulary.role,
            &name,
            &description,
            &value,
            &vocabulary.identifiers,
        );
        let identifiers = if identity_is_absent {
            vocabulary
                .identifiers
                .with_retained_object(read.node.element.object_identity())
        } else {
            vocabulary.identifiers
        };
        let mut evidence = LocatorEvidence {
            role: vocabulary.role,
            name,
            description,
            value,
            identifiers,
            states: vocabulary.states,
            ref_evidence: LocatorRefEvidence {
                window_bounds,
                bounds,
                available_actions: capabilities(&read.node),
                descriptors: vocabulary.descriptor,
            },
        };
        append_visibility(read, &mut evidence, &Placement::default());
        evidence
    }

    fn subtree(
        &mut self,
        node: WalkedNode<ObservedRead>,
        is_root: bool,
        decorate: &mut dyn Decorate,
        visibility: &SnapshotVisibility,
    ) -> ObservedSubtree {
        let mut evidence = self.evidence_of(&node.payload, node.in_web_document);
        visibility.append(&node.payload, &mut evidence);
        let WalkedNode {
            payload,
            children,
            truncated,
            child_count,
            source_index,
            ..
        } = node;
        let after_own = children
            .iter()
            .map(|child| child.source_index + 1)
            .max()
            .unwrap_or(0)
            .max(child_count.map_or(0, |count| count as usize));
        let mut appended = decorate.decorate(&payload, &mut evidence, after_own);
        let end = after_own + appended.len();
        let mut children: Vec<ObservedSubtree> = children
            .into_iter()
            .map(|child| self.subtree(child, false, decorate, visibility))
            .collect();
        children.append(&mut appended);
        if is_root {
            children.append(&mut decorate.finish(end));
        }
        ObservedSubtree::new(evidence, children, !truncated, child_count)
            .with_source_child_index(source_index)
    }
}

/// The evidence of one node read, exactly as a walk projects it: a ref taken
/// from a snapshot and a node read later through this function agree on every
/// field the node's own reads decide.
pub(crate) fn project_node(
    read: &ObservedRead,
    in_web_document: bool,
    limits: &WalkLimits,
) -> LocatorEvidence {
    Projector {
        limits,
        stats: LocatorStats::default(),
    }
    .evidence_of(read, in_web_document)
}

/// Turns a finished walk into core's observed subtree and the statistics of
/// the walk. Every field is known, absent or unknown exactly as it was read:
/// a read that failed is unknown, never an empty value.
#[cfg(test)]
pub(crate) fn project(
    walk: Walk<ObservedRead>,
    limits: &WalkLimits,
) -> (ObservedSubtree, LocatorStats) {
    project_with(walk, limits, &mut super::decorate::Plain, None)
}

/// `project`, with a hook that may decorate nodes and append its own.
pub(crate) fn project_with(
    walk: Walk<ObservedRead>,
    limits: &WalkLimits,
    decorate: &mut dyn Decorate,
    displays: Option<&[Extents]>,
) -> (ObservedSubtree, LocatorStats) {
    decorate.prepare(&walk.root);
    let mut projector = Projector {
        limits,
        stats: LocatorStats::default(),
    };
    let counts = walk.counts;
    projector.stats.traversal.nodes_visited = walk.node_count as u64;
    projector.stats.traversal.max_raw_depth = u8::try_from(walk.max_depth).unwrap_or(u8::MAX);
    projector.stats.traversal.max_logical_depth =
        u8::try_from(counts.max_logical_depth).unwrap_or(u8::MAX);
    projector.stats.traversal.web_wrapper_nodes = counts.wrapper_nodes;
    projector.stats.traversal.cycles_skipped = counts.cycles_skipped;
    projector.stats.traversal.limits = counts.limits;
    projector.stats.reads.counts.observation_attempts = 1;
    projector.stats.reads.counts.child_reads = walk.node_count as u64;
    let visibility = SnapshotVisibility::new(&walk.root, displays);
    let subtree = projector.subtree(walk.root, true, decorate, &visibility);
    (subtree, projector.stats)
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "projection_visibility_tests.rs"]
mod visibility_tests;
