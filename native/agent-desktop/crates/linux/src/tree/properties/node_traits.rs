use crate::tree::Field;

/// What a node is: numeric role, role name, state bit words and the
/// interfaces it implements. The numeric role is the portable key; the role
/// name is a toolkit-local string (GTK4 answers ARIA-style labels).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NodeTraits {
    pub(crate) role: Field<u32>,
    pub(crate) role_name: Field<String>,
    pub(crate) states: Field<Vec<u32>>,
    pub(crate) interfaces: Field<Vec<String>>,
}

impl NodeTraits {
    pub(crate) fn failed(detail: &str) -> Self {
        Self {
            role: Field::Failed(detail.to_owned()),
            role_name: Field::Failed(detail.to_owned()),
            states: Field::Failed(detail.to_owned()),
            interfaces: Field::Failed(detail.to_owned()),
        }
    }
}
