use crate::tree::{AXElement, properties::element::element_for_pid};
use agent_desktop_core::{AdapterError, SurfaceInfo};
use std::time::Instant;

pub(crate) fn list_surfaces_for_pid(
    pid: i32,
    deadline: Instant,
) -> Result<Vec<SurfaceInfo>, AdapterError> {
    ensure_before_deadline(deadline)?;
    let app = element_for_pid(pid);
    let mut surfaces = Vec::new();

    if let Some(children) = read_array(&app, "AXChildren", deadline)? {
        collect_app_surfaces(&children, deadline, &mut surfaces)?;
    }
    if let Some(focused) = read_element(&app, "AXFocusedUIElement", deadline)? {
        collect_context_menus(&focused, deadline, &mut surfaces)?;
    }
    if let Some(window) = read_element(&app, "AXFocusedWindow", deadline)? {
        collect_window_surfaces(&window, "focused-window", deadline, &mut surfaces)?;
    }

    complete_menu_inventory(&mut surfaces, |surfaces| {
        if let Some(menu) = super::surfaces::menu_element_for_pid(pid, deadline)? {
            push_menu_surface(
                &menu,
                "context_menu",
                "resolved/menu".into(),
                deadline,
                surfaces,
            )?;
        }
        Ok(())
    })?;

    ensure_before_deadline(deadline)?;
    Ok(surfaces)
}

fn complete_menu_inventory(
    surfaces: &mut Vec<SurfaceInfo>,
    discover: impl FnOnce(&mut Vec<SurfaceInfo>) -> Result<(), AdapterError>,
) -> Result<(), AdapterError> {
    if !surfaces
        .iter()
        .any(|surface| matches!(surface.kind.as_str(), "menu" | "context_menu"))
    {
        discover(surfaces)?;
    }
    Ok(())
}

fn collect_app_surfaces(
    children: &[AXElement],
    deadline: Instant,
    surfaces: &mut Vec<SurfaceInfo>,
) -> Result<(), AdapterError> {
    for (index, child) in children.iter().enumerate() {
        let id = format!("app/children/{index}");
        match read_string(child, "AXRole", deadline)?.as_deref() {
            Some("AXMenuBar") => collect_menubar_surfaces(child, &id, deadline, surfaces)?,
            Some("AXMenu") => push_menu_surface(child, "context_menu", id, deadline, surfaces)?,
            _ => {}
        }
    }
    Ok(())
}

fn collect_menubar_surfaces(
    menubar: &AXElement,
    menubar_id: &str,
    deadline: Instant,
    surfaces: &mut Vec<SurfaceInfo>,
) -> Result<(), AdapterError> {
    let Some(items) = read_array(menubar, "AXChildren", deadline)? else {
        return Ok(());
    };
    for (item_index, item) in items.iter().enumerate() {
        if read_string(item, "AXRole", deadline)?.as_deref() != Some("AXMenuBarItem")
            || read_bool(item, "AXSelected", deadline)? != Some(true)
        {
            continue;
        }
        let Some(children) = read_array(item, "AXChildren", deadline)? else {
            continue;
        };
        for (menu_index, menu) in children.iter().enumerate() {
            if read_string(menu, "AXRole", deadline)?.as_deref() == Some("AXMenu") {
                push_menu_surface(
                    menu,
                    "menu",
                    format!("{menubar_id}/items/{item_index}/children/{menu_index}"),
                    deadline,
                    surfaces,
                )?;
            }
        }
    }
    Ok(())
}

fn collect_context_menus(
    element: &AXElement,
    deadline: Instant,
    surfaces: &mut Vec<SurfaceInfo>,
) -> Result<(), AdapterError> {
    let Some(children) = read_array(element, "AXChildren", deadline)? else {
        return Ok(());
    };
    for (index, child) in children.iter().enumerate() {
        if read_string(child, "AXRole", deadline)?.as_deref() == Some("AXMenu") {
            push_menu_surface(
                child,
                "context_menu",
                format!("focused/children/{index}"),
                deadline,
                surfaces,
            )?;
        }
    }
    Ok(())
}

fn push_menu_surface(
    menu: &AXElement,
    kind: &str,
    id: String,
    deadline: Instant,
    surfaces: &mut Vec<SurfaceInfo>,
) -> Result<(), AdapterError> {
    let title = read_title(menu, deadline)?;
    let item_count = read_array(menu, "AXChildren", deadline)?.map(|items| items.len());
    surfaces.push(SurfaceInfo {
        id,
        kind: kind.into(),
        title,
        item_count,
        unclassified: Vec::new(),
    });
    Ok(())
}

fn collect_window_surfaces(
    window: &AXElement,
    window_id: &str,
    deadline: Instant,
    surfaces: &mut Vec<SurfaceInfo>,
) -> Result<(), AdapterError> {
    if let Some(kind) = surface_kind(window, deadline)? {
        surfaces.push(SurfaceInfo {
            id: window_id.to_string(),
            kind: kind.into(),
            title: read_title(window, deadline)?,
            item_count: None,
            unclassified: Vec::new(),
        });
    }
    let Some(children) = read_array(window, "AXChildren", deadline)? else {
        return Ok(());
    };
    for (index, child) in children.iter().enumerate() {
        if let Some(kind) = surface_kind(child, deadline)? {
            surfaces.push(SurfaceInfo {
                id: format!("{window_id}/children/{index}"),
                kind: kind.into(),
                title: read_title(child, deadline)?,
                item_count: None,
                unclassified: Vec::new(),
            });
        }
    }
    Ok(())
}

fn surface_kind(
    element: &AXElement,
    deadline: Instant,
) -> Result<Option<&'static str>, AdapterError> {
    let role = read_string(element, "AXRole", deadline)?;
    let subrole = read_string(element, "AXSubrole", deadline)?;
    Ok(match subrole.as_deref() {
        Some("AXSheet") => Some("sheet"),
        Some("AXPopover") => Some("popover"),
        Some("AXDialog") | Some("AXAlert") => Some("alert"),
        _ => match role.as_deref() {
            Some("AXSheet") => Some("sheet"),
            Some("AXPopover") => Some("popover"),
            _ => None,
        },
    })
}

fn read_title(element: &AXElement, deadline: Instant) -> Result<Option<String>, AdapterError> {
    match read_string(element, "AXTitle", deadline)? {
        Some(title) => Ok(Some(title)),
        None => read_string(element, "AXDescription", deadline),
    }
}

fn read_string(
    element: &AXElement,
    attribute: &str,
    deadline: Instant,
) -> Result<Option<String>, AdapterError> {
    crate::tree::surface_read::string(element, attribute, deadline)
}

fn read_bool(
    element: &AXElement,
    attribute: &str,
    deadline: Instant,
) -> Result<Option<bool>, AdapterError> {
    crate::tree::surface_read::boolean(element, attribute, deadline)
}

fn read_array(
    element: &AXElement,
    attribute: &str,
    deadline: Instant,
) -> Result<Option<Vec<AXElement>>, AdapterError> {
    crate::tree::surface_read::elements(element, attribute, deadline).map(Some)
}

fn read_element(
    element: &AXElement,
    attribute: &str,
    deadline: Instant,
) -> Result<Option<AXElement>, AdapterError> {
    crate::tree::surface_read::element(element, attribute, deadline)
}

fn ensure_before_deadline(deadline: Instant) -> Result<(), AdapterError> {
    crate::tree::surface_read::ensure_before_deadline(deadline)
}

#[cfg(test)]
#[path = "surface_inventory_tests.rs"]
mod tests;
