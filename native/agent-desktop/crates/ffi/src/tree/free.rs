use crate::convert::string::free_c_string;
use crate::types::{AdNode, AdNodeTree};
use std::os::raw::c_char;
use std::ptr;

unsafe fn free_c_string_array(arr: *mut *mut c_char) {
    unsafe {
        let Some(len) = crate::resource::take_allocation(
            crate::resource::AllocationKind::TreeStateStrings,
            arr,
        ) else {
            return;
        };
        for index in 0..len {
            free_c_string(*arr.add(index));
        }
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(arr, len)));
    }
}

unsafe fn free_node_fields(node: &mut AdNode) {
    unsafe {
        free_c_string(node.content.ref_id as *mut c_char);
        free_c_string(node.content.role as *mut c_char);
        free_c_string(node.content.name as *mut c_char);
        free_c_string(node.content.value as *mut c_char);
        free_c_string(node.content.description as *mut c_char);
        free_c_string(node.content.hint as *mut c_char);
        free_c_string_array(node.presentation.states);
        node.content.ref_id = ptr::null();
        node.content.role = ptr::null();
        node.content.name = ptr::null();
        node.content.value = ptr::null();
        node.content.description = ptr::null();
        node.content.hint = ptr::null();
        node.presentation.states = ptr::null_mut();
        node.presentation.state_count = 0;
    }
}

/// # Safety
/// `tree` must be null or point to a valid `AdNodeTree` previously returned
/// by `flatten_tree` or `ad_get_tree_exact`. After this call the tree is zeroed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_free_tree(tree: *mut AdNodeTree) {
    crate::ffi_try::trap_panic_void(|| unsafe {
        if tree.is_null() {
            return;
        }
        let tree = &mut *tree;
        if tree.nodes.is_null() {
            return;
        }
        let Some(node_count) = crate::resource::take_allocation(
            crate::resource::AllocationKind::TreeNodes,
            tree.nodes,
        ) else {
            tree.nodes = ptr::null_mut();
            tree.count = 0;
            return;
        };
        let nodes = std::slice::from_raw_parts_mut(tree.nodes, node_count);
        for node in nodes.iter_mut() {
            free_node_fields(node);
        }
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            tree.nodes, node_count,
        )));
        tree.nodes = ptr::null_mut();
        tree.count = 0;
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AdNodeContent, AdNodePresentation, AdNodeRelation};

    #[test]
    fn test_free_null_tree_is_noop() {
        unsafe { ad_free_tree(std::ptr::null_mut()) };
    }

    #[test]
    fn free_tree_ignores_mutated_node_state_count() {
        let mut tree = tree_with_node(node_with_states(&["focused"], u32::MAX));
        unsafe { ad_free_tree(&mut tree) };

        assert!(tree.nodes.is_null());
    }

    fn tree_with_node(node: AdNode) -> AdNodeTree {
        let mut nodes = vec![node].into_boxed_slice();
        let raw = nodes.as_mut_ptr();
        crate::resource::register_allocation(
            crate::resource::AllocationKind::TreeNodes,
            raw,
            nodes.len(),
        );
        std::mem::forget(nodes);
        AdNodeTree {
            nodes: raw,
            count: 1,
        }
    }

    fn node_with_states(states: &[&str], state_count: u32) -> AdNode {
        AdNode {
            content: AdNodeContent {
                ref_id: ptr::null(),
                role: crate::convert::string::string_to_c_lossy("button"),
                name: ptr::null(),
                value: ptr::null(),
                description: ptr::null(),
                hint: ptr::null(),
            },
            presentation: AdNodePresentation {
                states: state_array(states),
                bounds: crate::types::AdRect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 0.0,
                },
                state_count,
                has_bounds: false,
            },
            relation: AdNodeRelation {
                parent_index: -1,
                child_start: 0,
                child_count: 0,
            },
        }
    }

    fn state_array(states: &[&str]) -> *mut *mut c_char {
        let ptrs: Vec<*mut c_char> = states
            .iter()
            .map(|state| crate::convert::string::string_to_c_lossy(state))
            .collect();
        let len = ptrs.len();
        let mut boxed = ptrs.into_boxed_slice();
        let raw = boxed.as_mut_ptr();
        std::mem::forget(boxed);
        crate::resource::register_allocation(
            crate::resource::AllocationKind::TreeStateStrings,
            raw,
            len,
        );
        raw
    }

    #[test]
    fn free_tree_ignores_mutated_tree_count() {
        let root = agent_desktop_core::AccessibilityNode {
            ref_id: None,
            role: "button".into(),
            identity: agent_desktop_core::NodeIdentity::default(),
            presentation: agent_desktop_core::NodePresentation::default(),
            children: vec![],
            children_count: None,
            subtree_truncated: false,
        };
        let mut tree = crate::tree::flatten::flatten_tree(&root).unwrap();
        tree.count = u32::MAX;
        unsafe { ad_free_tree(&mut tree) };

        assert!(tree.nodes.is_null());
        assert_eq!(tree.count, 0);
    }
}
