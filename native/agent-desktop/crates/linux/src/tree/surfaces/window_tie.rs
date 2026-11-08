/// What is known of a window whose display client cannot be told from the
/// client of a twin window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowTie {
    /// What the tied clients all say about the window being hidden, when they
    /// agree.
    pub(crate) hidden: Option<bool>,
}
