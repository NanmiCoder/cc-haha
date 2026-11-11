/// One visited node with the children the walk descended into. `truncated`
/// is set when children exist that the walk did not read. `child_count` is the
/// length of the child list when it was read and the subtree is cut short.
/// `source_index` is the node's place in its parent's child list, kept when
/// siblings are skipped so refs derived from it stay in document order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WalkedNode<P> {
    pub(crate) payload: P,
    pub(crate) children: Vec<WalkedNode<P>>,
    pub(crate) truncated: bool,
    pub(crate) child_count: Option<u32>,
    pub(crate) source_index: usize,
    pub(crate) in_web_document: bool,
}
