use agent_desktop_core::ErrorCode;

use super::{choose, is_menu_entry, menu_closed, open_handle, resolve_contextual};
use crate::tree::AtspiElement;
use crate::tree::menu::menu_context::MenuContext;
use crate::tree::placement::popup_position::PopupPosition;

fn element(path: &str) -> AtspiElement {
    AtspiElement::new(":1.2", path, 7)
}

fn kind_of(error: &agent_desktop_core::AdapterError) -> Option<&str> {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(serde_json::Value::as_str)
}

#[test]
fn a_ref_no_open_popup_answers_to_is_stale_because_the_menu_closed() {
    let error = resolve_contextual(
        &crate::tree::live::test_support::ref_entry("menuitem"),
        element("/owner"),
        Vec::new(),
        |_, _| panic!("no popup to resolve"),
    )
    .expect_err("no popup");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(kind_of(&error), Some("menu_closed"));
    assert_eq!(menu_closed().code, ErrorCode::StaleRef);
    let hint = error.suggestion.expect("closed-menu recovery");
    assert!(hint.contains("opener"), "{hint}");
    assert!(hint.contains("new ref"), "{hint}");
}

#[test]
fn one_popup_answering_resolves_the_ref() {
    let landed = choose(vec![element("/item")], None).expect("a landing");
    assert_eq!(landed.path(), "/item");
}

#[test]
fn two_popups_answering_are_ambiguous() {
    let error = choose(vec![element("/a"), element("/b")], None).expect_err("two landings");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
}

#[test]
fn a_replacement_popup_with_the_same_item_path_cannot_resolve_an_old_ref() {
    let original = MenuContext::test("/popup/a", 10);
    let replacement = MenuContext::test("/popup/b", 20);
    let mut entry = crate::tree::live::test_support::ref_entry("menuitem");
    entry.identity.retained_object = Some(original.encode("/shared/item"));
    let mut attempted = false;

    let result = resolve_contextual(
        &entry,
        element("/owner"),
        vec![(replacement, element("/popup/b"))],
        |_root, _entry| {
            attempted = true;
            Ok(element("/shared/item"))
        },
    );

    let error = result.expect_err("the captured popup context changed");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(kind_of(&error), Some("menu_context_changed"));
    assert!(error.suggestion.unwrap().contains("fresh menu snapshot"));
    assert!(
        !attempted,
        "the replacement popup must not reach child resolution"
    );
}

#[test]
fn an_incomplete_open_popup_does_not_prove_the_menu_closed() {
    for (original, current) in [
        (
            MenuContext::test("/popup", 10),
            MenuContext::test_incomplete("/popup", 10),
        ),
        (
            MenuContext::test_incomplete("/popup", 10),
            MenuContext::test("/popup", 10),
        ),
    ] {
        let mut entry = crate::tree::live::test_support::ref_entry("menuitem");
        entry.identity.retained_object = Some(original.encode("/item"));
        let error = resolve_contextual(
            &entry,
            element("/owner"),
            vec![(current, element("/popup"))],
            |_, _| panic!("incomplete context must not resolve a child"),
        )
        .expect_err("the popup could not be fully read");
        assert_eq!(kind_of(&error), Some("menu_context_unknown"));
        assert_eq!(error.details.as_ref().unwrap()["complete"], false);
        assert!(error.is_explicitly_retryable());
    }
}

#[test]
fn a_successful_menu_resolution_carries_its_owner_window() {
    let context = MenuContext::test("/popup", 10);
    let mut entry = crate::tree::live::test_support::ref_entry("menuitem");
    entry.identity.retained_object = Some(context.encode("/item"));
    let owner = AtspiElement::new(":1.2", "/owner", 77);

    let target = resolve_contextual(
        &entry,
        owner.clone(),
        vec![(context, element("/popup"))],
        |_root, _entry| Ok(element("/item")),
    )
    .expect("the matching menu item resolves");

    assert_eq!(target.menu_owner(), Some(owner));
}

#[test]
fn a_refusal_that_is_not_staleness_is_kept_when_nothing_landed() {
    let refusal = agent_desktop_core::AdapterError::timeout("slow");
    let error = choose(Vec::<AtspiElement>::new(), Some(refusal)).expect_err("a refusal");
    assert_eq!(error.code, ErrorCode::Timeout);
}

#[test]
fn a_landing_beats_a_refusal_from_another_popup() {
    let refusal = agent_desktop_core::AdapterError::timeout("slow");
    let landed = choose(vec![element("/item")], Some(refusal)).expect("a landing");
    assert_eq!(landed.path(), "/item");
}

#[test]
fn a_ref_taken_on_the_menu_surface_is_a_menu_entry_and_a_window_ref_is_not() {
    let mut entry = crate::tree::live::test_support::ref_entry("menuitem");
    entry.source.source_surface = agent_desktop_core::SnapshotSurface::Menu;
    assert!(is_menu_entry(&entry));
    entry.source.source_surface = agent_desktop_core::SnapshotSurface::Window;
    assert!(!is_menu_entry(&entry));
}

#[test]
fn an_item_found_in_a_popup_that_has_closed_resolves_to_the_closed_menu_refusal() {
    let error = open_handle(element("/item"), |_| Ok(PopupPosition::Unmapped))
        .err()
        .expect("a closed popup's item");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(kind_of(&error), Some("menu_closed"));
    assert!(!error.is_explicitly_retryable());
}

#[test]
fn an_open_item_resolves_without_requiring_pointer_geometry() {
    for position in [PopupPosition::Placed, PopupPosition::Unplaceable] {
        let handle = open_handle(element("/item"), |_| Ok(position)).expect("a handle");
        let landed = crate::tree::atspi_element(&handle).expect("an element");
        assert_eq!(landed.path(), "/item");
    }
}

#[test]
fn a_failed_position_read_preserves_its_error() {
    let slow = open_handle(element("/item"), |_| {
        Err(agent_desktop_core::AdapterError::timeout("slow"))
    })
    .err()
    .expect("the read failed");
    assert_eq!(slow.code, ErrorCode::Timeout);
}
