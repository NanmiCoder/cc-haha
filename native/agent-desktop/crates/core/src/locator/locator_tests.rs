use super::*;
use crate::{AccessibilityNode, tree::search_text, tree::state};

fn node(
    role: &str,
    name: Option<&str>,
    value: Option<&str>,
    states: Vec<&str>,
) -> AccessibilityNode {
    AccessibilityNode {
        ref_id: None,
        role: role.into(),
        identity: crate::NodeIdentity {
            retained_object: None,
            name: name.map(String::from),
            value: value.map(String::from),
            ..Default::default()
        },
        presentation: crate::NodePresentation {
            states: states.into_iter().map(String::from).collect(),
            ..Default::default()
        },
        children_count: None,
        subtree_truncated: false,
        children: vec![],
    }
}

#[test]
fn role_and_name_substring_match() {
    let query = LocatorQuery {
        identity: IdentityPredicate {
            role: Some("button".into()),
            name: Some(search_text::normalize("save")),
            ..IdentityPredicate::default()
        },
        ..LocatorQuery::default()
    };
    let target = node("button", Some("Save Changes"), None, vec![]);
    assert!(accessibility_node_matches(&target, &query));
}

#[test]
fn exact_name_requires_equality() {
    let query = LocatorQuery {
        identity: IdentityPredicate {
            name: Some(search_text::normalize("save")),
            ..IdentityPredicate::default()
        },
        exact: true,
        ..LocatorQuery::default()
    };
    assert!(!accessibility_node_matches(
        &node("button", Some("Save Changes"), None, vec![]),
        &query
    ));
    assert!(accessibility_node_matches(
        &node("button", Some("Save"), None, vec![]),
        &query
    ));
}

#[test]
fn state_predicate_filters_checked() {
    let query = LocatorQuery {
        states: vec![StatePredicate {
            token: state::CHECKED.into(),
            expected: Some(true),
        }],
        ..LocatorQuery::default()
    };
    assert!(accessibility_node_matches(
        &node("checkbox", None, None, vec![state::CHECKED]),
        &query
    ));
    assert!(!accessibility_node_matches(
        &node("checkbox", None, None, vec![]),
        &query
    ));
}

#[test]
fn native_id_exact_match() {
    let mut target = node("button", Some("X"), None, vec![]);
    target.identity.native_id = Some(crate::ElementIdentifier {
        kind: crate::IdentifierKind::AxIdentifier,
        value: "submit-btn".into(),
    });
    let query = LocatorQuery {
        identity: IdentityPredicate {
            native_id: Some("submit-btn".into()),
            ..IdentityPredicate::default()
        },
        ..LocatorQuery::default()
    };
    assert!(accessibility_node_matches(&target, &query));
}

#[test]
fn has_subquery_matches_descendant() {
    let mut root = node("group", None, None, vec![]);
    root.children
        .push(node("statictext", Some("Hello"), None, vec![]));
    let query = LocatorQuery {
        containment: ContainmentPredicate {
            has: Some(Box::new(LocatorQuery {
                has_text: Some(search_text::normalize("hello")),
                ..LocatorQuery::default()
            })),
            ..ContainmentPredicate::default()
        },
        ..LocatorQuery::default()
    };
    assert!(accessibility_node_matches(&root, &query));
}

#[test]
fn has_subquery_matches_deep_descendant() {
    let mut root = node("group", None, None, vec![]);
    let mut wrapper = node("group", None, None, vec![]);
    wrapper
        .children
        .push(node("statictext", Some("Hello"), None, vec![]));
    root.children.push(wrapper);
    let query = LocatorQuery {
        containment: ContainmentPredicate {
            has: Some(Box::new(LocatorQuery {
                has_text: Some(search_text::normalize("hello")),
                ..LocatorQuery::default()
            })),
            ..ContainmentPredicate::default()
        },
        ..LocatorQuery::default()
    };
    assert!(accessibility_node_matches(&root, &query));
}

