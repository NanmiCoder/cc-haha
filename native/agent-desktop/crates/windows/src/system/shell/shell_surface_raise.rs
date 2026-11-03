use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};

use super::shell_surface::{SurfaceKindRow, SurfaceRaise, shell_tray_handle};

#[cfg(target_os = "windows")]
pub(in crate::system) fn raise_row(
    row: &SurfaceKindRow,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    deadline.ensure_remaining()?;
    match row.raise {
        SurfaceRaise::AlreadyRaised => Ok(()),
        SurfaceRaise::Accelerator { modifiers, key } => {
            #[cfg(test)]
            accelerator_probe::record();
            send_chord(modifiers, key, deadline)
        }
        SurfaceRaise::ChevronInvoke => invoke_overflow_chevron(deadline),
    }
}

#[cfg(not(target_os = "windows"))]
pub(in crate::system) fn raise_row(
    _row: &SurfaceKindRow,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    deadline.ensure_remaining()?;
    Err(AdapterError::not_supported("raise shell surface"))
}

/// Posts a shell chord through `SendInput` directly rather than through the
/// shared keyboard seam: that seam is stubbed under `cfg(test)` by design so
/// unit tests never emit real input, while this module's live tests are the
/// verification and must reach the OS. `SendInput`'s return value is never
/// delivery evidence (A9-3), so the chord is posted and the open is then
/// verified by observation alone.
#[cfg(target_os = "windows")]
pub(in crate::system) fn send_chord(
    modifiers: &[u16],
    key: u16,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    const SETTLE: std::time::Duration = std::time::Duration::from_millis(10);

    let mut guard = ShellKeyGuard::default();
    for &vk in modifiers {
        deadline.ensure_remaining()?;
        post_shell_keys(&[ShellKeyEdge::down(vk)]);
        guard.held.push(vk);
    }
    deadline.ensure_remaining()?;
    post_shell_keys(&[ShellKeyEdge::down(key)]);
    guard.held.push(key);
    std::thread::sleep(SETTLE.min(deadline.remaining()));
    post_shell_keys(&[ShellKeyEdge::up(key)]);
    guard.held.retain(|&held| held != key);
    for &vk in modifiers.iter().rev() {
        deadline.ensure_remaining()?;
        post_shell_keys(&[ShellKeyEdge::up(vk)]);
        guard.held.retain(|&held| held != vk);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
struct ShellKeyEdge {
    vk: u16,
    up: bool,
}

#[cfg(target_os = "windows")]
impl ShellKeyEdge {
    fn down(vk: u16) -> Self {
        Self { vk, up: false }
    }

    fn up(vk: u16) -> Self {
        Self { vk, up: true }
    }
}

#[cfg(target_os = "windows")]
fn post_shell_keys(edges: &[ShellKeyEdge]) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, SendInput,
    };

    const KEYEVENTF_KEYUP: u32 = 0x0002;

    if edges.is_empty() {
        return;
    }
    let raw: Vec<INPUT> = edges
        .iter()
        .map(|edge| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: edge.vk,
                    wScan: 0,
                    dwFlags: if edge.up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        })
        .collect();
    unsafe {
        SendInput(
            raw.len() as u32,
            raw.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
    }
}

/// Sweeps any chord key still believed held, gated on live key state so a key
/// the OS already saw released is never re-pressed - the same discipline the
/// shared keyboard seam's release guard applies to its own chords.
#[cfg(target_os = "windows")]
#[derive(Default)]
struct ShellKeyGuard {
    held: Vec<u16>,
}

#[cfg(target_os = "windows")]
impl Drop for ShellKeyGuard {
    fn drop(&mut self) {
        for vk in self.held.iter().rev().copied() {
            if key_currently_down(vk) {
                post_shell_keys(&[ShellKeyEdge::up(vk)]);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn key_currently_down(vk: u16) -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    (unsafe { GetAsyncKeyState(i32::from(vk)) } as u16 & 0x8000) != 0
}

/// The tray's Notification Chevron button, at its measured `AutomationId`
/// (A26-7: the button whose invoke takes the overflow from hidden to
/// visible), located inside the taskbar window by identifier - never by name,
/// which is localized.
#[cfg(target_os = "windows")]
const CHEVRON_AUTOMATION_ID: &str = "1502";

#[cfg(target_os = "windows")]
fn invoke_overflow_chevron(_deadline: Deadline) -> Result<(), AdapterError> {
    use uiautomation::patterns::UIInvokePattern;
    use uiautomation::types::{Handle, TreeScope, UIProperty};
    use uiautomation::variants::Variant;

    let narrow = crate::system::window::listing_retry::narrow_to_permitted_codes;
    let Some(tray) = shell_tray_handle() else {
        return Err(AdapterError::new(
            ErrorCode::WindowNotFound,
            "the taskbar window is not present, so the notification chevron cannot be invoked",
        )
        .with_disposition(DeliverySemantics::not_delivered()));
    };
    let client = crate::tree::automation::automation_client().map_err(narrow)?;
    let tray_element = client
        .element_from_handle(Handle::from(tray as isize))
        .map_err(|error| {
            narrow(crate::tree::automation::uia_error(
                &error,
                "resolve the taskbar window's element",
            ))
        })?;
    let condition = client
        .create_property_condition(
            UIProperty::AutomationId,
            Variant::from(CHEVRON_AUTOMATION_ID),
            None,
        )
        .map_err(|error| {
            narrow(crate::tree::automation::uia_error(
                &error,
                "build the chevron condition",
            ))
        })?;
    let chevron = match tray_element.find_first(TreeScope::Descendants, &condition) {
        Ok(element) => element,
        Err(error) if crate::tree::automation::failure_of(&error).is_exhaustion() => {
            return Err(AdapterError::new(
                ErrorCode::WindowNotFound,
                "the notification chevron button is not present in the taskbar",
            )
            .with_disposition(DeliverySemantics::not_delivered()));
        }
        Err(error) => {
            return Err(narrow(crate::tree::automation::uia_error(
                &error,
                "search the taskbar for the notification chevron",
            )));
        }
    };
    let invoke: UIInvokePattern = chevron.get_pattern().map_err(|error| {
        narrow(crate::tree::automation::uia_error(
            &error,
            "read the chevron's invoke pattern",
        ))
    })?;
    invoke.invoke().map_err(|error| {
        narrow(crate::tree::automation::uia_error(
            &error,
            "invoke the notification chevron",
        ))
    })
}

#[cfg(all(test, target_os = "windows"))]
pub(in crate::system) mod accelerator_probe {
    use std::cell::Cell;

    thread_local! {
        static RAISES: Cell<usize> = const { Cell::new(0) };
    }

    pub(in crate::system) fn record() {
        RAISES.with(|cell| cell.set(cell.get() + 1));
    }

    pub(in crate::system) fn take_all() -> usize {
        RAISES.with(|cell| {
            let value = cell.get();
            cell.set(0);
            value
        })
    }
}
