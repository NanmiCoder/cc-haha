/// Where a stored path ended. `element` is the node it reached, if any;
/// `unread` says a level could not be read, so a missing element is not proof
/// that the path leads nowhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Landing<K> {
    pub(crate) element: Option<K>,
    pub(crate) unread: bool,
}

impl<K> Landing<K> {
    pub(in crate::tree) fn nowhere() -> Self {
        Self {
            element: None,
            unread: false,
        }
    }

    pub(in crate::tree) fn unread() -> Self {
        Self {
            element: None,
            unread: true,
        }
    }
}
