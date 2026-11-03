use super::absence::failure;
use super::failure::Failure;

/// What a node's own `Accessible.GetRole` says about it. The call is
/// implemented by every live node of every toolkit (L17-11), so its failure in
/// the suspect family is the corroboration a destroyed object needs. A
/// destroyed GTK3 or Chromium object keeps answering it for about 16 s
/// (L17-6, L17-8): an answering node is alive to its own reads only, and
/// presence is decided by the parent's child list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Liveness {
    Alive,
    TimedOut,
    ObjectGone,
    AppGone,
}

impl Liveness {
    /// The liveness a `GetRole` outcome shows: `None` when the call answered.
    pub(crate) fn of(role_error: Option<&zbus::Error>) -> Self {
        match role_error.map(failure) {
            None | Some(Failure::Other) => Self::Alive,
            Some(Failure::AppGone) => Self::AppGone,
            Some(Failure::Suspect) => Self::ObjectGone,
            Some(Failure::TimedOut) => Self::TimedOut,
        }
    }
}
