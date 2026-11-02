use super::*;
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::test_support::{number, text};
use crate::tree::walk::walker_fake::{FakeTree, budget, ref_entry};

const SCROLL_BAR: i32 = 50014;
const THUMB: i32 = 50027;
const TREE_ITEM: i32 = 50024;
const OUTLINE: i32 = 1;
const COMPUTER: i32 = 20;
const CLASSES_ROOT: i32 = 30;
const CURRENT_USER: i32 = 31;

fn tree_item(tree: FakeTree, node: i32, name: &str) -> FakeTree {
    tree.reading(
        node,
        &[
            number(TreeProperty::ControlType, TREE_ITEM),
            (TreeProperty::Name, text(name)),
        ],
    )
}

fn chrome(tree: FakeTree, node: i32, control_type: i32) -> FakeTree {
    tree.reading(node, &[number(TreeProperty::ControlType, control_type)])
}

/// The regedit outline after `HKEY_CLASSES_ROOT` expanded: two scroll bars and
/// the size grip now lead the outline's children, ahead of `Computer`.
fn grown_outline(second_root_name: &str) -> FakeTree {
    let tree = FakeTree::default()
        .with_children(0, &[OUTLINE])
        .with_children(OUTLINE, &[10, 11, 12, COMPUTER])
        .with_children(COMPUTER, &[CLASSES_ROOT, CURRENT_USER]);
    let tree = chrome(tree, 10, SCROLL_BAR);
    let tree = chrome(tree, 11, SCROLL_BAR);
    let tree = chrome(tree, 12, THUMB);
    let tree = tree_item(tree, COMPUTER, "Computer");
    let tree = tree_item(tree, CLASSES_ROOT, "HKEY_CLASSES_ROOT");
    tree_item(tree, CURRENT_USER, second_root_name)
}

/// The ref the snapshot stored before the expand: `[outline, Computer,
/// HKEY_CLASSES_ROOT]` with the outline's content counted from index 0, and a
/// bounds hash the scrolled view no longer reproduces.
fn classes_root_entry() -> RefEntry {
    let mut entry = ref_entry("treeitem");
    entry.identity.name = Some("HKEY_CLASSES_ROOT".into());
    entry.geometry.bounds_hash = Some(7);
    entry.scope.path = vec![0, 0, 0].into();
    entry
}

#[test]
fn a_path_recorded_before_scroll_bars_appeared_lands_past_them() {
    let tree = grown_outline("HKEY_CURRENT_USER");

    let repaired = repair_past_leading_chrome(&tree, &0, &classes_root_entry(), &budget(10));

    assert_eq!(
        repaired,
        Some(CLASSES_ROOT),
        "the stored index counts from the first content child, so the repair must step past \
         the two scroll bars and the size grip and land on the stored key"
    );
}

#[test]
fn a_path_with_no_leading_chrome_is_left_to_the_other_tiers() {
    let tree = FakeTree::default()
        .with_children(0, &[OUTLINE])
        .with_children(OUTLINE, &[COMPUTER])
        .with_children(COMPUTER, &[CLASSES_ROOT, CURRENT_USER]);
    let tree = tree_item(tree, COMPUTER, "Computer");
    let tree = tree_item(tree, CLASSES_ROOT, "HKEY_CLASSES_ROOT");
    let tree = tree_item(tree, CURRENT_USER, "HKEY_CURRENT_USER");

    let repaired = repair_past_leading_chrome(&tree, &0, &classes_root_entry(), &budget(10));

    assert_eq!(
        repaired, None,
        "with no chrome to explain a drift, a landing the plain path tier declined must not be \
         re-accepted here without its bounds check"
    );
}

#[test]
fn a_duplicate_sibling_identity_declines_the_repaired_landing() {
    let tree = grown_outline("HKEY_CLASSES_ROOT");

    let repaired = repair_past_leading_chrome(&tree, &0, &classes_root_entry(), &budget(10));

    assert_eq!(
        repaired, None,
        "the repair ignores the stale bounds, so a second sibling answering to the same \
         identity must leave the tie-break to the broad search"
    );
}

