//! Holds modifier VKs down around a mouse click or wheel sequence.
//!
//! A full chord primitive (release-guard sweep against live key state,
//! blocked-combo canonicalization) belongs to keyboard synthesis; this is
//! the minimal press/release a pointer event needs. It posts through
//! `keyboard_send`, the crate's one `SendInput` keyboard seam, rather than
//! opening a second: two independent seams would mean any change to how a
//! key event is framed - scan codes, extended-key flags, an injection tag
//! in `dwExtraInfo` - silently applied to chords but not to the modifiers
//! held around a click.
//!
//! `ModifierGuard::drop` always posts the release, so an aborted sequence
//! cannot leave a modifier held - best-effort, like every other physical
//! post here: the release is sent, never verified.

use agent_desktop_core::Modifier;

use crate::input::keyboard::keyboard_event::{key_input, modifier_vk};
use crate::input::keyboard::keyboard_send::post_keyboard_inputs;

pub(crate) struct ModifierGuard {
    held: Vec<u16>,
    released: bool,
}

impl ModifierGuard {
    pub(crate) fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        for vk in self.held.iter().rev().copied() {
            post_keyboard_inputs(&[key_input(vk, true)]);
        }
    }
}

impl Drop for ModifierGuard {
    fn drop(&mut self) {
        self.release();
    }
}

pub(crate) fn press_modifiers(modifiers: &[Modifier]) -> ModifierGuard {
    let held: Vec<u16> = modifiers.iter().map(modifier_vk).collect();
    for &vk in &held {
        post_keyboard_inputs(&[key_input(vk, false)]);
    }
    ModifierGuard {
        held,
        released: false,
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "mouse_modifier_tests.rs"]
mod tests;
