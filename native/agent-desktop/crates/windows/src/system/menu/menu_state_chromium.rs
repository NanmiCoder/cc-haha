//! Source C of the menu detector: the Chromium/Electron DOM-menu arm.
//!
//! Measured on a real Chromium host (A26-12): its context menu is a DOM menu
//! rendered inside the application's own window - no native menu tracking
//! fires the classic flags, and the menu family surfaces under a non-tool
//! window, so the tool-window pool never sees it. The predicate probes the
//! pid's visible, uncloaked, non-iconic, non-tool, non-zero-sized root-level
//! windows for a `Menu`/`MenuItem` element whose `FrameworkId` is the
//! Chromium framework's - a framework-family gate, not an application name,
//! and the measured reason it exists is that a classic Win32 menu bar lives
//! under exactly the same candidate pool at rest with framework `Win32`. A
//! persistent Chromium-framework menu bar would carry this framework id too;
//! that shape was not measurable on the host the source was measured on (its
//! own menubar exposes no menu-family elements at rest), so it stays an
//! explicitly documented coverage bound rather than a claimed exclusion.

use agent_desktop_core::{AdapterError, Deadline, ProcessId};

use super::enumerate_top_level;

/// The framework token Chromium's UIA provider reports for its elements,
/// measured on the staged host (A26-12): the DOM menu's `Menu` and
/// `MenuItem` elements all read this framework id, while a Win32 menu bar
/// under the same candidate pool reads `Win32`.
#[cfg(target_os = "windows")]
const CHROMIUM_FRAMEWORK_ID: &str = "Chrome";

#[cfg(target_os = "windows")]
pub(super) fn chromium_dom_menu_reachable(
    pid: ProcessId,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    deadline.ensure_remaining()?;
    let candidates = chromium_menu_candidates(pid)?;
    if candidates.is_empty() {
        return Ok(false);
    }
    let client =
        crate::tree::automation::automation_client().map_err(super::narrow_to_permitted_codes)?;
    let condition = chromium_menu_condition(&client)?;
    for (index, handle) in candidates.into_iter().enumerate() {
        if index > 0 {
            deadline.ensure_remaining()?;
        }
        if super::probe_candidate(&client, &condition, handle)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Source C's locating variant, so the surface arm can root where the
/// detector fires. Without it a wait on `surface-appeared --surface menu`
/// against a Chromium application succeeded and the `snapshot --surface menu`
/// that followed answered `WINDOW_NOT_FOUND`, because only source B could
/// locate anything.
#[cfg(target_os = "windows")]
pub(super) fn locate_chromium_dom_menu(
    pid: ProcessId,
    deadline: Deadline,
) -> Result<Option<(uiautomation::UIElement, isize)>, AdapterError> {
    deadline.ensure_remaining()?;
    let candidates = chromium_menu_candidates(pid)?;
    if candidates.is_empty() {
        return Ok(None);
    }
    let client =
        crate::tree::automation::automation_client().map_err(super::narrow_to_permitted_codes)?;
    let condition = chromium_menu_condition(&client)?;
    for (index, handle) in candidates.into_iter().enumerate() {
        if index > 0 {
            deadline.ensure_remaining()?;
        }
        if let Some(element) = super::probe_candidate_element(&client, &condition, handle)? {
            return Ok(Some((element, handle)));
        }
    }
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
pub(super) fn locate_chromium_dom_menu(
    _pid: ProcessId,
    deadline: Deadline,
) -> Result<Option<(uiautomation::UIElement, isize)>, AdapterError> {
    deadline.ensure_remaining()?;
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
pub(super) fn chromium_dom_menu_reachable(
    _pid: ProcessId,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    deadline.ensure_remaining()?;
    Ok(false)
}

/// Source C's candidate pool: the mirror image of the tool-window pool
/// source B searches. Only windows actually presented to the user are probed,
/// because a menu the user cannot see cannot be open, which keeps hidden or
/// cloaked helper windows of the same pid from firing the predicate at rest.
#[cfg(target_os = "windows")]
fn chromium_menu_candidates(pid: ProcessId) -> Result<Vec<isize>, AdapterError> {
    let mut handles = Vec::new();
    enumerate_top_level(|window| {
        if crate::system::window::window_identity::live_window_owner(window.handle) == Some(pid)
            && !window.tool
            && window.visible
            && !window.iconic
            && !window.cloaked
            && !window.is_zero_sized()
        {
            handles.push(window.handle as isize);
        }
        true
    })
    .map_err(super::narrow_to_permitted_codes)?;
    Ok(handles)
}

/// Source C's search: the menu family without `MenuBar` - a bar is not an
/// open menu - inside the Chromium framework. The `FrameworkId` gate is what
/// keeps the `MenuItem` half of the family from firing on a classic Win32
/// menu bar's own items, which live under the same visible non-tool windows
/// this source probes.
#[cfg(target_os = "windows")]
fn chromium_menu_condition(
    client: &uiautomation::UIAutomation,
) -> Result<uiautomation::core::UICondition, AdapterError> {
    use uiautomation::types::UIProperty;
    use uiautomation::variants::Variant;

    let framework_condition = client
        .create_property_condition(
            UIProperty::FrameworkId,
            Variant::from(CHROMIUM_FRAMEWORK_ID),
            None,
        )
        .map_err(|error| {
            super::narrow_to_permitted_codes(crate::tree::automation::uia_error(
                &error,
                "build the Chromium framework gate condition",
            ))
        })?;
    let menu_family_without_bar = menu_family_condition_without_bar(client)?;
    client
        .create_and_condition(framework_condition, menu_family_without_bar)
        .map_err(|error| {
            super::narrow_to_permitted_codes(crate::tree::automation::uia_error(
                &error,
                "combine the Chromium menu search condition",
            ))
        })
}

#[cfg(target_os = "windows")]
fn menu_family_condition_without_bar(
    client: &uiautomation::UIAutomation,
) -> Result<uiautomation::core::UICondition, AdapterError> {
    use uiautomation::types::ControlType;

    let menu = super::control_type_condition(client, ControlType::Menu)?;
    let menu_item = super::control_type_condition(client, ControlType::MenuItem)?;
    client
        .create_or_condition(menu, menu_item)
        .map_err(|error| {
            super::narrow_to_permitted_codes(crate::tree::automation::uia_error(
                &error,
                "combine the menu-family search condition",
            ))
        })
}
