use std::collections::HashMap;

use super::{Ancestry, child, of_root};
use crate::tree::live::test_support::read_of;
use crate::tree::walk::walker_expand::child_elements;
use crate::tree::{AtspiElement, Field};

fn element(bus: &str, path: &str, pid: u32) -> AtspiElement {
    AtspiElement::new(bus, path, pid)
}

#[test]
fn children_inherit_the_frame_and_nearest_scroll_container() {
    let frame = element(":1.1", "/root/frame", 1);
    let scroll = element(":1.1", "/root/frame/scroll", 1);
    let mut parent = element(":1.1", "/root/frame/scroll/inner", 1);
    parent.set_ancestry(Ancestry::of(
        Some(frame.clone()),
        Some(scroll.clone()),
        false,
    ));
    let inherited = child(&parent, Some(39));
    assert_eq!(inherited.frame(), Some(&frame));
    assert_eq!(inherited.scroll_container(), Some(&scroll));
    assert_eq!(inherited.button_parent(), None);
    assert_eq!(
        child(&parent, Some(43)).button_parent(),
        Some(parent.address())
    );
    assert_eq!(
        child(&parent, Some(129)).button_parent(),
        Some(parent.address())
    );

    for role in [49, 68] {
        let mut pane = element(":1.1", "/root/frame/scroll", 1);
        pane.set_ancestry(Ancestry::of(Some(frame.clone()), None, false));
        assert_eq!(
            child(&pane, Some(role)).scroll_container(),
            Some(&pane.address()),
            "role {role}"
        );
    }
}

#[test]
fn child_construction_carries_bus_pid_and_ancestry() {
    let frame = element(":1.1", "/root/frame", 1);
    let mut read = read_of(49, "scroll", &[]);
    read.node.element = element(":1.1", "/root/frame/scroll", 1);
    read.node
        .element
        .set_ancestry(Ancestry::of(Some(frame.clone()), None, false));
    read.node.children = Field::Present(vec![(
        ":2.9".to_owned(),
        "/org/a11y/atspi/accessible/4".to_owned(),
    )]);
    let pids = HashMap::from([(":2.9".to_owned(), 9u32)]);
    let children = child_elements(&read.node, &pids);
    assert_eq!(children.len(), 1);
    let child = &children[0];
    assert_eq!(child.bus_name(), ":2.9");
    assert_eq!(child.pid(), 9);
    assert_eq!(child.frame(), Some(&frame));
    assert_eq!(
        child.scroll_container(),
        Some(&element(":1.1", "/root/frame/scroll", 1))
    );
}

#[test]
fn web_document_ancestry_propagates_and_root_starts_outside() {
    for role in [95, 82] {
        assert!(child(&element(":1.1", "/root", 1), Some(role)).in_web_document());
    }
    let mut inside = element(":1.1", "/root/node", 1);
    inside.set_ancestry(Ancestry::of(None, None, true));
    assert!(child(&inside, Some(39)).in_web_document());
    assert!(child(&inside, None).in_web_document());

    let mut outside = element(":1.1", "/root/node", 1);
    outside.set_ancestry(Ancestry::of(None, None, false));
    assert!(!child(&outside, Some(39)).in_web_document());
    assert!(!child(&outside, None).in_web_document());
    assert!(!of_root(&element(":1.1", "/root/frame", 1)).in_web_document());
}

#[test]
fn ancestry_is_ignored_for_address_equality_but_address_conversion_drops_it() {
    let plain = element(":1.1", "/root/frame/node", 1);
    let mut with = element(":1.1", "/root/frame/node", 1);
    let frame = element(":1.1", "/root/frame", 1);
    let scroll = element(":1.1", "/root/frame/scroll", 1);
    with.set_ancestry(Ancestry::of(Some(frame), Some(scroll), true));
    assert_eq!(plain, with);
    let address = with.address();
    assert_eq!(address.frame(), None);
    assert_eq!(address.scroll_container(), None);
    assert!(!address.in_web_document());
}

#[test]
fn menu_paths_follow_walked_parents_without_normal_node_ancestors() {
    use crate::tree::vocabulary::role_numbers::{MENU, MENU_BAR, MENU_ITEM, PANEL};

    let bar = element(":1.1", "/bar", 1);
    let mut file = element(":1.1", "/file", 1);
    file.set_ancestry(child(&bar, Some(MENU_BAR)));
    let mut recent = element(":1.1", "/recent", 1);
    recent.set_ancestry(child(&file, Some(MENU)));
    let nested = child(&recent, Some(MENU_ITEM));
    assert_eq!(nested.menu_ancestors(), &[file.address(), recent.address()]);
    assert_eq!(child(&file, Some(MENU)).menu_ancestors(), &[file.address()]);
    assert!(child(&bar, Some(PANEL)).menu_ancestors().is_empty());
    assert!(child(&recent, Some(MENU_BAR)).menu_ancestors().is_empty());
    assert!(recent.address().ancestry().menu_ancestors().is_empty());
}
