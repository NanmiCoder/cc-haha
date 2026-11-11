/// What reading one node on the way down a stored path yields: its children
/// in the order the walk indexes them, and what the read could not settle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Level<K> {
    pub(crate) children: Vec<K>,
    pub(crate) children_unread: bool,
    pub(crate) empty_means_unread: bool,
}
