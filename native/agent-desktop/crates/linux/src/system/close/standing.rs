use super::refusal;
use super::world::World;
use crate::system::x11::control::ControlRead;
use crate::system::x11::window::toplevel::Toplevel;

/// One read of what a process shows that a close request must not answer: its
/// top-level windows, and the titles of the dialogs drawn inside them, which no
/// list of top-level windows holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Standing {
    pub(super) windows: Vec<Toplevel>,
    pub(super) nested: Vec<String>,
}

impl Standing {
    pub(super) fn of(world: &impl World, windows: Vec<Toplevel>) -> Self {
        Self {
            windows,
            nested: world.nested_dialogs(),
        }
    }

    pub(super) fn read(world: &impl World) -> Option<Self> {
        match world.toplevels() {
            ControlRead::Ready(windows) => Some(Self::of(world, windows)),
            _ => None,
        }
    }

    pub(super) fn has_dialog(&self) -> bool {
        !self.nested.is_empty() || self.windows.iter().any(refusal::is_dialog)
    }
}
