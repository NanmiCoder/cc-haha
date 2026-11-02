/// The toolkit an application reports on its root, when it answered.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ToolkitId {
    pub(crate) name: Option<String>,
    pub(crate) version: Option<String>,
}
