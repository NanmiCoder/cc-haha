use super::{AXElement, properties::element::element_for_pid, surface_read};
use agent_desktop_core::{AdapterError, ErrorCode, SnapshotSurface};
use std::time::Instant;

const MAX_SURFACE_NODES: usize = 2_048;

#[cfg(target_os = "macos")]
pub(crate) fn focused_surface_for_pid(
    pid: i32,
    deadline: Instant,
) -> Result<Option<AXElement>, AdapterError> {
    let app = element_for_pid(pid);
    surface_read::element(&app, "AXFocusedWindow", deadline)
}

#[cfg(target_os = "macos")]
pub(crate) fn menubar_for_pid(
    pid: i32,
    deadline: Instant,
) -> Result<Option<AXElement>, AdapterError> {
    let app = element_for_pid(pid);
    for child in surface_read::elements(&app, "AXChildren", deadline)? {
        if has_role(&child, "AXMenuBar", deadline)? {
            return Ok(Some(child));
        }
    }
    Ok(None)
}

#[cfg(target_os = "macos")]
pub(crate) fn menu_element_for_pid(
    pid: i32,
    deadline: Instant,
) -> Result<Option<AXElement>, AdapterError> {
    if let Some(menu) = open_menubar_menu(pid, deadline)? {
        return Ok(Some(menu));
    }
    context_menu_from_app(pid, deadline)
}

#[cfg(target_os = "macos")]
fn open_menubar_menu(pid: i32, deadline: Instant) -> Result<Option<AXElement>, AdapterError> {
    let Some(menubar) = menubar_for_pid(pid, deadline)? else {
        return Ok(None);
    };
    for item in surface_read::elements(&menubar, "AXChildren", deadline)? {
        if !has_role(&item, "AXMenuBarItem", deadline)?
            || surface_read::boolean(&item, "AXSelected", deadline)? != Some(true)
        {
            continue;
        }
        for child in surface_read::elements(&item, "AXChildren", deadline)? {
            if has_role(&child, "AXMenu", deadline)? {
                return Ok(Some(child));
            }
        }
    }
    Ok(None)
}

#[cfg(target_os = "macos")]
fn context_menu_from_app(pid: i32, deadline: Instant) -> Result<Option<AXElement>, AdapterError> {
    let app = element_for_pid(pid);
    for menu in surface_read::elements(&app, "AXMenus", deadline)? {
        if displayed_menu(&menu, deadline)? {
            return Ok(Some(menu));
        }
    }
    if let Some(focused) = surface_read::element(&app, "AXFocusedUIElement", deadline)?
        && let Some(menu) = find_menu_descendant(focused, deadline)?
    {
        return Ok(Some(menu));
    }
    for child in surface_read::elements(&app, "AXChildren", deadline)? {
        if let Some(menu) = find_menu_descendant(child, deadline)? {
            return Ok(Some(menu));
        }
    }
    Ok(None)
}

#[cfg(target_os = "macos")]
fn find_menu_descendant(
    root: AXElement,
    deadline: Instant,
) -> Result<Option<AXElement>, AdapterError> {
    find_menu_descendant_with(root, deadline, |element| {
        let role = surface_read::string(element, "AXRole", deadline)?;
        if role.as_deref() == Some("AXMenuBar") {
            return Ok((false, Vec::new()));
        }
        if role.as_deref() == Some("AXMenu")
            && surface_read::boolean(element, "AXVisible", deadline)? != Some(false)
        {
            return Ok((true, Vec::new()));
        }
        Ok((
            false,
            surface_read::elements(element, "AXChildren", deadline)?,
        ))
    })
}

fn find_menu_descendant_with<T>(
    root: T,
    deadline: Instant,
    mut inspect: impl FnMut(&T) -> Result<(bool, Vec<T>), AdapterError>,
) -> Result<Option<T>, AdapterError> {
    let mut pending = std::collections::VecDeque::from([root]);
    let mut incomplete = None;
    let mut visited = 0_usize;
    while let Some(element) = pending.pop_front() {
        surface_read::ensure_before_deadline(deadline)?;
        visited += 1;
        if visited > MAX_SURFACE_NODES {
            return Err(surface_limit_error());
        }
        let (is_menu, children) = match inspect(&element) {
            Ok(observed) => observed,
            Err(error) if error.code == ErrorCode::AppUnresponsive => {
                incomplete.get_or_insert(error);
                continue;
            }
            Err(error) => return Err(error),
        };
        if is_menu {
            return Ok(Some(element));
        }
        pending.extend(children);
    }
    incomplete.map_or(Ok(None), Err)
}

