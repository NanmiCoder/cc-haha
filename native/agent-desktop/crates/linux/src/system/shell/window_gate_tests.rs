use agent_desktop_core::ErrorCode;

use crate::system::shell::fake_tree::{BUS, FakeTree, gnome_shell};
use crate::system::shell::window_gate::check;

#[test]
fn a_live_container_of_the_current_shell_passes() {
    let tree = gnome_shell(true, false);
    check(&tree, &FakeTree::root(), BUS, "/list").expect("the list container is live");
}

#[test]
fn an_id_from_before_a_shell_restart_is_refused_even_with_the_same_path() {
    let tree = gnome_shell(true, false).answering_on_any_bus();
    let error = check(&tree, &FakeTree::root(), ":1.99", "/list")
        .expect_err("the bus name belongs to a replaced shell");
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn a_container_that_no_longer_exists_is_refused() {
    let mut tree = gnome_shell(true, false);
    tree.vanish("/list");
    let error = check(&tree, &FakeTree::root(), BUS, "/list").expect_err("the node is gone");
    assert_eq!(error.code, ErrorCode::StaleRef);
    let unknown = check(&tree, &FakeTree::root(), BUS, "/never").expect_err("no such path");
    assert_eq!(unknown.code, ErrorCode::StaleRef);
}
