use crate::{AccessibilityNode, tree::search_text};

pub(crate) struct TextMatch {
    pub ref_id: Option<String>,
    pub role: String,
}

pub(crate) fn find(
    node: &AccessibilityNode,
    text_lower: &str,
    expected_count: Option<usize>,
) -> Vec<TextMatch> {
    let mut matches = Vec::new();
    collect(node, text_lower, match_limit(expected_count), &mut matches);
    matches
}

fn match_limit(expected_count: Option<usize>) -> usize {
    expected_count
        .map(|expected| expected.saturating_add(1))
        .unwrap_or(1)
}

fn collect(node: &AccessibilityNode, text_lower: &str, limit: usize, matches: &mut Vec<TextMatch>) {
    if matches.len() >= limit {
        return;
    }
    if search_text::node_contains(node, text_lower) {
        matches.push(TextMatch {
            ref_id: node.ref_id.clone(),
            role: node.role.clone(),
        });
    }

    for child in &node.children {
        collect(child, text_lower, limit, matches);
        if matches.len() >= limit {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(name: &str, children: Vec<AccessibilityNode>) -> AccessibilityNode {
        AccessibilityNode {
            ref_id: None,
            role: "group".into(),
            identity: crate::NodeIdentity {
                retained_object: None,
                name: Some(name.into()),
                ..Default::default()
            },
            presentation: Default::default(),
            children_count: None,
            subtree_truncated: false,
            children,
        }
    }

    #[test]
    fn default_wait_text_stops_after_first_match() {
        let tree = node(
            "root",
            vec![
                node("ready one", vec![]),
                node("ready two", vec![]),
                node("ready three", vec![]),
            ],
        );

        let matches = find(&tree, "ready", None);

        assert_eq!(matches.len(), 1);
    }

    #[test]
    fn count_wait_text_collects_one_past_expected() {
        let tree = node(
            "root",
            vec![
                node("ready one", vec![]),
                node("ready two", vec![]),
                node("ready three", vec![]),
            ],
        );

        let matches = find(&tree, "ready", Some(2));

        assert_eq!(matches.len(), 3);
    }
}
