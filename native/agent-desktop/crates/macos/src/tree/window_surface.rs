use agent_desktop_core::{AdapterError, ErrorCode, SnapshotSurface, WindowInfo};
use std::time::Instant;

use super::AXElement;

pub(crate) fn surface_for_window(
    window: &WindowInfo,
    surface: SnapshotSurface,
    deadline: Instant,
) -> Result<Option<AXElement>, AdapterError> {
    resolve_owned_surface(
        crate::system::window::window_resolve::window_element_for_info_with_deadline(
            window, deadline,
        ),
        |owner| super::surfaces::surface_in_window(&owner, surface, deadline),
        || {
            let pid = crate::system::process::process_identity::to_pid_t(window.pid)?;
            surface_for_pid_with_window_number(
                pid,
                surface,
                crate::system::window::window_resolve::parse_window_number(&window.id),
                deadline,
            )
        },
    )
}

fn resolve_owned_surface<T>(
    owner: Result<T, AdapterError>,
    in_window: impl FnOnce(T) -> Result<Option<T>, AdapterError>,
    fallback: impl FnOnce() -> Result<Option<T>, AdapterError>,
) -> Result<Option<T>, AdapterError> {
    match owner {
        Ok(owner) => in_window(owner),
        Err(error)
            if error.code == ErrorCode::ActionNotSupported
                && error
                    .details
                    .as_ref()
                    .and_then(|details| details["kind"].as_str())
                    == Some("window_without_accessibility_element") =>
        {
            fallback()
        }
        Err(error) => Err(error),
    }
}

pub(super) fn surface_for_pid_with_window_number(
    pid: i32,
    surface: SnapshotSurface,
    expected_number: Option<i64>,
    deadline: Instant,
) -> Result<Option<AXElement>, AdapterError> {
    if expected_number.is_none() {
        return Ok(None);
    }
    let app = super::properties::element::element_for_pid(pid);
    let mut windows = super::surface_read::elements(&app, "AXWindows", deadline)?;
    if let Some(focused) = super::surfaces::focused_surface_for_pid(pid, deadline)? {
        super::element_dedupe::push_unique(&mut windows, focused);
    }
    find_numbered_surface(
        windows,
        expected_number,
        |window| super::surface_read::elements(window, "AXChildren", deadline),
        |element| {
            let matches = match surface {
                SnapshotSurface::Sheet => {
                    super::surfaces::role_or_subrole_matches(element, "AXSheet", deadline)?
                }
                SnapshotSurface::Popover => {
                    super::surfaces::role_or_subrole_matches(element, "AXPopover", deadline)?
                }
                SnapshotSurface::Alert => super::surfaces::is_alert(element, deadline)?,
                _ => return Err(AdapterError::not_supported("window-owned surface")),
            };
            if !matches {
                return Ok(None);
            }
            crate::system::window::window_resolve::ax_window_id_with_deadline(element, deadline)
        },
    )
}

