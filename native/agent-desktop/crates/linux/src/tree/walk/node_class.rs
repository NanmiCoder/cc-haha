/// What the walk needs to know about a node before it admits the node's
/// children: whether the node costs a level of logical depth, and whether it
/// opens a web document.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct NodeClass {
    pub(crate) wrapper: bool,
    pub(crate) web_document: bool,
    /// A list, table or tree, whose many rows a walk may read in part.
    pub(crate) bulk: bool,
}
