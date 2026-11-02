use crate::tree::NodeAttrs;
use crate::tree::properties::node_attribute_status::NodeAttributeStatus;
use crate::tree::properties::node_identifiers::NodeIdentifiers;

pub(crate) struct NodeAttributeRead {
    pub(crate) attrs: NodeAttrs,
    pub(crate) identifiers: NodeIdentifiers,
    pub(crate) metrics: super::node_attribute_metrics::NodeAttributeMetrics,
    pub(crate) status: NodeAttributeStatus,
}