fn find_numbered_surface<T>(
    windows: Vec<T>,
    expected_number: Option<i64>,
    mut children: impl FnMut(&T) -> Result<Vec<T>, AdapterError>,
    mut surface_number: impl FnMut(&T) -> Result<Option<i64>, AdapterError>,
) -> Result<Option<T>, AdapterError> {
    let Some(expected_number) = expected_number.filter(|number| *number > 0) else {
        return Ok(None);
    };
    let mut first_children_error = None;
    for window in windows {
        if surface_number(&window)? == Some(expected_number) {
            return Ok(Some(window));
        }
        let window_children = match children(&window) {
            Ok(children) => children,
            Err(error) => {
                first_children_error.get_or_insert(error);
                continue;
            }
        };
        for child in window_children {
            if surface_number(&child)? == Some(expected_number) {
                return Ok(Some(child));
            }
        }
    }
    match first_children_error {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbered_surface_finds_later_match_after_children_error() {
        let found = find_numbered_surface(
            vec![1, 2],
            Some(42),
            |window| match window {
                1 => Err(AdapterError::timeout("first window children")),
                _ => Ok(vec![42]),
            },
            |number| Ok(Some(*number)),
        )
        .unwrap();
        assert_eq!(found, Some(42));
    }

    #[test]
    fn numbered_surface_returns_first_children_error_without_match() {
        let first_error = AdapterError::timeout("first window children");
        let error = find_numbered_surface(
            vec![1, 2, 3],
            Some(42),
            |window| match window {
                1 => Err(first_error.clone()),
                2 => Ok(vec![4]),
                _ => Err(AdapterError::new(ErrorCode::ActionFailed, "later children")),
            },
            |number| Ok(Some(*number)),
        )
        .unwrap_err();
        assert_eq!(error.code, first_error.code);
        assert_eq!(error.message, first_error.message);
    }

    #[test]
    fn numbered_surface_returns_none_after_complete_search_without_match() {
        let found = find_numbered_surface(
            vec![1, 2],
            Some(42),
            |window| Ok(vec![window + 2]),
            |number| Ok(Some(*number)),
        )
        .unwrap();
        assert_eq!(found, None);
    }

    #[test]
    fn numbered_surface_rejects_same_geometry_in_another_window() {
        let bounds = agent_desktop_core::Rect {
            x: 10.0,
            y: 20.0,
            width: 300.0,
            height: 200.0,
        };
        let found = find_numbered_surface(
            vec![(Some(41), bounds), (None, bounds)],
            Some(42),
            |_| Ok(vec![(Some(43), bounds), (Some(42), bounds)]),
            |candidate| Ok(candidate.0),
        )
        .unwrap();
        assert_eq!(found, Some((Some(42), bounds)));
        for number in [None, Some(41)] {
            assert!(
                find_numbered_surface(
                    vec![(number, bounds)],
                    Some(42),
                    |_| Ok(vec![]),
                    |candidate| Ok(candidate.0)
                )
                .unwrap()
                .is_none()
            );
        }
    }

    #[test]
    fn numbered_surface_accepts_window_itself_and_requires_saved_number() {
        assert_eq!(
            find_numbered_surface(
                vec![42],
                Some(42),
                |_| panic!("already matched"),
                |number| Ok(Some(*number))
            )
            .unwrap(),
            Some(42)
        );
        assert!(
            find_numbered_surface(
                vec![42],
                None,
                |_| panic!("missing scope"),
                |_| panic!("missing scope")
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn numbered_surface_propagates_bridge_failure() {
        let unavailable = AdapterError::new(ErrorCode::ActionNotSupported, "window bridge")
            .with_details(serde_json::json!({"kind": "resolution_window_bridge_unavailable"}));
        let error = find_numbered_surface(
            vec![41, 42],
            Some(42),
            |_| Ok(vec![]),
            |_| Err(unavailable.clone()),
        )
        .unwrap_err();
        assert_eq!(error.code, unavailable.code);
        assert_eq!(error.message, unavailable.message);
        assert_eq!(error.details, unavailable.details);
    }

    #[test]
    fn missing_ax_window_uses_number_checked_fallback() {
        let error = AdapterError::new(ErrorCode::ActionNotSupported, "no AX window")
            .with_details(serde_json::json!({"kind": "window_without_accessibility_element"}));
        let result = resolve_owned_surface::<i64>(
            Err(error),
            |_| panic!("no owner"),
            || {
                find_numbered_surface(
                    vec![41, 42],
                    Some(42),
                    |_| Ok(vec![]),
                    |number| Ok(Some(*number)),
                )
            },
        )
        .unwrap();
        assert_eq!(result, Some(42));
    }

    #[test]
    fn other_owner_errors_propagate_without_fallback() {
        for error in [
            AdapterError::timeout("owner"),
            AdapterError::new(ErrorCode::ActionNotSupported, "other"),
        ] {
            let result = resolve_owned_surface::<i64>(
                Err(error.clone()),
                |_| panic!("no owner"),
                || panic!("must propagate"),
            );
            let actual = result.unwrap_err();
            assert_eq!(actual.code, error.code);
            assert_eq!(actual.message, error.message);
            assert_eq!(actual.details, error.details);
        }
    }
}
