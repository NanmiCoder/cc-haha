#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct NodeControlStates {
    pub(crate) focused: Option<bool>,
    pub(crate) expanded: Option<bool>,
    pub(crate) disclosing: Option<bool>,
    pub(crate) selected: Option<bool>,
    pub(crate) readonly: Option<bool>,
}
