use crate::tree::vocabulary::role_numbers::{
    ALERT, COLOR_CHOOSER, DIALOG, FILE_CHOOSER, FONT_CHOOSER, MENU, MENU_BAR, POPUP_MENU,
};
use crate::tree::vocabulary::state_bits::{SHOWING, StateBits};
use crate::tree::{COMPONENT_INTERFACE, Field, RawNode};

/// Application-root children implementing Component are top levels: their roles
/// describe their widgets (L41-1). Menu surfaces are classified separately
/// because GTK3 and Chromium expose them as root children (L41-2, L18-7).
/// Closed husks are removed by their states downstream.
pub(crate) fn is_top_level(interfaces: &Field<Vec<String>>) -> bool {
    interfaces
        .present()
        .is_some_and(|list| list.iter().any(|name| name == COMPONENT_INTERFACE))
}

/// The AT-SPI dialog roles measured from libatspi's Atspi.Role (L41-4).
pub(crate) fn is_dialog_role(role: Option<&u32>) -> bool {
    matches!(
        role,
        Some(&(ALERT | COLOR_CHOOSER | DIALOG | FILE_CHOOSER | FONT_CHOOSER))
    )
}

pub(crate) fn is_popup_menu_candidate(node: &RawNode) -> bool {
    is_top_level(&node.traits.interfaces)
        && node.properties.name.present().is_some_and(String::is_empty)
        && node
            .traits
            .states
            .present()
            .is_some_and(|words| StateBits::new(words).has(SHOWING))
}

/// GTK3 context menus and Chromium menus are blank showing top-levels with
/// only menus or menu bars holding menus (L41-2, L18-7). Missing child evidence
/// never proves a popup; empty containers never hide a window.
pub(crate) fn is_popup_menu_surface(node: &RawNode, children: Option<&[(u32, Vec<u32>)]>) -> bool {
    is_popup_menu_candidate(node)
        && children.is_some_and(|children| {
            !children.is_empty()
                && children.iter().all(|(role, menus)| {
                    matches!(*role, MENU | POPUP_MENU)
                        || (*role == MENU_BAR
                            && !menus.is_empty()
                            && menus.iter().all(|role| matches!(*role, MENU | POPUP_MENU)))
                })
        })
}

#[cfg(test)]
#[path = "top_level_tests.rs"]
mod tests;
