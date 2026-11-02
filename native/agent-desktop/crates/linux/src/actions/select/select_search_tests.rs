use super::*;

struct FakeTree {
    names: Vec<Option<&'static str>>,
    selection: Vec<bool>,
    children: Vec<Vec<usize>>,
    unreadable: Vec<usize>,
}

impl FakeTree {
    fn new(shape: &[(Option<&'static str>, bool, &[usize])]) -> Self {
        Self {
            names: shape.iter().map(|entry| entry.0).collect(),
            selection: shape.iter().map(|entry| entry.1).collect(),
            children: shape.iter().map(|entry| entry.2.to_vec()).collect(),
            unreadable: Vec::new(),
        }
    }
}

impl ItemReader for FakeTree {
    type Node = usize;

    fn inspect(&mut self, node: &usize) -> Result<Inspected, AdapterError> {
        if self.unreadable.contains(node) {
            return Err(AdapterError::internal("gone"));
        }
        Ok(Inspected {
            name: self.names[*node].map(str::to_owned),
            selection: self.selection[*node],
            selectable: self.selection[*node],
        })
    }

    fn children(&mut self, node: &usize) -> Result<Vec<usize>, AdapterError> {
        Ok(self.children[*node].clone())
    }
}

#[test]
fn the_target_matching_itself_is_an_own_hit_with_no_container() {
    let mut tree = FakeTree::new(&[(Some("Dark"), false, &[])]);
    let found = search(&mut tree, &0, "dark").expect("searched");
    assert_eq!(
        found,
        Search::Found(Hit {
            item: 0,
            container: None,
            row: None,
            own: true
        })
    );
}

#[test]
fn a_depth_three_descendant_keeps_its_direct_row_under_the_selection_ancestor() {
    let mut tree = FakeTree::new(&[
        (None, true, &[1, 2]),
        (None, false, &[3]),
        (None, false, &[4]),
        (Some("Red"), false, &[]),
        (None, false, &[5]),
        (Some("Blue"), false, &[]),
    ]);
    let found = search(&mut tree, &0, "Blue").expect("searched");
    assert_eq!(
        found,
        Search::Found(Hit {
            item: 5,
            container: Some(Container { node: 0 }),
            row: Some(2),
            own: false
        })
    );
}

#[test]
fn the_nearest_selection_ancestor_wins_over_a_farther_one() {
    let mut tree = FakeTree::new(&[
        (None, true, &[1]),
        (None, true, &[2, 3]),
        (Some("A"), false, &[]),
        (Some("B"), false, &[]),
    ]);
    let found = search(&mut tree, &0, "B").expect("searched");
    let Search::Found(hit) = found else {
        panic!("expected a hit");
    };
    assert_eq!(hit.container, Some(Container { node: 1 }));
}

#[test]
fn two_equal_matches_are_ambiguous() {
    let mut tree = FakeTree::new(&[
        (None, true, &[1, 2]),
        (Some("Same"), false, &[]),
        (Some("same"), false, &[]),
    ]);
    assert_eq!(
        search(&mut tree, &0, "Same").expect("searched"),
        Search::Ambiguous
    );
}

#[test]
fn a_matched_row_does_not_count_its_matching_label_twice() {
    let mut tree = FakeTree::new(&[
        (None, true, &[1]),
        (Some("Row"), false, &[2]),
        (Some("Row"), false, &[]),
    ]);
    assert!(matches!(
        search(&mut tree, &0, "Row").expect("searched"),
        Search::Found(_)
    ));
}

#[test]
fn no_match_under_a_selection_container_is_selectable() {
    let mut tree = FakeTree::new(&[(None, true, &[1]), (Some("A"), false, &[])]);
    assert_eq!(
        search(&mut tree, &0, "Z").expect("searched"),
        Search::NotFound { selectable: true }
    );
}

#[test]
fn no_match_with_no_selection_anywhere_is_not_selectable() {
    let mut tree = FakeTree::new(&[(Some("combo"), false, &[])]);
    assert_eq!(
        search(&mut tree, &0, "Z").expect("searched"),
        Search::NotFound { selectable: false }
    );
}

#[test]
fn the_search_stops_at_the_node_limit_and_reports_incomplete() {
    let mut shape: Vec<(Option<&'static str>, bool, Vec<usize>)> =
        vec![(None, true, (1..=NODE_LIMIT + 5).collect())];
    shape.extend((0..NODE_LIMIT + 5).map(|_| (None, false, Vec::new())));
    let borrowed: Vec<(Option<&'static str>, bool, &[usize])> = shape
        .iter()
        .map(|(name, selection, kids)| (*name, *selection, kids.as_slice()))
        .collect();
    let mut tree = FakeTree::new(&borrowed);
    assert_eq!(
        search(&mut tree, &0, "Z").expect("searched"),
        Search::Incomplete
    );
}

#[test]
fn the_search_stops_below_the_depth_limit_and_reports_incomplete() {
    let depth = DEPTH_LIMIT + 2;
    let mut shape: Vec<(Option<&'static str>, bool, Vec<usize>)> = Vec::new();
    for level in 0..depth {
        shape.push((None, false, vec![level + 1]));
    }
    shape.push((Some("Deep"), false, Vec::new()));
    let borrowed: Vec<(Option<&'static str>, bool, &[usize])> = shape
        .iter()
        .map(|(name, selection, kids)| (*name, *selection, kids.as_slice()))
        .collect();
    let mut tree = FakeTree::new(&borrowed);
    assert_eq!(
        search(&mut tree, &0, "Deep").expect("searched"),
        Search::Incomplete
    );
}

#[test]
fn an_unreadable_descendant_makes_a_miss_incomplete_not_absent() {
    let mut tree = FakeTree::new(&[(None, true, &[1]), (Some("A"), false, &[])]);
    tree.unreadable.push(1);
    assert_eq!(
        search(&mut tree, &0, "A").expect("searched"),
        Search::Incomplete
    );
}

#[test]
fn a_sole_match_in_an_incomplete_search_never_authorizes_selection() {
    let mut unreadable = FakeTree::new(&[
        (None, true, &[1, 2]),
        (Some("Match"), false, &[]),
        (None, false, &[]),
    ]);
    unreadable.unreadable.push(2);
    let mut deep = FakeTree::new(&[
        (None, true, &[1, 2]),
        (Some("Match"), false, &[]),
        (None, false, &[]),
    ]);
    for level in 2..=DEPTH_LIMIT + 1 {
        deep.children[level] = vec![level + 1];
        deep.names.push(None);
        deep.selection.push(false);
        deep.children.push(Vec::new());
    }
    let mut wide = FakeTree {
        names: vec![None; NODE_LIMIT + 1],
        selection: vec![false; NODE_LIMIT + 1],
        children: vec![Vec::new(); NODE_LIMIT + 1],
        unreadable: Vec::new(),
    };
    wide.selection[0] = true;
    wide.names[1] = Some("Match");
    wide.children[0] = (1..=NODE_LIMIT).collect();
    for mut tree in [unreadable, deep, wide] {
        assert_eq!(
            search(&mut tree, &0, "Match").expect("searched"),
            Search::Incomplete
        );
    }
}

#[test]
fn an_unreadable_root_is_an_error() {
    let mut tree = FakeTree::new(&[(Some("A"), false, &[])]);
    tree.unreadable.push(0);
    assert!(search(&mut tree, &0, "A").is_err());
}

#[test]
fn a_matching_row_is_refused_when_an_unreadable_sibling_can_hide_a_duplicate() {
    let mut tree = FakeTree::new(&[
        (None, true, &[1, 2]),
        (Some("Mouse & Touchpad"), false, &[]),
        (Some("Mouse & Touchpad"), false, &[]),
    ]);
    tree.unreadable.push(2);
    assert_eq!(
        search(&mut tree, &0, "Mouse & Touchpad").unwrap(),
        Search::Incomplete
    );
}

#[test]
fn a_button_with_inner_nodes_and_no_selection_is_not_selectable() {
    let mut tree = FakeTree::new(&[
        (None, false, &[1, 2]),
        (Some("label"), false, &[]),
        (None, false, &[]),
    ]);
    assert_eq!(
        search(&mut tree, &0, "x").expect("searched"),
        Search::NotFound { selectable: false }
    );
}

#[test]
fn the_row_is_the_container_child_on_the_path_not_the_matching_label() {
    let mut tree = FakeTree::new(&[
        (None, true, &[1]),
        (None, false, &[2]),
        (None, false, &[3]),
        (Some("Red"), false, &[]),
    ]);
    let Search::Found(hit) = search(&mut tree, &0, "Red").expect("searched") else {
        panic!("expected a hit");
    };
    assert_eq!(hit.item, 3);
    assert_eq!(hit.row, Some(1));
}
