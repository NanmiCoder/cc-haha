use agent_desktop_core::{Deadline, ErrorCode};

use crate::system::shell::fake_tree::{FakeTree, PANEL, WINDOW, at, element, gnome_shell};
use crate::system::shell::search::walk;

fn deadline() -> Deadline {
    Deadline::after(10_000).expect("a deadline builds")
}

fn small() -> FakeTree {
    let mut tree = FakeTree::new();
    tree.add(None, "/w", WINDOW, "", at(0, 0, 10, 10));
    tree.add(Some("/w"), "/a", PANEL, "", at(0, 0, 10, 10));
    tree.add(Some("/w"), "/b", PANEL, "", at(0, 0, 10, 10));
    tree.add(Some("/a"), "/a1", PANEL, "", at(0, 0, 10, 10));
    tree.add(Some("/a"), "/a2", PANEL, "", at(0, 0, 10, 10));
    tree.add(Some("/b"), "/b1", PANEL, "", at(0, 0, 10, 10));
    tree
}

#[test]
fn nodes_come_in_paint_order_and_know_their_parents() {
    let walked = walk(&small(), &element("/w"), deadline(), &|_| false).expect("a walk");
    let paths: Vec<&str> = walked
        .visits
        .iter()
        .map(|visit| visit.light.element.path())
        .collect();
    assert_eq!(paths, ["/w", "/a", "/a1", "/a2", "/b", "/b1"]);
    let parents: Vec<Option<usize>> = walked.visits.iter().map(|visit| visit.parent).collect();
    assert_eq!(parents, [None, Some(0), Some(1), Some(1), Some(0), Some(4)]);
    assert_eq!(walked.visits[1].children, [2, 3]);
    assert!(walked.complete);
}

#[test]
fn within_follows_the_parents_and_position_finds_an_element() {
    let walked = walk(&small(), &element("/w"), deadline(), &|_| false).expect("a walk");
    assert!(walked.within(3, 1));
    assert!(walked.within(3, 3));
    assert!(!walked.within(3, 4));
    assert_eq!(walked.position(&element("/b1")), Some(5));
    assert_eq!(walked.position(&element("/missing")), None);
}

#[test]
fn a_pruned_node_is_neither_listed_nor_entered() {
    let walked = walk(&small(), &element("/w"), deadline(), &|light| {
        light.element.path() == "/a"
    })
    .expect("a walk");
    let paths: Vec<&str> = walked
        .visits
        .iter()
        .map(|visit| visit.light.element.path())
        .collect();
    assert_eq!(paths, ["/w", "/b", "/b1"]);
}

#[test]
fn a_node_that_vanishes_during_the_walk_is_skipped_and_the_walk_says_so() {
    let mut tree = gnome_shell(true, false);
    tree.vanish("/left");
    let walked = walk(&tree, &element("/w"), deadline(), &|_| false).expect("a walk");
    assert!(!walked.complete);
    assert!(walked.position(&element("/system")).is_some());
    assert!(walked.position(&element("/left")).is_none());
}

#[test]
fn an_expired_deadline_is_a_timeout_not_an_empty_walk() {
    let expired = Deadline::after(1).expect("a deadline builds");
    std::thread::sleep(std::time::Duration::from_millis(5));
    let error = walk(&small(), &element("/w"), expired, &|_| false).expect_err("no time");
    assert_eq!(error.code, ErrorCode::Timeout);
}

#[test]
fn a_walk_over_the_budget_is_an_error_and_never_a_shorter_tree() {
    let mut tree = FakeTree::new();
    tree.add(None, "/w", WINDOW, "", at(0, 0, 0, 0));
    for index in 0..10_000 {
        tree.add(
            Some("/w"),
            &format!("/node{index}"),
            PANEL,
            "",
            at(0, 0, 0, 0),
        );
    }
    let error = walk(&tree, &element("/w"), deadline(), &|_| false).expect_err("over budget");
    assert_eq!(error.code, ErrorCode::Timeout);
}
