use super::nested_surface::Nested;

/// What a scan of the windows of one application found, and whether it read
/// every window to the end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NestedScan {
    pub(crate) found: Vec<Nested>,
    /// The menus the windows hold or are, keyed on the window's own id for a
    /// window that is itself a menu and on the popup's address for a menu
    /// drawn inside a window.
    pub(crate) menus: Vec<Nested>,
    pub(crate) complete: bool,
    /// The windows whose trees were not read to the end, by position.
    pub(crate) unread: Vec<usize>,
}

impl NestedScan {
    pub(crate) fn complete_and_empty() -> Self {
        Self {
            found: Vec::new(),
            menus: Vec::new(),
            complete: true,
            unread: Vec::new(),
        }
    }
}
