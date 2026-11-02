use std::collections::HashMap;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

use super::*;
use crate::tree::element::ancestry;
use crate::tree::live::test_support::{children_reply, read_of};
use crate::tree::properties::liveness::Liveness;
use crate::tree::properties::node_read::read_children;
use crate::tree::vocabulary::role_numbers::{DOCUMENT_WEB, PANEL, PUSH_BUTTON};
use crate::tree::walk::walker::walk_levels;
use crate::tree::{Expansion, Field, NodeClass, WalkLimits};

type Tree = HashMap<u32, Vec<u32>>;

fn deadline() -> Deadline {
    Deadline::after(5_000).expect("a five second deadline builds")
}

fn reader(tree: &Tree, web: bool) -> impl FnMut(&u32) -> Result<Level<u32>, AdapterError> + '_ {
    move |key| {
        Ok(Level {
            children: tree.get(key).cloned().unwrap_or_default(),
            children_unread: false,
            empty_means_unread: web,
        })
    }
}

fn tree() -> Tree {
    Tree::from([(0, vec![1, 2]), (1, vec![3, 4]), (4, vec![5, 6, 7])])
}

#[test]
fn a_path_of_three_indices_lands_on_the_third_child_of_the_second_child_of_the_first() {
    let tree = Tree::from([(0, vec![1, 2]), (2, vec![3, 4]), (4, vec![5, 6, 7])]);
    let landing = descend(0, &[1, 1, 2], deadline(), reader(&tree, false)).expect("descends");
    assert_eq!(landing.element, Some(7));
    assert!(!landing.unread);
}

#[test]
fn an_index_past_the_end_lands_nowhere_and_reports_nothing_unread() {
    let landing = descend(0, &[0, 5], deadline(), reader(&tree(), false)).expect("descends");
    assert_eq!(
        landing,
        Landing {
            element: None,
            unread: false
        }
    );
}

#[test]
fn the_empty_path_lands_on_the_root() {
    let landing = descend(0, &[], deadline(), reader(&tree(), false)).expect("descends");
    assert_eq!(landing.element, Some(0));
}

#[test]
fn a_childless_node_of_a_web_engine_is_unread_and_otherwise_lands_nowhere() {
    let tree = Tree::from([(0, vec![1])]);
    let web = descend(0, &[0, 0], deadline(), reader(&tree, true)).expect("descends");
    assert_eq!(
        web,
        Landing {
            element: None,
            unread: true
        }
    );
    let native = descend(0, &[0, 0], deadline(), reader(&tree, false)).expect("descends");
    assert_eq!(
        native,
        Landing {
            element: None,
            unread: false
        }
    );
}

#[test]
fn a_child_list_that_could_not_be_read_is_unread() {
    let landing = descend(0, &[0], deadline(), |_| {
        Ok(Level {
            children: Vec::new(),
            children_unread: true,
            empty_means_unread: false,
        })
    })
    .expect("descends");
    assert_eq!(
        landing,
        Landing {
            element: None,
            unread: true
        }
    );
}

#[test]
fn a_failed_read_leaves_the_region_unread_and_a_departure_ends_the_descent() {
    let failed = descend(0, &[0], deadline(), |_| {
        Err::<Level<u32>, _>(AdapterError::new(ErrorCode::Internal, "read failed"))
    })
    .expect("a failed level is not an error");
    assert_eq!(
        failed,
        Landing {
            element: None,
            unread: true
        }
    );

    let vanished = descend(0, &[0], deadline(), |_| {
        Err::<Level<u32>, _>(AdapterError::new(ErrorCode::ElementNotFound, "gone"))
    })
    .expect("an object gone mid-descent is unread");
    assert!(vanished.unread);

    for code in [
        ErrorCode::AppNotFound,
        ErrorCode::Timeout,
        ErrorCode::StaleRef,
    ] {
        let error = descend(0, &[0], deadline(), |_| {
            Err::<Level<u32>, _>(AdapterError::new(code.clone(), "left"))
        })
        .expect_err("a departure is carried up");
        assert_eq!(error.code, code);
    }
}

#[test]
fn an_expired_deadline_ends_the_descent_with_the_timeout_before_any_read() {
    let expired = Deadline::after(0).expect("a zero deadline builds");
    let error = descend(0, &[0], expired, |_| {
        panic!("no level may be read after the deadline")
    })
    .map(|_: Landing<u32>| ())
    .expect_err("expired");
    assert_eq!(error.code, ErrorCode::Timeout);
}

#[test]
fn an_object_that_still_answers_but_is_not_in_its_parents_list_is_never_reached() {
    let tree = Tree::from([(0, vec![1]), (9, vec![])]);
    let mut consulted = Vec::new();
    let mut read = reader(&tree, false);
    let landing = descend(0, &[1], deadline(), |key| {
        consulted.push(*key);
        read(key)
    })
    .expect("descends");
    assert_eq!(
        landing,
        Landing {
            element: None,
            unread: false
        }
    );
    assert_eq!(consulted, vec![0]);
}

