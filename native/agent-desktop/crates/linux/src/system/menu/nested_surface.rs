/// A dialog drawn inside the tree of the window at `window`: the id is the
/// dialog's own address, which no window shares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Nested {
    pub(crate) window: usize,
    pub(crate) id: String,
    pub(crate) title: Option<String>,
}