#[cfg(target_os = "macos")]
fn displayed_menu(element: &AXElement, deadline: Instant) -> Result<bool, AdapterError> {
    Ok(has_role(element, "AXMenu", deadline)?
        && surface_read::boolean(element, "AXVisible", deadline)? != Some(false))
}

#[cfg(target_os = "macos")]
fn has_role(element: &AXElement, expected: &str, deadline: Instant) -> Result<bool, AdapterError> {
    Ok(surface_read::string(element, "AXRole", deadline)?.as_deref() == Some(expected))
}

#[cfg(target_os = "macos")]
fn first_child_with_role_or_subrole(
    pid: i32,
    target: &str,
    deadline: Instant,
) -> Result<Option<AXElement>, AdapterError> {
    let Some(window) = focused_surface_for_pid(pid, deadline)? else {
        return Ok(None);
    };
    first_in_window(&window, deadline, |element| {
        role_or_subrole_matches(element, target, deadline)
    })
}

/// Finds a sheet, popover or alert on this window or its direct children only.
#[cfg(target_os = "macos")]
pub(crate) fn surface_in_window(
    window: &AXElement,
    surface: SnapshotSurface,
    deadline: Instant,
) -> Result<Option<AXElement>, AdapterError> {
    let target = match surface {
        SnapshotSurface::Sheet => "AXSheet",
        SnapshotSurface::Popover => "AXPopover",
        SnapshotSurface::Alert => {
            return first_in_window(window, deadline, |element| is_alert(element, deadline));
        }
        _ => return Err(AdapterError::not_supported("window-owned surface")),
    };
    first_in_window(window, deadline, |element| {
        role_or_subrole_matches(element, target, deadline)
    })
}

#[cfg(target_os = "macos")]
fn first_in_window(
    window: &AXElement,
    deadline: Instant,
    matches: impl Fn(&AXElement) -> Result<bool, AdapterError>,
) -> Result<Option<AXElement>, AdapterError> {
    if matches(window)? {
        return Ok(Some(window.clone()));
    }
    for child in surface_read::elements(window, "AXChildren", deadline)? {
        if matches(&child)? {
            return Ok(Some(child));
        }
    }
    Ok(None)
}

#[cfg(target_os = "macos")]
pub(super) fn role_or_subrole_matches(
    element: &AXElement,
    target: &str,
    deadline: Instant,
) -> Result<bool, AdapterError> {
    if surface_read::string(element, "AXRole", deadline)?.as_deref() == Some(target) {
        return Ok(true);
    }
    Ok(surface_read::string(element, "AXSubrole", deadline)?.as_deref() == Some(target))
}

#[cfg(target_os = "macos")]
pub(crate) fn sheet_for_pid(
    pid: i32,
    deadline: Instant,
) -> Result<Option<AXElement>, AdapterError> {
    first_child_with_role_or_subrole(pid, "AXSheet", deadline)
}

#[cfg(target_os = "macos")]
pub(crate) fn popover_for_pid(
    pid: i32,
    deadline: Instant,
) -> Result<Option<AXElement>, AdapterError> {
    first_child_with_role_or_subrole(pid, "AXPopover", deadline)
}

#[cfg(target_os = "macos")]
pub(crate) fn alert_for_pid(
    pid: i32,
    deadline: Instant,
) -> Result<Option<AXElement>, AdapterError> {
    let app = element_for_pid(pid);
    let mut windows = surface_read::elements(&app, "AXWindows", deadline)?;
    if let Some(focused) = focused_surface_for_pid(pid, deadline)? {
        windows.insert(0, focused);
    }
    for window in windows {
        if is_alert(&window, deadline)? {
            return Ok(Some(window));
        }
        for child in surface_read::elements(&window, "AXChildren", deadline)? {
            if is_alert(&child, deadline)? {
                return Ok(Some(child));
            }
        }
    }
    Ok(None)
}

#[cfg(target_os = "macos")]
pub(super) fn is_alert(element: &AXElement, deadline: Instant) -> Result<bool, AdapterError> {
    let role = surface_read::string(element, "AXRole", deadline)?;
    let subrole = surface_read::string(element, "AXSubrole", deadline)?;
    Ok(matches!(role.as_deref(), Some("AXSheet"))
        || matches!(
            subrole.as_deref(),
            Some("AXDialog") | Some("AXAlert") | Some("AXSheet")
        ))
}

