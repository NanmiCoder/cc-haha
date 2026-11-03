//! The one seam that calls `SendInput`/`GetAsyncKeyState` for keyboard events.
//!
//! Mirrors `mouse_send.rs`: `SendInput`'s return value is never treated as
//! delivery evidence (A9-3), so posting is fire-and-forget here too. The real
//! native calls live behind `#[cfg(not(test))]`, a compile-time guarantee no
//! test in this crate can bypass; test builds record into thread-local fakes
//! instead - one for posted events, one for the live key-state read the
//! release guard's abort sweep depends on.
//!
//! One deliberate exception posts outside this seam: the shell-surface chord
//! path (`system/shell/shell_surface_raise.rs`) calls `SendInput` and
//! `GetAsyncKeyState` directly. This seam's stubs are what keep unit tests
//! from emitting real input, and the shell-surface live tests ARE the
//! verification - their assertions read real desktop state (a raised surface,
//! a dismissed one), which a recorded fake cannot produce. Routing the shell
//! chords through this seam would make every such leg skip or fail on the
//! stub, and adding a test-only "emit for real" mode here would drag
//! `cfg(test)` hooks into the shipped raise path. The duplicate is the
//! exception's own seam, held to the same contract: its `SendInput` returns
//! are never delivery evidence either (A9-3) - the chord is posted and the
//! outcome is verified by observation alone - and its release guard applies
//! the same live-key-state discipline as the shared seam's abort sweep.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct KeyboardInputEvent {
    pub(crate) vk: u16,
    pub(crate) scan: u16,
    pub(crate) flags: u32,
}

pub(crate) fn post_keyboard_inputs(events: &[KeyboardInputEvent]) {
    imp::post_keyboard_inputs(events);
}

pub(crate) fn key_is_down(vk: u16) -> bool {
    imp::key_is_down(vk)
}

#[cfg(target_os = "windows")]
mod imp {
    use super::KeyboardInputEvent;

    pub(super) fn post_keyboard_inputs(events: &[KeyboardInputEvent]) {
        #[cfg(test)]
        {
            super::keyboard_send_fake_sink::record(events);
        }
        #[cfg(not(test))]
        {
            native::send(events);
        }
    }

    pub(super) fn key_is_down(vk: u16) -> bool {
        #[cfg(test)]
        {
            super::key_state_fake_sink::is_down(vk)
        }
        #[cfg(not(test))]
        {
            native::key_is_down(vk)
        }
    }

    #[cfg(not(test))]
    mod native {
        use super::KeyboardInputEvent;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, SendInput,
        };

        pub(super) fn send(events: &[KeyboardInputEvent]) {
            if events.is_empty() {
                return;
            }
            let raw: Vec<INPUT> = events.iter().copied().map(to_raw).collect();
            unsafe {
                SendInput(
                    raw.len() as u32,
                    raw.as_ptr(),
                    core::mem::size_of::<INPUT>() as i32,
                );
            }
        }

        pub(super) fn key_is_down(vk: u16) -> bool {
            let state = unsafe { GetAsyncKeyState(i32::from(vk)) };
            (state as u16 & 0x8000) != 0
        }

        fn to_raw(event: KeyboardInputEvent) -> INPUT {
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: event.vk,
                        wScan: event.scan,
                        dwFlags: event.flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::KeyboardInputEvent;

    pub(super) fn post_keyboard_inputs(_events: &[KeyboardInputEvent]) {}

    pub(super) fn key_is_down(_vk: u16) -> bool {
        false
    }
}

crate::input::define_input_fake_sink!(
    keyboard_send_fake_sink,
    crate::input::keyboard::keyboard_send::KeyboardInputEvent
);

#[cfg(all(test, target_os = "windows"))]
pub(crate) mod key_state_fake_sink {
    use std::cell::RefCell;
    use std::collections::HashSet;

    thread_local! {
        static DOWN: RefCell<HashSet<u16>> = RefCell::new(HashSet::new());
    }

    pub(crate) fn reset() {
        DOWN.with(|cell| cell.borrow_mut().clear());
    }

    pub(crate) fn set_down(vk: u16) {
        DOWN.with(|cell| cell.borrow_mut().insert(vk));
    }

    pub(super) fn is_down(vk: u16) -> bool {
        DOWN.with(|cell| cell.borrow().contains(&vk))
    }
}
