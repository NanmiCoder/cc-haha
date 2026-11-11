//! Modifier chords: press modifiers down, press/release the key, release
//! modifiers - with a release guard that sweeps any key its own bookkeeping
//! still believes is held once the sequence ends, whether it ended cleanly
//! or was interrupted (the modifier-release sweep, A4-2).
//!
//! Unlike `mouse_modifier::ModifierGuard`, which always posts the keys it
//! holds on drop, `KeyReleaseGuard` additionally reads live key state
//! (`GetAsyncKeyState`) before sweeping: a key this guard still lists as
//! held but that the OS no longer reports as down is not re-pressed by a
//! spurious release.

use agent_desktop_core::{AdapterError, Deadline, KeyCombo, Modifier};

use crate::input::keyboard::keyboard_map;
use crate::input::keyboard::keyboard_send::{
    KeyboardInputEvent, key_is_down, post_keyboard_inputs,
};
use crate::input::mouse::sleep_bounded;
use crate::input::release_state::ReleaseState;
use std::time::Duration;

const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;
const VK_MENU: u16 = 0x12;
const VK_LWIN: u16 = 0x5B;
const KEYEVENTF_KEYUP: u32 = 0x0002;
const KEY_SETTLE: Duration = Duration::from_millis(4);
const KEY_RELEASE_SUGGESTION: &str = "Inspect which modifiers may still be held before retrying; the emergency release was posted without an OS acknowledgement";

#[cfg(target_os = "windows")]
const _: () = {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse as win32;
    assert!(VK_SHIFT == win32::VK_SHIFT);
    assert!(VK_CONTROL == win32::VK_CONTROL);
    assert!(VK_MENU == win32::VK_MENU);
    assert!(VK_LWIN == win32::VK_LWIN);
    assert!(KEYEVENTF_KEYUP == win32::KEYEVENTF_KEYUP);
};

pub(crate) fn synthesize_key(combo: &KeyCombo, deadline: Deadline) -> Result<(), AdapterError> {
    deadline.ensure_remaining()?;
    let resolved = keyboard_map::resolve_key(&combo.key)?;
    let modifier_vks = chord_modifiers(combo, resolved);
    let key_vk = resolved.vk;

    let mut guard = KeyReleaseGuard::new();
    let outcome = press_chord(&mut guard, &modifier_vks, key_vk, deadline);
    outcome.map_err(|error| guard.enrich_error(error))
}

fn press_chord(
    guard: &mut KeyReleaseGuard,
    modifier_vks: &[u16],
    key_vk: u16,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    for &vk in modifier_vks {
        deadline.ensure_remaining()?;
        post_keyboard_inputs(&[key_input(vk, false)]);
        guard.note_pressed(vk);
    }
    deadline.ensure_remaining()?;
    post_keyboard_inputs(&[key_input(key_vk, false)]);
    guard.note_pressed(key_vk);

    sleep_bounded(deadline, KEY_SETTLE)?;

    post_keyboard_inputs(&[key_input(key_vk, true)]);
    guard.note_released(key_vk);
    for &vk in modifier_vks.iter().rev() {
        deadline.ensure_remaining()?;
        post_keyboard_inputs(&[key_input(vk, true)]);
        guard.note_released(vk);
    }
    Ok(())
}

/// The caller's modifiers, plus any the active layout needs to produce this
/// character, without pressing the same modifier twice.
fn chord_modifiers(combo: &KeyCombo, resolved: keyboard_map::ResolvedKey) -> Vec<u16> {
    let mut vks: Vec<u16> = combo.modifiers.iter().map(modifier_vk).collect();
    for vk in resolved.layout_modifier_vks() {
        if !vks.contains(&vk) {
            vks.push(vk);
        }
    }
    vks
}

pub(crate) fn modifier_vk(modifier: &Modifier) -> u16 {
    match modifier {
        Modifier::Meta => VK_LWIN,
        Modifier::Ctrl => VK_CONTROL,
        Modifier::Alt => VK_MENU,
        Modifier::Shift => VK_SHIFT,
    }
}

pub(crate) fn key_input(vk: u16, key_up: bool) -> KeyboardInputEvent {
    KeyboardInputEvent {
        vk,
        scan: 0,
        flags: if key_up { KEYEVENTF_KEYUP } else { 0 },
    }
}

/// Tracks which virtual keys this chord believes it has pressed and not yet
/// released. `Drop` sweeps whatever remains, gated per key on a live
/// `GetAsyncKeyState` read so an already-released key already, or a key
/// another actor released, is never re-pressed by a stale sweep.
pub(crate) struct KeyReleaseGuard {
    held: Vec<u16>,
    state: ReleaseState,
}

impl KeyReleaseGuard {
    pub(crate) fn new() -> Self {
        Self {
            held: Vec::new(),
            state: ReleaseState::default(),
        }
    }

    pub(crate) fn note_pressed(&mut self, vk: u16) {
        self.held.push(vk);
        self.state.arm();
        self.state.mark_delivered();
    }

    pub(crate) fn note_released(&mut self, vk: u16) {
        self.held.retain(|&held_vk| held_vk != vk);
        if self.held.is_empty() {
            self.state.disarm();
        }
        self.state.mark_delivered();
    }

    pub(crate) fn enrich_error(&self, error: AdapterError) -> AdapterError {
        self.state.enrich_error(error, KEY_RELEASE_SUGGESTION)
    }
}

impl Drop for KeyReleaseGuard {
    fn drop(&mut self) {
        for vk in self.held.iter().rev().copied() {
            if key_is_down(vk) {
                post_keyboard_inputs(&[key_input(vk, true)]);
            }
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "keyboard_event_tests.rs"]
mod tests;
