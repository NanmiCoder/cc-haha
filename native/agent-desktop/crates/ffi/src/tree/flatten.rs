use crate::convert::string::{opt_string_to_c, string_to_c_lossy};
use crate::types::{AdNode, AdNodeContent, AdNodePresentation, AdNodeRelation, AdNodeTree, AdRect};
use agent_desktop_core::AccessibilityNode;
use std::collections::VecDeque;
use std::os::raw::c_char;
use std::ptr;

/// Flattens an `AccessibilityNode` tree into the BFS-ordered layout
/// C consumers see via `AdNodeTree.nodes`.
///
/// Guarantees:
/// - Direct children of any `AdNode` at index `i` live contiguously at
///   `nodes[n.child_start .. n.child_start + n.child_count]`. This is
///   the BFS (level-order) layout.
/// - `parent_index` is `-1` for the root and otherwise a valid back-index
///   into `nodes`.
/// - `child_count` is zero when `child_start` is not indexable.
///
/// A recursive DFS layout placed node `a1` immediately after its parent
/// `a`, overlapping with `a`'s siblings — the range
/// `a.child_start..a.child_start + a.child_count` therefore stepped into
/// grandchildren. BFS keeps siblings contiguous by construction.
pub(crate) fn flatten_tree(
    root: &AccessibilityNode,
) -> Result<AdNodeTree, agent_desktop_core::AdapterError> {
    let total = count_nodes_bounded(root, crate::resource::MAX_FFI_LIST_ITEMS)?;
    let mut flat: Vec<AdNode> = Vec::with_capacity(total);

    flat.push(to_ad_node(root, -1));
    let mut queue: VecDeque<(&AccessibilityNode, usize)> = VecDeque::new();
    queue.push_back((root, 0));

    while let Some((node, node_idx)) = queue.pop_front() {
        if node.children.is_empty() {
            continue;
        }
        let child_start = flat.len() as u32;
        let child_count = node.children.len() as u32;
        flat[node_idx].relation.child_start = child_start;
        flat[node_idx].relation.child_count = child_count;
        for child in &node.children {
            let child_idx = flat.len();
            flat.push(to_ad_node(child, node_idx as i32));
            queue.push_back((child, child_idx));
        }
    }

    let count = flat.len() as u32;
    let nodes = if flat.is_empty() {
        ptr::null_mut()
    } else {
        let mut boxed = flat.into_boxed_slice();
        let ptr = boxed.as_mut_ptr();
        std::mem::forget(boxed);
        crate::resource::register_allocation(
            crate::resource::AllocationKind::TreeNodes,
            ptr,
            count as usize,
        );
        ptr
    };
    Ok(AdNodeTree { nodes, count })
}

fn count_nodes_bounded(
    node: &AccessibilityNode,
    limit: usize,
) -> Result<usize, agent_desktop_core::AdapterError> {
    let mut total: usize = 0;
    let mut queue: VecDeque<&AccessibilityNode> = VecDeque::new();
    queue.push_back(node);
    while let Some(n) = queue.pop_front() {
        total = total.saturating_add(1);
        crate::resource::validate_list_len(total, "Accessibility tree")?;
        if total > limit {
            return Err(agent_desktop_core::AdapterError::new(
                agent_desktop_core::ErrorCode::Internal,
                "Accessibility tree exceeds the FFI output item limit",
            ));
        }
        for c in &n.children {
            queue.push_back(c);
        }
    }
    Ok(total)
}

