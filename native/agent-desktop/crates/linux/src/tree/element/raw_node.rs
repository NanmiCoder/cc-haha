use std::collections::BTreeMap;

use crate::tree::{AtspiElement, Extents, Field, NodeProperties, NodeTraits};

/// Bus name and object path of a child as `GetChildren` reports it.
pub(crate) type ChildAddress = (String, String);

/// Everything read for one node, each piece with its own outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawNode {
    pub(crate) element: AtspiElement,
    pub(crate) properties: NodeProperties,
    pub(crate) traits: NodeTraits,
    pub(crate) attributes: Field<BTreeMap<String, String>>,
    pub(crate) extents: Field<Extents>,
    pub(crate) actions: Field<Vec<String>>,
    pub(crate) children: Field<Vec<ChildAddress>>,
}

impl RawNode {
    /// A node whose every read failed, kept in place so the walk can go on.
    pub(crate) fn unreadable(element: AtspiElement, detail: &str) -> Self {
        Self {
            element,
            properties: NodeProperties::failed(detail),
            traits: NodeTraits::failed(detail),
            attributes: Field::Failed(detail.to_owned()),
            extents: Field::Failed(detail.to_owned()),
            actions: Field::Failed(detail.to_owned()),
            children: Field::Failed(detail.to_owned()),
        }
    }

    /// The name and failure detail of every field whose read failed.
    pub(crate) fn failures(&self) -> Vec<(&'static str, &str)> {
        [
            failure("name", &self.properties.name),
            failure("description", &self.properties.description),
            failure("child_count", &self.properties.child_count),
            failure("accessible_id", &self.properties.accessible_id),
            failure("role", &self.traits.role),
            failure("role_name", &self.traits.role_name),
            failure("states", &self.traits.states),
            failure("interfaces", &self.traits.interfaces),
            failure("attributes", &self.attributes),
            failure("extents", &self.extents),
            failure("actions", &self.actions),
            failure("children", &self.children),
        ]
        .into_iter()
        .flatten()
        .collect()
    }

    /// The number of fields whose read failed.
    pub(crate) fn failed_reads(&self) -> usize {
        self.failures().len()
    }
}

fn failure<'a, T>(name: &'static str, field: &'a Field<T>) -> Option<(&'static str, &'a str)> {
    match field {
        Field::Failed(detail) => Some((name, detail.as_str())),
        Field::Present(_) | Field::Absent => None,
    }
}
