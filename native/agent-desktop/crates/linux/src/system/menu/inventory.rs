use crate::system::menu::nested_surface::Nested;
use agent_desktop_core::AdapterError;

use super::{menu_popup, surface_scan::NestedScan};
use crate::system::registry::listed_window::ListedWindow;
use crate::system::window::window_id;
use crate::tree::AtspiElement;
use crate::tree::surfaces::nested_dialog::{Node, find, is_incomplete};

/// The showing dialogs inside the windows, other than windows that are
/// dialogs themselves. A window that cannot be read, or whose tree was cut
/// short, makes the scan incomplete: a dialog may sit where it did not look.
pub(crate) fn scan_windows(
    windows: &[ListedWindow],
    mut read: impl FnMut(&AtspiElement) -> Result<Node, AdapterError>,
) -> NestedScan {
    let mut scan = NestedScan::complete_and_empty();
    for (index, window) in windows.iter().enumerate().filter(|(_, w)| !w.sheet) {
        let Ok((bus_name, path)) = window_id::decode(&window.info.id) else {
            scan.unread.push(index);
            continue;
        };
        let element = AtspiElement::new(bus_name, path, window.info.pid.get());
        let Ok(root) = read(&element) else {
            scan.unread.push(index);
            continue;
        };
        let mut whole = !is_incomplete(&root) && super::menu_surface::popup_read_complete(&root);
        for dialog in find(&root) {
            match window_id::encode(dialog.element.bus_name(), dialog.element.path()) {
                Some(id) => scan.found.push(Nested {
                    window: index,
                    id,
                    title: dialog.title.map(str::to_owned),
                }),
                None => whole = false,
            }
        }
        if menu_popup::top_level(&root).is_some() {
            scan.menus.push(Nested {
                window: index,
                id: window.info.id.clone(),
                title: None,
            });
        } else {
            for menu in menu_popup::in_window(&root) {
                let element = &menu.root.payload.node.element;
                match window_id::encode(element.bus_name(), element.path()) {
                    Some(id) => scan.menus.push(Nested {
                        window: index,
                        id,
                        title: None,
                    }),
                    None => whole = false,
                }
            }
        }
        if !whole {
            scan.unread.push(index);
        }
    }
    scan.complete = scan.unread.is_empty();
    scan
}

#[cfg(test)]
#[path = "inventory_tests.rs"]
mod tests;
