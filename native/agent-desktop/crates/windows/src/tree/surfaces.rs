use agent_desktop_core::{AdapterError, Deadline, ErrorCode, ObservationRoot, SnapshotSurface};
use serde_json::json;

use super::automation::root_from_hwnd;
use super::element::UIAElement;
#[cfg(target_os = "windows")]
use super::properties::property_ids::TreeProperty;
#[cfg(target_os = "windows")]
use super::properties::read_one;
use crate::system::window::window_enum::enumerate_top_level;
use crate::system::window::window_ops::{parse_window_id, passes_filter};

/// Resolves the element an observation root names, per-surface (`Window`
/// resolves the named window directly; `Focused` composes the focused-only
/// inventory).
///
/// `Surface` semantics live here: only the surfaces this adapter advertises
/// are handled (core validates the requested surface before the adapter is
/// called, so an unsupported surface never reaches this match).
pub(crate) fn surface_root(
    root: ObservationRoot<'_>,
    surface: SnapshotSurface,
    deadline: Deadline,
) -> Result<UIAElement, AdapterError> {
    match (root, surface) {
        (ObservationRoot::Window(window), SnapshotSurface::Window) => {
            let handle = parse_window_id(&window.id)?;
            root_from_hwnd(handle, deadline)
        }
        (ObservationRoot::Window(window), SnapshotSurface::Focused) => {
            let handle = focused_hwnd_of(&window.id)?;
            root_from_hwnd(handle, deadline)
        }
        (ObservationRoot::Window(window), SnapshotSurface::Sheet) => {
            let handle = focused_hwnd_of(&window.id)?;
            let element = root_from_hwnd(handle, deadline)?;
            if window_is_modal_sheet(&element) {
                Ok(element)
            } else {
                Err(AdapterError::new(
                    ErrorCode::WindowNotFound,
                    "The focused window is not a modal sheet",
                ))
            }
        }
        (ObservationRoot::Window(window), SnapshotSurface::Menu) => {
            let location = crate::system::menu::menu_state::locate_menu(window.pid, deadline)?
                .ok_or_else(|| {
                    AdapterError::new(
                        ErrorCode::WindowNotFound,
                        "No menu this surface can root was found for this application",
                    )
                    .with_suggestion(
                        "A classic Win32 menu can be open without exposing an element to \
                         root at, so a menu wait can succeed where this refuses. Read the \
                         owning window's own surface instead.",
                    )
                })?;
            root_from_hwnd(location.root_handle(), deadline)
        }
        (ObservationRoot::Window(window), SnapshotSurface::StartMenu)
        | (ObservationRoot::Window(window), SnapshotSurface::Taskbar)
        | (ObservationRoot::Window(window), SnapshotSurface::SystemTray)
        | (ObservationRoot::Window(window), SnapshotSurface::SystemTrayOverflow)
        | (ObservationRoot::Window(window), SnapshotSurface::ActionCenter) => {
            let handle = parse_window_id(&window.id)?;
            root_from_hwnd(handle, deadline)
        }
        (ObservationRoot::Element { handle, .. }, _) => {
            super::element::uia_element(handle).cloned().map_err(|_| {
                AdapterError::new(
                    ErrorCode::StaleRef,
                    "Element root handle is invalid for this platform",
                )
                .with_details(json!({ "kind": "element_root_wrong_payload" }))
            })
        }
        (ObservationRoot::Window(_), _) => Err(AdapterError::not_supported("surface")),
    }
}

/// The focused window's HWND, found through the focused-only window inventory
/// the same way `focused_window` composes it.
fn focused_hwnd_of(expected: &str) -> Result<isize, AdapterError> {
    let mut focused = None;
    enumerate_top_level(|window| {
        if !passes_filter(&window) {
            return true;
        }
        let is_focused = {
            #[cfg(target_os = "windows")]
            {
                use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
                unsafe { GetForegroundWindow() == window.handle }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = &window;
                false
            }
        };
        if is_focused {
            focused = Some(window.handle as isize);
            false
        } else {
            true
        }
    })?;
    let handle = focused.ok_or_else(|| {
        AdapterError::new(
            ErrorCode::WindowNotFound,
            "There is no focused window on this desktop",
        )
    })?;
    if format!("w-{handle}") != expected {
        return Err(AdapterError::new(
            ErrorCode::WindowNotFound,
            "The requested focused window is no longer the focused window",
        ));
    }
    Ok(handle)
}

/// Whether a window is a modal sheet surface, tested from the window's own
/// `WindowIsModal` property **before** any child is consulted (the macOS
/// window-is-surface pattern from `crates/macos/src/tree/surfaces.rs`).
///
/// This classifies a Chromium modal as a `Sheet` surface, making it reachable
/// via the sheet surface.
#[cfg(target_os = "windows")]
pub(crate) fn window_is_modal_sheet(root: &UIAElement) -> bool {
    matches!(
        read_one(root, TreeProperty::WindowIsModal).flag(),
        Some(true)
    )
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn window_is_modal_sheet(_root: &UIAElement) -> bool {
    false
}

#[cfg(test)]
#[path = "surfaces_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "surfaces_advertising_tests.rs"]
mod advertising_tests;
