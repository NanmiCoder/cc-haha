use super::*;
use crate::AccessibilityNode;

fn node(name: Option<&str>, value: Option<&str>, description: Option<&str>) -> AccessibilityNode {
    AccessibilityNode {
        ref_id: None,
        role: "textfield".into(),
        identity: crate::NodeIdentity {
            retained_object: None,
            name: name.map(String::from),
            value: value.map(String::from),
            description: description.map(String::from),
            native_id: None,
        },
        presentation: Default::default(),
        children_count: None,
        subtree_truncated: false,
        children: vec![],
    }
}

#[test]
fn contains_uses_ascii_fast_path_case_insensitively() {
    assert!(contains("Save As", &normalize("save")));
    assert!(contains("Save As", &normalize("AS")));
    assert!(!contains("Save As", &normalize("open")));
}

#[test]
fn contains_handles_non_ascii_text() {
    assert!(contains("Résumé", &normalize("rés")));
    assert_eq!(
        normalize("  SAVE\tAs\n \u{200e}İ\u{a0}Σ  "),
        "save as i\u{307} σ"
    );
}

#[test]
fn matching_ignores_bidirectional_formatting_controls() {
    assert_eq!(normalize("\u{200e}WhatsApp"), normalize("WhatsApp"));
    assert_eq!(normalize("\u{2067}Search\u{2069}"), normalize("Search"));
}

#[test]
fn contains_empty_needle_is_true_not_panic() {
    assert!(contains("anything", ""));
    assert!(contains("", ""));
}

#[test]
fn node_contains_searches_name_value_and_description() {
    assert!(node_contains(
        &node(None, None, Some("Secondary text")),
        &normalize("secondary")
    ));
    assert!(node_contains(
        &node(None, Some("Current value"), None),
        &normalize("value")
    ));
    assert!(!node_contains(
        &node(Some("Primary"), None, None),
        &normalize("missing")
    ));
}
