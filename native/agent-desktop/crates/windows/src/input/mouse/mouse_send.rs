//! The one seam that calls `SendInput` for mouse events.
//!
//! `SendInput`'s return value is never treated as delivery evidence (A9-3:
//! it reports success in both the delivered and UIPI-blocked arms), so this
//! module does not surface it as a `Result` - callers post best-effort and
//! judge effect upstream where a re-read exists.
//!
//! The real native call lives behind `#[cfg(not(test))]`, so no test in this
//! crate can reach it: that is a compile-time guarantee, not a runtime
//! check that a careless test could bypass. Test builds record into a
//! thread-local fake sink instead.

pub(crate) const MOUSEEVENTF_MOVE: u32 = 0x0001;
pub(crate) const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
pub(crate) const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
pub(crate) const MOUSEEVENTF_RIGHTDOWN: u32 = 0x0008;
pub(crate) const MOUSEEVENTF_RIGHTUP: u32 = 0x0010;
pub(crate) const MOUSEEVENTF_MIDDLEDOWN: u32 = 0x0020;
pub(crate) const MOUSEEVENTF_MIDDLEUP: u32 = 0x0040;
pub(crate) const MOUSEEVENTF_WHEEL: u32 = 0x0800;
pub(crate) const MOUSEEVENTF_HWHEEL: u32 = 0x1000;
pub(crate) const MOUSEEVENTF_VIRTUALDESK: u32 = 0x4000;
pub(crate) const MOUSEEVENTF_ABSOLUTE: u32 = 0x8000;

#[cfg(target_os = "windows")]
const _: () = {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse as win32;
    assert!(MOUSEEVENTF_MOVE == win32::MOUSEEVENTF_MOVE);
    assert!(MOUSEEVENTF_LEFTDOWN == win32::MOUSEEVENTF_LEFTDOWN);
    assert!(MOUSEEVENTF_LEFTUP == win32::MOUSEEVENTF_LEFTUP);
    assert!(MOUSEEVENTF_RIGHTDOWN == win32::MOUSEEVENTF_RIGHTDOWN);
    assert!(MOUSEEVENTF_RIGHTUP == win32::MOUSEEVENTF_RIGHTUP);
    assert!(MOUSEEVENTF_MIDDLEDOWN == win32::MOUSEEVENTF_MIDDLEDOWN);
    assert!(MOUSEEVENTF_MIDDLEUP == win32::MOUSEEVENTF_MIDDLEUP);
    assert!(MOUSEEVENTF_WHEEL == win32::MOUSEEVENTF_WHEEL);
    assert!(MOUSEEVENTF_HWHEEL == win32::MOUSEEVENTF_HWHEEL);
    assert!(MOUSEEVENTF_VIRTUALDESK == win32::MOUSEEVENTF_VIRTUALDESK);
    assert!(MOUSEEVENTF_ABSOLUTE == win32::MOUSEEVENTF_ABSOLUTE);
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MouseInputEvent {
    pub(crate) dx: i32,
    pub(crate) dy: i32,
    pub(crate) mouse_data: i32,
    pub(crate) flags: u32,
}

pub(crate) fn post_mouse_inputs(events: &[MouseInputEvent]) {
    imp::post_mouse_inputs(events);
}

/// Absolute-move input for an already-normalized point.
///
/// Lives beside `MouseInputEvent` because the move and button batches are
/// built by the synthesis path, the drag guard and the click guard alike;
/// three copies of the same two constructors is how the flag set drifts
/// between the normal post and the corrective one an abort depends on.
pub(crate) fn move_input(
    point: crate::input::mouse::mouse_coord::NormalizedPoint,
) -> MouseInputEvent {
    let mut flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
    if point.virtual_desktop {
        flags |= MOUSEEVENTF_VIRTUALDESK;
    }
    MouseInputEvent {
        dx: point.x,
        dy: point.y,
        mouse_data: 0,
        flags,
    }
}

/// Button-state input carrying only a `MOUSEEVENTF_*` down/up flag.
pub(crate) fn button_input(flag: u32) -> MouseInputEvent {
    MouseInputEvent {
        dx: 0,
        dy: 0,
        mouse_data: 0,
        flags: flag,
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::MouseInputEvent;

    pub(super) fn post_mouse_inputs(events: &[MouseInputEvent]) {
        #[cfg(test)]
        {
            super::mouse_send_fake_sink::record(events);
        }
        #[cfg(not(test))]
        {
            native::send(events);
        }
    }

    #[cfg(not(test))]
    mod native {
        use super::MouseInputEvent;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_MOUSE, MOUSEINPUT, SendInput,
        };

        pub(super) fn send(events: &[MouseInputEvent]) {
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

        fn to_raw(event: MouseInputEvent) -> INPUT {
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: event.dx,
                        dy: event.dy,
                        mouseData: event.mouse_data as u32,
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
    use super::MouseInputEvent;

    pub(super) fn post_mouse_inputs(_events: &[MouseInputEvent]) {}
}

crate::input::define_input_fake_sink!(
    mouse_send_fake_sink,
    crate::input::mouse::mouse_send::MouseInputEvent
);
