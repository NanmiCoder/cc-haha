use agent_desktop_core::ErrorCode;

use super::super::menu_layout::{Prop, RawEntry, parse};
use super::*;

fn raw(id: i32, label: &str, children: Vec<RawEntry>) -> RawEntry {
    RawEntry {
        id,
        props: [("label".to_owned(), Prop::Text(label.into()))]
            .into_iter()
            .collect(),
        children,
    }
}

fn target(labels: &[&str], id: i32) -> TrayTarget {
    TrayTarget {
        owner: ":1.7".into(),
        object_path: "/i".into(),
        menu_path: Some("/m".into()),
        entry_id: Some(id),
        label_path: labels.iter().map(|label| (*label).into()).collect(),
    }
}

fn layout(children: Vec<RawEntry>) -> Layout {
    parse(&raw(0, "", children))
}

#[test]
fn a_nested_entry_resolves_by_its_label_path_and_id() {
    let layout = layout(vec![
        raw(1, "More", vec![raw(5, "Deep", vec![])]),
        raw(2, "Open", vec![]),
    ]);
    let found = find(&layout, &target(&["More", "Deep"], 5)).expect("resolves");
    assert_eq!(found.id, 5);
}

#[test]
fn an_unrelated_layout_change_preserves_the_entry() {
    let old = layout(vec![raw(2, "Open", vec![])]);
    let new = layout(vec![raw(2, "Open", vec![]), raw(3, "Added", vec![])]);
    assert!(find(&old, &target(&["Open"], 2)).is_ok());
    assert!(find(&new, &target(&["Open"], 2)).is_ok());
}

#[test]
fn a_label_carrying_another_id_is_a_stale_ref() {
    let layout = layout(vec![raw(8, "Open", vec![])]);
    let error = find(&layout, &target(&["Open"], 2)).expect_err("a different entry");
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn a_missing_label_is_a_stale_ref() {
    let layout = layout(vec![raw(1, "Close", vec![])]);
    let error = find(&layout, &target(&["Open"], 1)).expect_err("gone");
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn duplicate_labels_at_one_level_are_ambiguous_even_when_the_id_would_match() {
    let layout = layout(vec![raw(1, "Twin", vec![]), raw(2, "Twin", vec![])]);
    let error = find(&layout, &target(&["Twin"], 2)).expect_err("ambiguous");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
}

#[test]
fn the_same_label_at_different_levels_is_not_ambiguous() {
    let layout = layout(vec![
        raw(1, "Open", vec![]),
        raw(2, "More", vec![raw(3, "Open", vec![])]),
    ]);
    assert_eq!(
        find(&layout, &target(&["More", "Open"], 3))
            .expect("resolves")
            .id,
        3
    );
    assert_eq!(
        find(&layout, &target(&["Open"], 1)).expect("resolves").id,
        1
    );
}
