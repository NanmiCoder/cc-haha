use super::{ObservedTree, match_verdict::MatchVerdict};

pub(crate) fn first_is_authoritative(
    tree: &ObservedTree,
    target: usize,
    parents: &[Option<usize>],
    verdicts: &[MatchVerdict],
) -> bool {
    let mut chain = Vec::new();
    let mut current = Some(target);
    while let Some(index) = current {
        chain.push(index);
        current = parents.get(index).copied().flatten();
    }
    chain.reverse();
    let Some(root) = chain.first().copied() else {
        return false;
    };
    if !tree
        .nodes
        .get(root)
        .is_some_and(|node| node.completeness.predecessors_complete)
    {
        return false;
    }
    let Some(root_order) = tree
        .roots
        .iter()
        .position(|candidate| *candidate as usize == root)
    else {
        return false;
    };
    if tree.roots[..root_order]
        .iter()
        .any(|index| !subtree_is_authoritative(tree, *index as usize, verdicts))
    {
        return false;
    }
    for pair in chain.windows(2) {
        let ancestor = pair[0];
        let selected_child = pair[1];
        if verdicts.get(ancestor) == Some(&MatchVerdict::Unknown) {
            return false;
        }
        let Some(node) = tree.nodes.get(ancestor) else {
            return false;
        };
        if !tree
            .nodes
            .get(selected_child)
            .is_some_and(|child| child.completeness.predecessors_complete)
        {
            return false;
        }
        let Some(child_order) = node
            .children
            .iter()
            .position(|child| *child as usize == selected_child)
        else {
            return false;
        };
        if node.children[..child_order]
            .iter()
            .any(|child| !subtree_is_authoritative(tree, *child as usize, verdicts))
        {
            return false;
        }
    }
    verdicts.get(target) == Some(&MatchVerdict::Match)
}

fn subtree_is_authoritative(tree: &ObservedTree, root: usize, verdicts: &[MatchVerdict]) -> bool {
    let Some(node) = tree.nodes.get(root) else {
        return false;
    };
    if !node.completeness.subtree_complete
        || !node.completeness.predecessors_complete
        || verdicts.get(root) == Some(&MatchVerdict::Unknown)
    {
        return false;
    }
    node.children
        .iter()
        .all(|child| subtree_is_authoritative(tree, *child as usize, verdicts))
}
