#[derive(Debug, Clone, Copy)]
pub(crate) struct ObservationCompleteness {
    pub(crate) subtree_complete: bool,
    pub(crate) predecessors_complete: bool,
}

impl ObservationCompleteness {
    pub(crate) fn new(subtree_complete: bool) -> Self {
        Self {
            subtree_complete,
            predecessors_complete: true,
        }
    }
}
