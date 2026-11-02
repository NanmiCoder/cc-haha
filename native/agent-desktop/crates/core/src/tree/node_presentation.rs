use serde::{Deserialize, Serialize};

use crate::{NodeDescriptor, Rect};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NodePresentation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub states: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub available_actions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Rect>,
    /// The window-relative rectangle a ref stores when the public `bounds`
    /// cannot identify an element. Not part of the output envelope.
    #[serde(skip)]
    pub ref_bounds: Option<Rect>,
    #[serde(flatten)]
    pub descriptors: NodeDescriptor,
}
