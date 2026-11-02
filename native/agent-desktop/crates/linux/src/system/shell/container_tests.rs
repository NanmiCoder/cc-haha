use std::cell::Cell;

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};

use super::{Landmark, Located, UNREAD_RETRIES, locate_in, locate_settled};
use crate::system::shell::anchor::Anchor;
use crate::system::shell::fake_tree::MENU;
use crate::system::shell::fake_tree::{FakeTree, PANEL, WINDOW, at, gnome_shell};
use crate::system::shell::light::{Light, Nodes};
use crate::tree::AtspiElement;
use crate::tree::vocabulary::role_numbers::{LABEL, PUSH_BUTTON, TOGGLE_BUTTON};

fn locate(
    tree: &FakeTree,
    landmark: Landmark,
) -> Result<super::Located, agent_desktop_core::AdapterError> {
    locate_in(
        tree,
        &FakeTree::root(),
        Anchor::Landmark(landmark),
        Deadline::after(5_000).unwrap(),
    )
}

#[test]
fn labels_depths_and_panel_geometry_do_not_prove_popup_identity() {
    let tree = gnome_shell(true, true);
    for landmark in [Landmark::SystemMenu, Landmark::DockPanel] {
        let error =
            locate(&tree, landmark).expect_err("generic panels and labels prove no popup identity");
        assert_eq!(error.code, ErrorCode::ActionNotSupported, "{landmark:?}");
        assert_eq!(error.details.unwrap()["kind"], "shell_container_unproven");
    }
}

#[test]
fn the_message_list_is_the_container_two_levels_above_the_footer_row() {
    for open in [true, false] {
        let located = locate(&gnome_shell(open, false), Landmark::MessageList)
            .expect("the footer row proves the list");
        assert_eq!(located.container.element.path(), "/list");
    }
}

#[test]
fn the_date_menu_is_the_one_showing_menu_without_a_name() {
    let located = locate(&gnome_shell(false, false), Landmark::DateMenu).expect("date menu");
    assert_eq!(located.anchor.element.path(), "/date");
}

#[test]
fn a_clear_button_named_like_the_footer_proves_nothing_without_its_row() {
    let mut tree = FakeTree::new();
    tree.add(None, "/w", WINDOW, "", at(0, 0, 0, 0));
    tree.add(Some("/w"), "/p", PANEL, "", at(0, 0, 0, 0));
    tree.add(Some("/p"), "/q", PANEL, "", at(0, 0, 0, 0));
    tree.add(
        Some("/q"),
        "/clear",
        PUSH_BUTTON,
        "Clear all notifications",
        at(0, 0, 10, 10),
    );
    let error = locate(&tree, Landmark::MessageList).expect_err("no footer row");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
}

#[test]
fn two_footer_rows_refuse_instead_of_selecting_by_order() {
    let mut tree = gnome_shell(true, false);
    tree.add(Some("/p2"), "/list2", PANEL, "", at(0, 0, 10, 10));
    tree.add(Some("/list2"), "/footer2", PANEL, "", at(0, 0, 10, 10));
    tree.add(Some("/footer2"), "/l2", LABEL, "", at(0, 0, 10, 10));
    tree.add(Some("/footer2"), "/t2", TOGGLE_BUTTON, "", at(0, 0, 10, 10));
    tree.add(Some("/footer2"), "/c2", PUSH_BUTTON, "", at(0, 0, 10, 10));
    assert_eq!(
        locate(&tree, Landmark::MessageList).unwrap_err().code,
        ErrorCode::AmbiguousTarget
    );
}

#[test]
fn a_second_unnamed_showing_menu_makes_the_date_menu_ambiguous() {
    let mut tree = gnome_shell(false, false);
    tree.add(Some("/center"), "/other", MENU, "", at(10, 0, 50, 32));
    assert_eq!(
        locate(&tree, Landmark::DateMenu).unwrap_err().code,
        ErrorCode::AmbiguousTarget
    );
}

#[test]
fn a_walk_that_lost_a_node_proves_no_uniqueness() {
    let whole = gnome_shell(true, false);
    let mut cut = gnome_shell(true, false);
    cut.vanish("/left");
    for landmark in [Landmark::MessageList, Landmark::DateMenu] {
        assert!(
            locate(&whole, landmark).is_ok(),
            "{landmark:?} is found when the walk is whole"
        );
        let error = locate(&cut, landmark).expect_err("a second match may hide in the unread node");
        assert_eq!(error.code, ErrorCode::ActionNotSupported, "{landmark:?}");
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert!(
            error
                .platform_detail
                .is_some_and(|detail| detail.contains("left the tree")),
            "{landmark:?} names the lost node"
        );
        assert_eq!(error.details.unwrap()["kind"], "shell_container_unproven");
    }
}

struct Settling<'a> {
    tree: &'a FakeTree,
    losses: Cell<usize>,
}

impl Nodes for Settling<'_> {
    fn read(&self, node: &AtspiElement) -> Result<Light, AdapterError> {
        if node.path() == "/left" && self.losses.get() > 0 {
            self.losses.set(self.losses.get() - 1);
            return Err(AdapterError::new(ErrorCode::ElementNotFound, "gone"));
        }
        self.tree.read(node)
    }
}

fn locate_while_losing(
    losses: usize,
    landmark: Landmark,
) -> (Result<Located, AdapterError>, usize) {
    let tree = gnome_shell(true, false);
    let nodes = Settling {
        tree: &tree,
        losses: Cell::new(losses),
    };
    let mut pauses = 0;
    let found = locate_settled(
        &nodes,
        &FakeTree::root(),
        Anchor::Landmark(landmark),
        Deadline::after(5_000).unwrap(),
        &mut |_| pauses += 1,
    );
    (found, pauses)
}

#[test]
fn a_node_that_is_gone_from_the_next_walk_does_not_stop_the_lookup() {
    let (found, pauses) = locate_while_losing(2, Landmark::MessageList);
    let located = found.expect("the third walk is whole");
    assert_eq!(located.container.element.path(), "/list");
    assert_eq!(pauses, 2);
}

#[test]
fn a_walk_that_keeps_losing_a_node_refuses_after_the_retries() {
    let (found, pauses) = locate_while_losing(usize::MAX, Landmark::DateMenu);
    assert_eq!(found.unwrap_err().code, ErrorCode::ActionNotSupported);
    assert_eq!(pauses, UNREAD_RETRIES);
}

#[test]
fn a_refusal_that_is_not_a_lost_node_is_never_retried() {
    let tree = gnome_shell(true, false);
    let mut pauses = 0;
    let error = locate_settled(
        &tree,
        &FakeTree::root(),
        Anchor::Landmark(Landmark::SystemMenu),
        Deadline::after(5_000).unwrap(),
        &mut |_| pauses += 1,
    )
    .expect_err("generic panels prove no popup identity");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(pauses, 0);
}

#[test]
fn an_unproven_native_tray_uses_only_the_logical_shell_root() {
    let tree = gnome_shell(false, false);
    let located =
        locate(&tree, Landmark::TrayPanel).expect("a logical tray is independent of panel layout");
    assert_eq!(located.container.element.path(), "/w");
    assert_eq!(located.container.role, WINDOW);
}
