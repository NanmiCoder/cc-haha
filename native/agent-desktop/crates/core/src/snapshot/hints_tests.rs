use super::*;

fn node(role: &str, children: Vec<AccessibilityNode>) -> AccessibilityNode {
    AccessibilityNode {
        ref_id: None,
        role: role.into(),
        identity: Default::default(),
        presentation: Default::default(),
        children_count: None,
        subtree_truncated: false,
        children,
    }
}

fn pane_hints(splitter: &AccessibilityNode) -> Vec<Option<&str>> {
    splitter
        .children
        .iter()
        .map(|child| child.presentation.hint.as_deref())
        .collect()
}

#[test]
fn complete_splitter_hints_carry_the_column_total() {
    let mut splitter = node(
        "splitter",
        vec![node("group", vec![]), node("group", vec![])],
    );

    add_structural_hints(&mut splitter);

    assert_eq!(
        pane_hints(&splitter),
        vec![Some("column 1 of 2"), Some("column 2 of 2")]
    );
}

#[test]
fn truncated_splitter_hints_omit_the_unverified_total() {
    let mut splitter = node(
        "splitter",
        vec![node("group", vec![]), node("group", vec![])],
    );
    splitter.subtree_truncated = true;

    add_structural_hints(&mut splitter);

    assert_eq!(
        pane_hints(&splitter),
        vec![Some("column 1"), Some("column 2")]
    );
}
