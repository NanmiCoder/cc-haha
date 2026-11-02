use crate::AppError;

/// Which surface-lifecycle condition a `wait` targets: `--menu`,
/// `--menu-closed`, or `--notification`. One variant per flag makes the three
/// modes structurally mutually exclusive.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SurfaceWait {
    Menu,
    MenuClosed,
    Notification,
}

impl SurfaceWait {
    pub fn from_flags(
        menu: bool,
        menu_closed: bool,
        notification: bool,
    ) -> Result<Option<Self>, AppError> {
        match (menu, menu_closed, notification) {
            (false, false, false) => Ok(None),
            (true, false, false) => Ok(Some(Self::Menu)),
            (false, true, false) => Ok(Some(Self::MenuClosed)),
            (false, false, true) => Ok(Some(Self::Notification)),
            _ => Err(crate::commands::wait_mode::ambiguous_wait_mode()),
        }
    }
}

#[cfg(test)]
#[path = "wait_surface_tests.rs"]
mod tests;
