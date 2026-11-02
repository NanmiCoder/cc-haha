//! Bounded SelectionItem descendant search and scroll-to-realize (A19-7).

use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

use crate::tree::element::UIAElement;

pub(crate) const MAX_SELECT_NODES: usize = 2_048;
pub(crate) const MAX_SELECT_DEPTH: u8 = 8;
const MAX_REALIZE_SCROLLS: u32 = 16;

fn select_node_budget_has_room(visited: usize, pending: usize, staged: usize) -> bool {
    visited.saturating_add(pending).saturating_add(staged) < MAX_SELECT_NODES
}

/// One realize scroll attempt: either expose a searchable window or stop.
pub(crate) enum RealizeScrollStep {
    Window { end_of_range: bool },
    Stop,
}

/// Search after every completed realize scroll so intermediate virtualized
/// duplicates cannot scroll past the finder unnoticed.
pub(crate) fn drive_realize_scrolls(
    max_steps: u32,
    mut next: impl FnMut() -> Result<RealizeScrollStep, AdapterError>,
    mut after_scroll: impl FnMut() -> Result<(), AdapterError>,
) -> Result<(), AdapterError> {
    for _ in 0..max_steps {
        match next()? {
            RealizeScrollStep::Window { end_of_range } => {
                after_scroll()?;
                if end_of_range {
                    break;
                }
            }
            RealizeScrollStep::Stop => break,
        }
    }
    Ok(())
}

/// Second same-name SelectionItem is `AMBIGUOUS_TARGET`, never a silent pick.
pub(crate) fn accept_selection_match(already_found: bool) -> Result<(), AdapterError> {
    if already_found {
        Err(AdapterError::ambiguous_target(
            "Multiple SelectionItem elements share the requested accessible name",
        )
        .with_details(serde_json::json!({
            "kind": "ambiguous_select_value",
        })))
    } else {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        AdapterError, Deadline, ErrorCode, MAX_REALIZE_SCROLLS, MAX_SELECT_DEPTH, MAX_SELECT_NODES,
        RealizeScrollStep, UIAElement, accept_selection_match, drive_realize_scrolls,
        select_node_budget_has_room,
    };
    use crate::actions::mutation::{classify_success, classify_write};
    use crate::actions::scroll::SCROLL_LABEL;
    use crate::tree::automation::automation_client;
    use crate::tree::automation::uia_failure_error;
    use crate::tree::name_evidence::{name_fields, read_label};
    use crate::tree::properties::element_properties::ElementProperties;
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::read_one;
    use crate::tree::walk::walker::TreeSource;
    use crate::tree::walk::walker_source::{UiaTreeSource, same_element};
    use agent_desktop_core::LocatorField;
    use uiautomation::patterns::UIScrollPattern;
    use uiautomation::types::ScrollAmount;

    pub(crate) fn find_named_selection_item(
        root: &UIAElement,
        value: &str,
        deadline: Deadline,
        prior: Option<&UIAElement>,
    ) -> Result<Option<UIAElement>, AdapterError> {
        let client = automation_client()?;
        let source = UiaTreeSource::for_root(root)?;
        let prepared = source.prepare_root(root)?;
        let mut stack = Vec::new();
        push_children(&source, (&prepared, 1), deadline, 0, &mut stack)?;
        let mut visited = 0_usize;
        let mut found = prior.cloned();
        while let Some((candidate, depth)) = stack.pop() {
            deadline.ensure_remaining()?;
            visited = visited.saturating_add(1);
            if visited > MAX_SELECT_NODES {
                return Err(node_budget_error());
            }
            if selection_item_available(&candidate) && name_matches(&candidate, value) {
                match &found {
                    None => found = Some(candidate.clone()),
                    Some(prev) if same_element(&client, prev, &candidate) => {}
                    Some(_) => {
                        accept_selection_match(true)?;
                    }
                }
            }
            if depth < MAX_SELECT_DEPTH {
                push_children(
                    &source,
                    (&candidate, depth.saturating_add(1)),
                    deadline,
                    visited,
                    &mut stack,
                )?;
            }
        }
        Ok(found)
    }

    pub(crate) fn scroll_to_realize(
        element: &UIAElement,
        deadline: Deadline,
        mut after_scroll: impl FnMut() -> Result<(), AdapterError>,
    ) -> Result<(), AdapterError> {
        if read_one(element, TreeProperty::ScrollAvailable).flag() != Some(true) {
            return Ok(());
        }
        let Ok(pattern) = element.0.get_pattern::<UIScrollPattern>() else {
            return Ok(());
        };
        if !pattern.is_vertically_scrollable().unwrap_or(false) {
            return Ok(());
        }
        drive_realize_scrolls(
            MAX_REALIZE_SCROLLS,
            || {
                deadline.ensure_remaining()?;
                let before = pattern.get_vertical_scroll_percent().ok();
                match pattern.scroll(ScrollAmount::NoAmount, ScrollAmount::SmallIncrement) {
                    Ok(()) => {
                        let _ = classify_success()?;
                    }
                    Err(error) => {
                        let _ = classify_write("Scroll", SCROLL_LABEL, &error)?;
                        return Ok(RealizeScrollStep::Stop);
                    }
                }
                let after = pattern.get_vertical_scroll_percent().ok();
                Ok(RealizeScrollStep::Window {
                    end_of_range: before.is_some() && before == after,
                })
            },
            &mut after_scroll,
        )
    }

    pub(crate) fn selection_item_available(element: &UIAElement) -> bool {
        read_one(element, TreeProperty::SelectionItemAvailable).flag() == Some(true)
    }

    pub(crate) fn name_matches(element: &UIAElement, value: &str) -> bool {
        let properties = ElementProperties::from_reads(vec![
            (TreeProperty::Name, read_one(element, TreeProperty::Name)),
            (
                TreeProperty::FullDescription,
                read_one(element, TreeProperty::FullDescription),
            ),
            (
                TreeProperty::HelpText,
                read_one(element, TreeProperty::HelpText),
            ),
            (
                TreeProperty::IsPassword,
                read_one(element, TreeProperty::IsPassword),
            ),
        ]);
        let label = read_label(element, false);
        let (name, _) = name_fields(&properties, &label);
        matches!(
            name,
            LocatorField::Known(text) if text.eq_ignore_ascii_case(value)
        )
    }

    fn push_children(
        source: &UiaTreeSource,
        (parent, child_depth): (&UIAElement, u8),
        deadline: Deadline,
        visited: usize,
        stack: &mut Vec<(UIAElement, u8)>,
    ) -> Result<(), AdapterError> {
        deadline.ensure_remaining()?;
        let mut child = match source.first_child(parent) {
            Ok(child) => Some(child),
            Err(failure) if failure.is_exhaustion() => None,
            Err(failure) => {
                return Err(uia_failure_error(failure, "enumerate children for select"));
            }
        };
        let mut siblings = Vec::new();
        while let Some(current) = child {
            if !select_node_budget_has_room(visited, stack.len(), siblings.len()) {
                return Err(node_budget_error());
            }
            deadline.ensure_remaining()?;
            let next = match source.next_sibling(&current) {
                Ok(next) => Some(next),
                Err(failure) if failure.is_exhaustion() => None,
                Err(failure) => {
                    return Err(uia_failure_error(failure, "enumerate siblings for select"));
                }
            };
            siblings.push(current);
            child = next;
        }
        for sibling in siblings.into_iter().rev() {
            stack.push((sibling, child_depth));
        }
        Ok(())
    }

    fn node_budget_error() -> AdapterError {
        AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Select search exceeded its accessibility-node budget",
        )
        .with_details(serde_json::json!({
            "kind": "select_node_limit",
            "limit": MAX_SELECT_NODES,
            "complete": false,
        }))
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{AdapterError, Deadline, UIAElement};

    pub(crate) fn find_named_selection_item(
        _root: &UIAElement,
        _value: &str,
        _deadline: Deadline,
        _prior: Option<&UIAElement>,
    ) -> Result<Option<UIAElement>, AdapterError> {
        Ok(None)
    }

    pub(crate) fn scroll_to_realize(
        _element: &UIAElement,
        _deadline: Deadline,
        _after_scroll: impl FnMut() -> Result<(), AdapterError>,
    ) -> Result<(), AdapterError> {
        Ok(())
    }

    pub(crate) fn selection_item_available(_element: &UIAElement) -> bool {
        false
    }

    pub(crate) fn name_matches(_element: &UIAElement, _value: &str) -> bool {
        false
    }
}

