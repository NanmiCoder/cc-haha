use super::{node_control_states::NodeControlStates, node_semantic_states::NodeSemanticStates};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NodeAttrStates {
    pub(crate) enabled: bool,
    pub(crate) control: NodeControlStates,
    pub(crate) semantic: NodeSemanticStates,
}

impl Default for NodeAttrStates {
    fn default() -> Self {
        Self {
            enabled: true,
            control: NodeControlStates::default(),
            semantic: NodeSemanticStates::default(),
        }
    }
}
