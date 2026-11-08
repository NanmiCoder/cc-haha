use std::time::Duration;

use super::keyboard::keymap_edit::KeymapEdit;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Step {
    CheckTextState,
    Key { code: u8, down: bool },
    Button { code: u8, down: bool },
    MoveTo { x: i32, y: i32 },
    Pause(Duration),
    Keymap(KeymapEdit),
}