/// A path recorded while the scroll bars already existed counts them, so its
/// index lands on content and must not be shifted a second time into a
/// neighbouring parent that holds a child with the same identity.
#[test]
fn a_path_that_already_counts_the_chrome_is_not_shifted_into_a_neighbour() {
    const OTHER: i32 = 21;
    const IMPOSTOR: i32 = 40;
    let tree = grown_outline("HKEY_CURRENT_USER")
        .with_children(OUTLINE, &[10, 11, 12, COMPUTER, 13, 14, OTHER])
        .with_children(OTHER, &[IMPOSTOR]);
    let tree = tree_item(tree, 13, "Spacer A");
    let tree = tree_item(tree, 14, "Spacer B");
    let tree = tree_item(tree, OTHER, "Other");
    let tree = tree_item(tree, IMPOSTOR, "HKEY_CLASSES_ROOT");
    let mut entry = classes_root_entry();
    entry.scope.path = vec![0, 3, 0].into();

    let repaired = repair_past_leading_chrome(&tree, &0, &entry, &budget(10));

    assert_eq!(
        repaired, None,
        "index 3 already lands on Computer past the chrome; adding the chrome again reaches \
         the neighbour's same-named child, which must never answer for the ref"
    );
}

#[test]
fn a_content_index_is_never_shifted_into_another_container() {
    const A: i32 = 13;
    const B: i32 = 14;
    const C: i32 = 15;
    const D: i32 = 16;
    const WRONG: i32 = 50;
    const WANTED: i32 = 51;
    let tree = grown_outline("HKEY_CURRENT_USER")
        .with_children(OUTLINE, &[10, 11, 12, A, B, C, D])
        .with_children(A, &[WRONG])
        .with_children(D, &[WANTED]);
    let tree = [(A, "A"), (B, "B"), (C, "C"), (D, "D"), (WRONG, "Unrelated")]
        .into_iter()
        .fold(tree, |tree, (node, name)| tree_item(tree, node, name));
    let tree = tree_item(tree, WANTED, "HKEY_CLASSES_ROOT");
    let mut entry = classes_root_entry();
    entry.scope.path = vec![0, 3, 0].into();

    let repaired = repair_past_leading_chrome(&tree, &0, &entry, &budget(10));

    assert_eq!(
        repaired, None,
        "index 3 lands on content, so no level may shift it into D's same-named child"
    );
}

#[test]
fn an_ambiguous_deeper_level_declines_even_after_an_earlier_shift() {
    const P: i32 = 63;
    const Q: i32 = 64;
    const R: i32 = 65;
    const S: i32 = 66;
    const IMPOSTOR: i32 = 70;
    let tree = grown_outline("HKEY_CURRENT_USER")
        .with_children(COMPUTER, &[60, 61, 62, P, Q, R, S])
        .with_children(P, &[IMPOSTOR]);
    let tree = chrome(tree, 60, SCROLL_BAR);
    let tree = chrome(tree, 61, SCROLL_BAR);
    let tree = chrome(tree, 62, THUMB);
    let tree = [(P, "P"), (Q, "Q"), (R, "R"), (S, "S")]
        .into_iter()
        .fold(tree, |tree, (node, name)| tree_item(tree, node, name));
    let tree = tree_item(tree, IMPOSTOR, "HKEY_CLASSES_ROOT");
    let mut entry = classes_root_entry();
    entry.scope.path = vec![0, 0, 3, 0].into();

    let repaired = repair_past_leading_chrome(&tree, &0, &entry, &budget(10));

    assert_eq!(
        repaired, None,
        "Computer's index 3 lands on content beside chrome, so it is ambiguous and the \
         earlier shift must not carry the repair into P's same-named child"
    );
}
