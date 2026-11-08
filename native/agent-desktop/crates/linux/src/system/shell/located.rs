use super::light::Light;

/// An anchor found in the tree and the container it stands for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Located {
    pub(crate) anchor: Light,
    pub(crate) container: Light,
}
