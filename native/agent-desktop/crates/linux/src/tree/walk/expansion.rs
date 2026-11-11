/// What reading one node of a level produced: its payload and the children to
/// descend into. `children_unread` is set when the node's child list could not
/// be read, so its subtree is unknown; `gone` is set when the node vanished
/// from the bus after its parent listed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Expansion<P, K> {
    pub(crate) payload: P,
    pub(crate) children: Vec<K>,
    pub(crate) children_unread: bool,
    pub(crate) gone: bool,
}

impl<P, K> Expansion<P, K> {
    #[cfg(test)]
    pub(crate) fn read(payload: P, children: Vec<K>) -> Self {
        Self {
            payload,
            children,
            children_unread: false,
            gone: false,
        }
    }
}