fn to_ad_node(node: &AccessibilityNode, parent_index: i32) -> AdNode {
    let (states_ptr, state_count) = strings_to_c_array(&node.presentation.states);
    let (bounds, has_bounds) = match &node.presentation.bounds {
        Some(r) => (crate::convert::rect_to_c(r), true),
        None => (
            AdRect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
            false,
        ),
    };
    AdNode {
        content: AdNodeContent {
            ref_id: opt_string_to_c(node.ref_id.as_deref()),
            role: string_to_c_lossy(&node.role),
            name: opt_string_to_c(node.identity.name.as_deref()),
            value: opt_string_to_c(node.identity.value.as_deref()),
            description: opt_string_to_c(node.identity.description.as_deref()),
            hint: opt_string_to_c(node.presentation.hint.as_deref()),
        },
        presentation: AdNodePresentation {
            states: states_ptr,
            bounds,
            state_count,
            has_bounds,
        },
        relation: AdNodeRelation {
            parent_index,
            child_start: 0,
            child_count: 0,
        },
    }
}

fn strings_to_c_array(strings: &[String]) -> (*mut *mut c_char, u32) {
    if strings.is_empty() {
        return (ptr::null_mut(), 0);
    }
    let ptrs: Vec<*mut c_char> = strings.iter().map(|s| string_to_c_lossy(s)).collect();
    let count = ptrs.len() as u32;
    let mut boxed = ptrs.into_boxed_slice();
    let ptr = boxed.as_mut_ptr();
    std::mem::forget(boxed);
    crate::resource::register_allocation(
        crate::resource::AllocationKind::TreeStateStrings,
        ptr,
        count as usize,
    );
    (ptr, count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::string::c_to_string;
    use crate::tree::free::ad_free_tree;

    fn node(role: &str) -> AccessibilityNode {
        AccessibilityNode {
            ref_id: None,
            role: role.into(),
            identity: agent_desktop_core::NodeIdentity::default(),
            presentation: agent_desktop_core::NodePresentation::default(),
            children: vec![],
            children_count: None,
            subtree_truncated: false,
        }
    }

    fn direct_children(nodes: &[AdNode], idx: usize) -> Vec<&AdNode> {
        let n = &nodes[idx];
        let start = n.relation.child_start as usize;
        let end = start + n.relation.child_count as usize;
        nodes[start..end].iter().collect()
    }

    #[test]
    fn test_flatten_single_node() {
        let root = node("window");
        let tree = flatten_tree(&root).unwrap();
        assert_eq!(tree.count, 1);
        let nodes = unsafe { std::slice::from_raw_parts(tree.nodes, 1) };
        assert_eq!(nodes[0].relation.parent_index, -1);
        assert_eq!(nodes[0].relation.child_count, 0);
        let role = unsafe { c_to_string(nodes[0].content.role) };
        assert_eq!(role.as_deref(), Some("window"));
        unsafe { ad_free_tree(&tree as *const _ as *mut _) };
    }

    #[test]
    fn test_flatten_parent_child() {
        let btn = node("button");
        let mut root = node("window");
        root.children = vec![btn];

        let tree = flatten_tree(&root).unwrap();
        assert_eq!(tree.count, 2);
        let nodes = unsafe { std::slice::from_raw_parts(tree.nodes, 2) };

        assert_eq!(nodes[0].relation.parent_index, -1);
        assert_eq!(nodes[0].relation.child_start, 1);
        assert_eq!(nodes[0].relation.child_count, 1);

        assert_eq!(nodes[1].relation.parent_index, 0);
        assert_eq!(nodes[1].relation.child_count, 0);
        let role = unsafe { c_to_string(nodes[1].content.role) };
        assert_eq!(role.as_deref(), Some("button"));

        unsafe { ad_free_tree(&tree as *const _ as *mut _) };
    }

    #[test]
    fn test_flatten_breadth_first_layout() {
        let a1 = node("a1");
        let a2 = node("a2");
        let mut a = node("a");
        a.children = vec![a1, a2];
        let b = node("b");
        let mut root = node("root");
        root.children = vec![a, b];

        let tree = flatten_tree(&root).unwrap();
        assert_eq!(tree.count, 5);
        let nodes = unsafe { std::slice::from_raw_parts(tree.nodes, 5) };

        let roles: Vec<String> = nodes
            .iter()
            .map(|n| unsafe { c_to_string(n.content.role).unwrap() })
            .collect();
        assert_eq!(roles, vec!["root", "a", "b", "a1", "a2"]);

        let root_children: Vec<String> = direct_children(nodes, 0)
            .iter()
            .map(|n| unsafe { c_to_string(n.content.role).unwrap() })
            .collect();
        assert_eq!(root_children, vec!["a", "b"]);

        let a_idx = nodes
            .iter()
            .position(|n| unsafe { c_to_string(n.content.role).unwrap() } == "a")
            .unwrap();
        let a_children: Vec<String> = direct_children(nodes, a_idx)
            .iter()
            .map(|n| unsafe { c_to_string(n.content.role).unwrap() })
            .collect();
        assert_eq!(a_children, vec!["a1", "a2"]);

        let b_idx = nodes
            .iter()
            .position(|n| unsafe { c_to_string(n.content.role).unwrap() } == "b")
            .unwrap();
        assert!(direct_children(nodes, b_idx).is_empty());

        unsafe { ad_free_tree(&tree as *const _ as *mut _) };
    }

    #[test]
    fn test_flatten_deep_chain() {
        let mut leaf = node("l10");
        for i in (0..10).rev() {
            let mut parent = node(&format!("l{}", i));
            parent.children = vec![leaf];
            leaf = parent;
        }
        let tree = flatten_tree(&leaf).unwrap();
        assert_eq!(tree.count, 11);
        let nodes = unsafe { std::slice::from_raw_parts(tree.nodes, 11) };

        let mut cursor = 0usize;
        for expected in 0..11 {
            let role = unsafe { c_to_string(nodes[cursor].content.role).unwrap() };
            assert_eq!(role, format!("l{}", expected));
            let children = direct_children(nodes, cursor);
            if expected < 10 {
                assert_eq!(children.len(), 1);
                cursor = nodes[cursor].relation.child_start as usize;
            } else {
                assert!(children.is_empty());
            }
        }
        unsafe { ad_free_tree(&tree as *const _ as *mut _) };
    }

    #[test]
    fn test_flatten_wide_root() {
        let mut root = node("root");
        for i in 0..100 {
            root.children.push(node(&format!("child_{}", i)));
        }
        let tree = flatten_tree(&root).unwrap();
        assert_eq!(tree.count, 101);
        let nodes = unsafe { std::slice::from_raw_parts(tree.nodes, 101) };
        let children = direct_children(nodes, 0);
        assert_eq!(children.len(), 100);
        for (i, c) in children.iter().enumerate() {
            let role = unsafe { c_to_string(c.content.role).unwrap() };
            assert_eq!(role, format!("child_{}", i));
        }
        unsafe { ad_free_tree(&tree as *const _ as *mut _) };
    }

    #[test]
    fn node_count_fails_before_flattening_past_the_resource_limit() {
        let mut root = node("root");
        root.children = vec![node("a"), node("b")];

        let error = count_nodes_bounded(&root, 2).unwrap_err();

        assert_eq!(error.code, agent_desktop_core::ErrorCode::Internal);
        assert!(error.message.contains("item limit"));
    }

    #[test]
    fn test_flatten_with_states() {
        let mut btn = node("button");
        btn.presentation.states = vec!["focused".into(), "enabled".into()];
        let tree = flatten_tree(&btn).unwrap();
        let nodes = unsafe { std::slice::from_raw_parts(tree.nodes, 1) };
        assert_eq!(nodes[0].presentation.state_count, 2);
        let states = unsafe { std::slice::from_raw_parts(nodes[0].presentation.states, 2) };
        let s0 = unsafe { c_to_string(states[0]) };
        let s1 = unsafe { c_to_string(states[1]) };
        assert_eq!(s0.as_deref(), Some("focused"));
        assert_eq!(s1.as_deref(), Some("enabled"));
        unsafe { ad_free_tree(&tree as *const _ as *mut _) };
    }
}
