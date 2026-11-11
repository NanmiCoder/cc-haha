#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct NodeSemanticStates {
    pub(crate) hidden: Option<bool>,
    pub(crate) busy: Option<bool>,
    pub(crate) modal: Option<bool>,
    pub(crate) required: Option<bool>,
}
