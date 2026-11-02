use crate::{
    AccessibilityNode, AdapterError, ErrorCode,
    tree::roles,
    tree::search_text,
    tree::state::{self, STATE_VOCABULARY},
};
pub(crate) use crate::{ContainmentPredicate, IdentityPredicate, NodeMatchContext, StatePredicate};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct LocatorQuery {
    #[serde(flatten)]
    pub identity: IdentityPredicate,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_text: Option<String>,
    #[serde(default)]
    pub exact: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub states: Vec<StatePredicate>,
    #[serde(flatten)]
    pub containment: ContainmentPredicate,
}

impl LocatorQuery {
    pub fn is_empty(&self) -> bool {
        self.identity.role.is_none()
            && self.identity.name.is_none()
            && self.identity.description.is_none()
            && self.identity.native_id.is_none()
            && self.identity.value.is_none()
            && self.has_text.is_none()
            && self.states.is_empty()
            && self.containment.has.is_none()
            && self.containment.has_not.is_none()
    }

    pub fn validate_states(&self) -> Result<(), AdapterError> {
        for predicate in &self.states {
            if !STATE_VOCABULARY.contains(&predicate.token.as_str()) {
                return Err(AdapterError::new(
                    ErrorCode::InvalidArgs,
                    format!("Unknown state token '{}'", predicate.token),
                )
                .with_suggestion(format!("Use one of: {}", STATE_VOCABULARY.join(", "))));
            }
        }
        if let Some(has) = &self.containment.has {
            has.validate_states()?;
        }
        if let Some(has_not) = &self.containment.has_not {
            has_not.validate_states()?;
        }
        Ok(())
    }
}

pub fn node_context(node: &AccessibilityNode) -> NodeMatchContext<'_> {
    NodeMatchContext {
        role: &node.role,
        name: node.identity.name.as_deref(),
        description: node.identity.description.as_deref(),
        native_id: node
            .identity
            .native_id
            .as_ref()
            .map(|identifier| identifier.value.as_str()),
        value: node.identity.value.as_deref(),
        states: &node.presentation.states,
        children: &node.children,
    }
}

pub fn node_matches(query: &LocatorQuery, ctx: NodeMatchContext<'_>) -> bool {
    if !role_matches(query, ctx.role) {
        return false;
    }
    if !text_field_matches(query.identity.name.as_deref(), ctx.name, query.exact) {
        return false;
    }
    if !text_field_matches(
        query.identity.description.as_deref(),
        ctx.description,
        query.exact,
    ) {
        return false;
    }
    if !native_id_matches(query.identity.native_id.as_deref(), ctx.native_id) {
        return false;
    }
    if !text_field_matches(query.identity.value.as_deref(), ctx.value, query.exact) {
        return false;
    }
    if !has_text_matches(query.has_text.as_deref(), &ctx, query.exact) {
        return false;
    }
    if !state_predicates_match(&query.states, ctx.states) {
        return false;
    }
    if let Some(has) = &query.containment.has {
        if !subtree_contains(has, ctx.children) {
            return false;
        }
    }
    if let Some(has_not) = &query.containment.has_not {
        if subtree_contains(has_not, ctx.children) {
            return false;
        }
    }
    true
}

pub fn accessibility_node_matches(node: &AccessibilityNode, query: &LocatorQuery) -> bool {
    node_matches(query, node_context(node))
}

/// Cheap standalone role predicate, factored out of [`node_matches`] so
/// callers building a full match context (states, children, name/value
/// text) can short-circuit before paying for that work when the role alone
/// already rules a candidate out.
pub fn role_matches(query: &LocatorQuery, role: &str) -> bool {
    query
        .identity
        .role
        .as_deref()
        .is_none_or(|expected| roles::normalize_role_query(expected) == role)
}

fn text_field_matches(expected: Option<&str>, actual: Option<&str>, exact: bool) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    let Some(actual) = actual else {
        return false;
    };
    text_matches(actual, expected, exact)
}

fn native_id_matches(expected: Option<&str>, actual: Option<&str>) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    actual == Some(expected)
}

fn has_text_matches(expected: Option<&str>, ctx: &NodeMatchContext<'_>, exact: bool) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    [ctx.name, ctx.description, ctx.value]
        .into_iter()
        .flatten()
        .any(|text| text_matches(text, expected, exact))
        || ctx
            .children
            .iter()
            .any(|child| has_text_matches(Some(expected), &node_context(child), exact))
}

fn text_matches(actual: &str, expected: &str, exact: bool) -> bool {
    if exact {
        search_text::normalize(actual) == expected
    } else {
        search_text::contains(actual, expected)
    }
}

fn state_predicates_match(predicates: &[StatePredicate], states: &[String]) -> bool {
    predicates.iter().all(|predicate| {
        let present = state::has_state(states, &predicate.token);
        predicate.expected.unwrap_or(true) == present
    })
}

fn subtree_contains(query: &LocatorQuery, children: &[AccessibilityNode]) -> bool {
    children.iter().any(|child| {
        accessibility_node_matches(child, query) || subtree_contains(query, &child.children)
    })
}

pub(crate) mod containment_predicate;
pub(crate) mod identity_predicate;
pub(crate) mod live_locator;
pub(crate) mod state_predicate;
#[cfg(test)]
#[path = "locator_tests.rs"]
mod tests;