pub(crate) use imp::{
    find_named_selection_item, name_matches, scroll_to_realize, selection_item_available,
};

#[cfg(test)]
mod tests {
    use super::{
        MAX_SELECT_DEPTH, MAX_SELECT_NODES, RealizeScrollStep, accept_selection_match,
        drive_realize_scrolls, select_node_budget_has_room,
    };
    use agent_desktop_core::{AdapterError, ErrorCode};
    use std::cell::Cell;

    #[test]
    fn select_search_depth_budget_is_eight() {
        assert_eq!(MAX_SELECT_DEPTH, 8);
    }

    #[test]
    fn sibling_staging_reserves_space_with_visited_and_pending_nodes() {
        assert!(select_node_budget_has_room(MAX_SELECT_NODES - 1, 0, 0));
        assert!(!select_node_budget_has_room(MAX_SELECT_NODES - 1, 1, 0));
        assert!(!select_node_budget_has_room(1_000, 1_000, 48));
    }

    #[test]
    fn first_selection_match_is_accepted() {
        accept_selection_match(false).expect("first");
    }

    #[test]
    fn second_selection_match_is_ambiguous() {
        let error = accept_selection_match(true).expect_err("duplicate");
        assert_eq!(error.code, ErrorCode::AmbiguousTarget);
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("kind"))
                .and_then(serde_json::Value::as_str),
            Some("ambiguous_select_value")
        );
    }

    #[test]
    fn realize_searches_after_each_scroll_window() {
        let steps = Cell::new(0u8);
        let searches = Cell::new(0u8);
        drive_realize_scrolls(
            8,
            || {
                let n = steps.get();
                steps.set(n + 1);
                Ok(match n {
                    0 | 1 => RealizeScrollStep::Window {
                        end_of_range: false,
                    },
                    2 => RealizeScrollStep::Window { end_of_range: true },
                    _ => RealizeScrollStep::Stop,
                })
            },
            || {
                searches.set(searches.get() + 1);
                Ok(())
            },
        )
        .expect("drive");
        assert_eq!(steps.get(), 3);
        assert_eq!(searches.get(), 3);
    }

    #[test]
    fn realize_stop_skips_search_for_failed_scroll() {
        let searches = Cell::new(0u8);
        drive_realize_scrolls(
            8,
            || Ok(RealizeScrollStep::Stop),
            || {
                searches.set(searches.get() + 1);
                Ok(())
            },
        )
        .expect("drive");
        assert_eq!(searches.get(), 0);
    }

    #[test]
    fn mid_realize_search_error_aborts_drive() {
        let error = drive_realize_scrolls(
            8,
            || {
                Ok(RealizeScrollStep::Window {
                    end_of_range: false,
                })
            },
            || {
                Err(AdapterError::ambiguous_target(
                    "Multiple SelectionItem elements share the requested accessible name",
                ))
            },
        )
        .expect_err("ambiguous");
        assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    }
}