fn element(bus: &str, path: &str, pid: u32) -> AtspiElement {
    let mut element = AtspiElement::new(bus, path, pid);
    let frame = element.clone();
    element.set_ancestry(ancestry::of_root(&frame));
    element
}

fn node_of(parent: &AtspiElement, role: u32, children: Vec<(String, String)>) -> RawNode {
    let mut node = read_of(role, "n", &[]).node;
    node.element = parent.clone();
    node.children = Field::Present(children);
    node
}

fn raw_children(entries: &[(&str, &str)]) -> Field<Vec<(String, String)>> {
    let reply = children_reply(entries).expect("a reply builds");
    read_children(Ok(reply), Liveness::Alive).expect("the list reads")
}

#[test]
fn the_descent_index_is_the_position_the_walk_recorded_when_the_list_held_a_null_entry() {
    let frame = element(":1.2", "/frame", 40);
    let mut parent = node_of(&frame, PANEL, Vec::new());
    parent.children = raw_children(&[
        (":1.2", "/org/a11y/atspi/null"),
        (":1.2", "/first"),
        (":1.2", "/second"),
    ]);
    let pids = HashMap::from([(":1.2".to_owned(), 40)]);
    let level = level_of(&parent, &pids, false);
    assert_eq!(level.children.len(), 2);

    let walked = walk_levels(
        frame.clone(),
        &WalkLimits::default(),
        deadline(),
        |keys| {
            Ok(keys
                .iter()
                .map(|key| {
                    let children = if key == &frame {
                        level_of(&parent, &pids, false).children
                    } else {
                        Vec::new()
                    };
                    Expansion::read((), children)
                })
                .collect())
        },
        |_| NodeClass::default(),
    )
    .expect("the walk runs");
    let recorded: Vec<usize> = walked
        .root
        .children
        .iter()
        .map(|c| c.source_index)
        .collect();
    assert_eq!(recorded, [0, 1]);

    let landing = descend(frame.clone(), &[1], deadline(), |_| {
        Ok(level_of(&parent, &pids, false))
    })
    .expect("descends");
    assert_eq!(
        landing.element.map(|e| e.path().to_owned()),
        Some("/second".to_owned())
    );
    let raw_index = descend(frame, &[2], deadline(), |_| {
        Ok(level_of(&parent, &pids, false))
    })
    .expect("descends");
    assert_eq!(raw_index.element, None);
}

#[test]
fn a_child_on_another_bus_name_keeps_its_own_process_beside_the_frames() {
    let frame = element(":1.2", "/frame", 40);
    let parent = node_of(
        &frame,
        PANEL,
        vec![
            (":1.7".to_owned(), "/renderer".to_owned()),
            (":1.8".to_owned(), "/second".to_owned()),
            (":1.9".to_owned(), "/lost".to_owned()),
        ],
    );
    let pids = HashMap::from([
        (":1.2".to_owned(), 40),
        (":1.7".to_owned(), 41),
        (":1.8".to_owned(), 41),
    ]);
    let level = level_of(&parent, &pids, false);
    let (renderer, second, lost) = (&level.children[0], &level.children[1], &level.children[2]);
    assert_eq!(renderer.pid(), 41);
    assert_eq!(renderer.frame().map(AtspiElement::pid), Some(40));
    assert_eq!(second.pid(), 41);
    assert_ne!(renderer, second);
    assert_eq!(lost.pid(), crate::tree::walk::walker_expand::UNKNOWN_PID);

    let inner = node_of(
        renderer,
        PANEL,
        vec![(":1.7".to_owned(), "/inside".to_owned())],
    );
    let nested = level_of(&inner, &pids, false).children.remove(0);
    assert_eq!(nested.pid(), 41);
    assert_eq!(nested.frame().map(AtspiElement::pid), Some(40));
}

#[test]
fn passing_through_a_web_document_puts_every_handle_below_it_in_a_web_context() {
    let frame = element(":1.2", "/frame", 40);
    let document = {
        let parent = node_of(
            &frame,
            PANEL,
            vec![(":1.2".to_owned(), "/document".to_owned())],
        );
        level_of(&parent, &HashMap::from([(":1.2".to_owned(), 40)]), true)
            .children
            .remove(0)
    };
    assert!(!document.in_web_document());
    let below = {
        let parent = node_of(
            &document,
            DOCUMENT_WEB,
            vec![(":1.2".to_owned(), "/button".to_owned())],
        );
        level_of(&parent, &HashMap::from([(":1.2".to_owned(), 40)]), true)
            .children
            .remove(0)
    };
    assert!(below.in_web_document());
    assert_eq!(below.frame(), Some(&frame.address()));
    let deeper = {
        let parent = node_of(
            &below,
            PUSH_BUTTON,
            vec![(":1.2".to_owned(), "/label".to_owned())],
        );
        level_of(&parent, &HashMap::from([(":1.2".to_owned(), 40)]), true)
            .children
            .remove(0)
    };
    assert!(deeper.in_web_document());
}