#[cfg(target_os = "macos")]
pub(crate) fn is_menu_open(pid: i32, deadline: Instant) -> Result<bool, AdapterError> {
    Ok(menu_element_for_pid(pid, deadline)?.is_some())
}

fn surface_limit_error() -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Accessibility surface search exceeded its node budget",
    )
    .with_details(serde_json::json!({
        "kind": "surface_search_limit",
        "limit": MAX_SURFACE_NODES,
        "complete": false,
    }))
    .with_suggestion("Retry with the target application in a more stable UI state")
}

#[cfg(not(target_os = "macos"))]
macro_rules! unsupported_surface {
    ($name:ident) => {
        pub(crate) fn $name(
            _pid: i32,
            _deadline: Instant,
        ) -> Result<Option<AXElement>, AdapterError> {
            Ok(None)
        }
    };
}

#[cfg(not(target_os = "macos"))]
unsupported_surface!(focused_surface_for_pid);
#[cfg(not(target_os = "macos"))]
unsupported_surface!(menubar_for_pid);
#[cfg(not(target_os = "macos"))]
unsupported_surface!(menu_element_for_pid);
#[cfg(not(target_os = "macos"))]
unsupported_surface!(sheet_for_pid);
#[cfg(not(target_os = "macos"))]
unsupported_surface!(popover_for_pid);
#[cfg(not(target_os = "macos"))]
unsupported_surface!(alert_for_pid);

#[cfg(not(target_os = "macos"))]
pub(crate) fn is_menu_open(_pid: i32, _deadline: Instant) -> Result<bool, AdapterError> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_node_limit_is_explicitly_incomplete() {
        let error = surface_limit_error();

        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        assert_eq!(error.details.expect("limit details")["complete"], false);
    }

    #[test]
    fn menus_beyond_eight_wrappers_remain_discoverable() {
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        for target_depth in [9, 11, 30] {
            let found = find_menu_descendant_with(0, deadline, |depth| {
                Ok((*depth == target_depth, vec![depth + 1]))
            })
            .unwrap();
            assert_eq!(found, Some(target_depth));
        }
    }

    #[test]
    fn cyclic_menu_search_remains_bounded_and_explicitly_incomplete() {
        let mut reads = 0;
        let error = find_menu_descendant_with(
            0,
            Instant::now() + std::time::Duration::from_secs(5),
            |node| {
                reads += 1;
                Ok((false, vec![*node]))
            },
        )
        .unwrap_err();
        assert_eq!(reads, MAX_SURFACE_NODES);
        assert_eq!(error.details.unwrap()["complete"], false);
    }

    #[test]
    fn expired_menu_search_never_reads_a_node() {
        let result = find_menu_descendant_with::<()>((), Instant::now(), |_| {
            panic!("expired search must not call AX")
        });
        assert_eq!(result.unwrap_err().code, ErrorCode::Timeout);
    }

    #[test]
    fn incomplete_content_branch_does_not_hide_a_menu_in_a_sibling() {
        let result = find_menu_descendant_with(
            0,
            Instant::now() + std::time::Duration::from_secs(5),
            |node| match node {
                0 => Ok((false, vec![1, 2])),
                1 => Err(surface_limit_error()),
                2 => Ok((true, vec![])),
                _ => unreachable!(),
            },
        );
        assert_eq!(result.unwrap(), Some(2));
    }

    #[test]
    fn an_incomplete_branch_cannot_prove_menu_absence() {
        let result = find_menu_descendant_with(
            0,
            Instant::now() + std::time::Duration::from_secs(5),
            |node| match node {
                0 => Ok((false, vec![1, 2])),
                1 => Err(surface_limit_error()),
                _ => Ok((false, vec![])),
            },
        );
        assert_eq!(result.unwrap_err().details.unwrap()["complete"], false);
    }

    #[test]
    fn shallow_menu_precedes_unbounded_content_and_permission_errors_stay_terminal() {
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        let found = find_menu_descendant_with(0, deadline, |node| match node {
            0 => Ok((false, vec![1, 2])),
            1 => Ok((false, vec![1])),
            _ => Ok((true, vec![])),
        });
        assert_eq!(found.unwrap(), Some(2));
        let denied = find_menu_descendant_with(0, deadline, |node| match node {
            0 => Ok((false, vec![1, 2])),
            1 => Err(AdapterError::new(ErrorCode::PermDenied, "denied")),
            _ => panic!("permission failure must stop all further AX reads"),
        });
        assert_eq!(denied.unwrap_err().code, ErrorCode::PermDenied);
    }
}
