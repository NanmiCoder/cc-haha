#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NameEvidence {
    pub explicit_label: Option<String>,
    pub labelled_by_text: Option<String>,
    pub native_title: Option<String>,
    pub static_value: Option<String>,
    pub child_label: Option<String>,
    pub placeholder: Option<String>,
    pub description: Option<String>,
}