#[test]
fn has_text_matches_deep_descendant_text() {
    let mut root = node("group", Some("Settings"), None, vec![]);
    let mut wrapper = node("group", None, None, vec![]);
    wrapper.children.push(node(
        "statictext",
        Some("Workspace notifications"),
        None,
        vec![],
    ));
    root.children.push(wrapper);
    let query = LocatorQuery {
        has_text: Some(search_text::normalize("notifications")),
        ..LocatorQuery::default()
    };
    assert!(accessibility_node_matches(&root, &query));
}

#[test]
fn invalid_state_token_rejected() {
    let query = LocatorQuery {
        states: vec![StatePredicate {
            token: "bogus".into(),
            expected: None,
        }],
        ..LocatorQuery::default()
    };
    assert!(query.validate_states().is_err());
}

#[test]
fn has_not_excludes_subtree_match() {
    let mut root = node("group", None, None, vec![]);
    root.children
        .push(node("button", Some("Delete"), None, vec![]));
    let query = LocatorQuery {
        identity: IdentityPredicate {
            role: Some("group".into()),
            ..IdentityPredicate::default()
        },
        containment: ContainmentPredicate {
            has_not: Some(Box::new(LocatorQuery {
                identity: IdentityPredicate {
                    role: Some("button".into()),
                    name: Some(search_text::normalize("delete")),
                    ..IdentityPredicate::default()
                },
                ..LocatorQuery::default()
            })),
            ..ContainmentPredicate::default()
        },
        ..LocatorQuery::default()
    };
    assert!(!accessibility_node_matches(&root, &query));
}

#[test]
fn has_not_excludes_deep_subtree_match() {
    let mut root = node("group", None, None, vec![]);
    let mut wrapper = node("group", None, None, vec![]);
    wrapper
        .children
        .push(node("button", Some("Delete"), None, vec![]));
    root.children.push(wrapper);
    let query = LocatorQuery {
        identity: IdentityPredicate {
            role: Some("group".into()),
            ..IdentityPredicate::default()
        },
        containment: ContainmentPredicate {
            has_not: Some(Box::new(LocatorQuery {
                identity: IdentityPredicate {
                    role: Some("button".into()),
                    name: Some(search_text::normalize("delete")),
                    ..IdentityPredicate::default()
                },
                ..LocatorQuery::default()
            })),
            ..ContainmentPredicate::default()
        },
        ..LocatorQuery::default()
    };
    assert!(!accessibility_node_matches(&root, &query));
}

/// The `IdentityPredicate`/`ContainmentPredicate` split (god-object fix) must
/// stay wire-compatible: JSON consumers still see a single flat object, not
/// `{"identity": {...}}`. Reverting the `#[serde(flatten)]` attributes (e.g.
/// accidentally serializing the grouped sub-structs as nested objects) would
/// fail this assertion.
#[test]
fn identity_and_containment_fields_serialize_flat_not_nested() {
    let query = LocatorQuery {
        identity: IdentityPredicate {
            role: Some("button".into()),
            ..IdentityPredicate::default()
        },
        containment: ContainmentPredicate {
            has: Some(Box::new(LocatorQuery {
                identity: IdentityPredicate {
                    role: Some("statictext".into()),
                    ..IdentityPredicate::default()
                },
                ..LocatorQuery::default()
            })),
            ..ContainmentPredicate::default()
        },
        ..LocatorQuery::default()
    };

    let json = serde_json::to_value(&query).unwrap();

    assert_eq!(json["role"], "button");
    assert!(json.get("identity").is_none());
    assert!(json.get("containment").is_none());
    assert_eq!(json["has"]["role"], "statictext");
}

/// Round-trips a flat JSON payload (the shape any pre-existing caller sends)
/// back through the new nested Rust representation.
#[test]
fn flat_json_deserializes_into_nested_identity_and_containment() {
    let query: LocatorQuery = serde_json::from_value(serde_json::json!({
        "role": "button",
        "native_id": "submit-btn",
        "has_not": { "role": "textfield" }
    }))
    .unwrap();

    assert_eq!(query.identity.role.as_deref(), Some("button"));
    assert_eq!(query.identity.native_id.as_deref(), Some("submit-btn"));
    assert_eq!(
        query
            .containment
            .has_not
            .as_ref()
            .and_then(|q| q.identity.role.as_deref()),
        Some("textfield")
    );
}
