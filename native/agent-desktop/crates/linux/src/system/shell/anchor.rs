use super::container::Landmark;

/// A requested shell container or opener, requiring structural identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Anchor {
    Landmark(Landmark),
    SystemButton,
}
