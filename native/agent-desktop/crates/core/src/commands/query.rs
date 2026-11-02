use crate::{
    AccessibilityNode, AppError, IdentityPredicate, LocatorQuery, accessibility_node_matches,
    tree::search_text,
};

pub fn validate_selector(raw: &str) -> Result<LocatorQuery, AppError> {
    let query = parse_selector(raw);
    if query.is_empty() {
        return Err(AppError::invalid_input_with_suggestion(
            "Selector must constrain at least role or text",
            "Use forms like \"button:Submit\", \"button\", or \":Saved!\".",
        ));
    }
    Ok(query)
}

pub fn parse_selector(raw: &str) -> LocatorQuery {
    let (role_part, text_part) = match raw.split_once(':') {
        Some((left, right)) => (Some(left.trim()), Some(right.trim())),
        None => (Some(raw.trim()), None),
    };

    let role = role_part
        .filter(|part| !part.is_empty())
        .map(str::to_string);
    let has_text = text_part
        .filter(|part| !part.is_empty())
        .map(search_text::normalize);

    LocatorQuery {
        identity: IdentityPredicate {
            role,
            ..IdentityPredicate::default()
        },
        has_text,
        ..LocatorQuery::default()
    }
}

pub fn node_matches(node: &AccessibilityNode, query: &LocatorQuery) -> bool {
    accessibility_node_matches(node, query)
}

pub fn tree_has_match(tree: &AccessibilityNode, query: &LocatorQuery) -> bool {
    if node_matches(tree, query) {
        return true;
    }
    tree.children
        .iter()
        .any(|child| tree_has_match(child, query))
}

#[cfg(test)]
#[path = "query_tests.rs"]
mod tests;
