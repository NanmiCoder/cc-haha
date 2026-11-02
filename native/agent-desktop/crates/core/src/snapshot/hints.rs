use crate::AccessibilityNode;

pub fn add_structural_hints(node: &mut AccessibilityNode) {
    if node.role == "splitter" && node.children.len() > 1 {
        let total = (!node.subtree_truncated).then_some(node.children.len());
        for (i, child) in node.children.iter_mut().enumerate() {
            child.presentation.hint = Some(match total {
                Some(total) => format!("column {} of {}", i + 1, total),
                None => format!("column {}", i + 1),
            });
        }
    }

    for child in &mut node.children {
        add_structural_hints(child);
    }
}

#[cfg(test)]
#[path = "hints_tests.rs"]
mod tests;
