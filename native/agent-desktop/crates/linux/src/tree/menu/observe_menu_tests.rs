use agent_desktop_core::ErrorCode;

use super::{outermost, rooted};
use crate::system::menu::menu_surface::{MenuFamily, MenuPopup};
use crate::tree::AtspiElement;
use crate::tree::menu::menu_context::MenuContext;

fn popup(path: &str) -> MenuPopup {
    MenuPopup {
        root: AtspiElement::new(":1.2", path, 7),
        family: MenuFamily::Qt,
        items: 3,
        context: MenuContext::test(path, 3),
    }
}

#[test]
fn a_closed_menu_is_not_found_and_never_an_empty_tree() {
    let error = outermost(Vec::new()).map(|_| ()).expect_err("no popup");
    assert_eq!(error.code, ErrorCode::ElementNotFound);
    assert!(error.suggestion.is_some());
}

#[test]
fn the_outermost_popup_is_the_one_observed() {
    let chosen = outermost(vec![popup("/outer"), popup("/inner")]).expect("a popup");
    assert_eq!(chosen.root.path(), "/outer");
}

#[test]
fn the_popup_root_is_its_own_frame_and_not_the_window() {
    let root = rooted(&popup("/popup").root);
    assert_eq!(root.frame().map(AtspiElement::path), Some("/popup"));
}

mod pruning {
    use super::super::{BULK_CHILDREN, is_cut_short_beyond_pruning, is_pruned};
    use crate::tree::live::test_support::read_of;
    use crate::tree::vocabulary::role_numbers::{LIST, PANEL, TABLE};
    use crate::tree::{ObservedRead, WalkedNode};

    fn node(role: u32, children: Vec<WalkedNode<ObservedRead>>) -> WalkedNode<ObservedRead> {
        WalkedNode {
            payload: read_of(role, "n", &[]),
            children,
            truncated: false,
            child_count: None,
            source_index: 0,
            in_web_document: false,
        }
    }

    fn cut_list(role: u32, total: u32) -> WalkedNode<ObservedRead> {
        let rows = (0..BULK_CHILDREN)
            .map(|_| node(PANEL, Vec::new()))
            .collect();
        let mut list = node(role, rows);
        list.truncated = true;
        list.child_count = Some(total);
        list
    }

    #[test]
    fn a_list_or_table_cut_at_the_child_limit_is_pruned_and_not_cut_short() {
        for role in [LIST, TABLE] {
            let list = cut_list(role, 3000);
            assert!(is_pruned(&list));
            assert!(!is_cut_short_beyond_pruning(&node(PANEL, vec![list])));
        }
    }

    #[test]
    fn a_container_that_is_not_a_list_cut_at_the_limit_is_cut_short() {
        let panel = cut_list(PANEL, 3000);
        assert!(!is_pruned(&panel));
        assert!(is_cut_short_beyond_pruning(&panel));
    }

    #[test]
    fn a_list_whose_read_stopped_short_of_the_limit_is_cut_short() {
        let mut list = cut_list(LIST, 3000);
        list.children.truncate(10);
        assert!(!is_pruned(&list));
        assert!(is_cut_short_beyond_pruning(&list));
    }

    #[test]
    fn a_truncation_below_a_pruned_list_still_counts() {
        let mut list = cut_list(LIST, 3000);
        list.children[3].truncated = true;
        assert!(is_cut_short_beyond_pruning(&list));
    }

    fn walked(role: u32, children: u32) -> WalkedNode<ObservedRead> {
        use crate::tree::walk::walker::walk_levels;
        use crate::tree::walk::wrapper::classify;
        use crate::tree::{Expansion, WalkLimits};
        let limits = WalkLimits {
            bulk_children: BULK_CHILDREN,
            ..WalkLimits::default()
        };
        walk_levels(
            0u32,
            &limits,
            agent_desktop_core::Deadline::after(5_000).expect("deadline"),
            |level| {
                Ok(level
                    .iter()
                    .map(|key| {
                        if *key == 0 {
                            Expansion::read(read_of(role, "c", &[]), (1..=children).collect())
                        } else {
                            Expansion::read(read_of(PANEL, "k", &[]), Vec::new())
                        }
                    })
                    .collect())
            },
            classify,
        )
        .expect("a walk")
        .root
    }

    #[test]
    fn a_plain_container_of_sixty_children_is_read_whole() {
        let root = walked(PANEL, 60);
        assert_eq!(root.children.len(), 60);
        assert!(!is_cut_short_beyond_pruning(&root));
    }

    #[test]
    fn a_list_of_sixty_children_is_cut_at_the_limit_and_counts_as_read() {
        let root = walked(LIST, 60);
        assert_eq!(root.children.len(), BULK_CHILDREN);
        assert!(is_pruned(&root));
        assert!(!is_cut_short_beyond_pruning(&root));
    }
}
