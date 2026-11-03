use super::*;

#[test]
fn test_rect_null_fields_deserialize() {
    let json = r#"{"x": null, "y": null, "width": 0.0, "height": 0.0}"#;
    let rect: Rect = serde_json::from_str(json).unwrap();
    assert_eq!(rect.x, 0.0);
    assert_eq!(rect.y, 0.0);
}

#[test]
fn test_rect_missing_fields_deserialize() {
    let json = r#"{"width": 100.0, "height": 50.0}"#;
    let rect: Rect = serde_json::from_str(json).unwrap();
    assert_eq!(rect.x, 0.0);
    assert_eq!(rect.y, 0.0);
    assert_eq!(rect.width, 100.0);
}

#[test]
fn test_children_count_omitted_when_none() {
    let node = AccessibilityNode {
        ref_id: None,
        role: "group".into(),
        identity: crate::NodeIdentity {
            name: Some("Sidebar".into()),
            ..Default::default()
        },
        presentation: Default::default(),
        children_count: None,
        subtree_truncated: false,
        children: vec![],
    };
    let json = serde_json::to_string(&node).unwrap();
    assert!(!json.contains("children_count"));
}

#[test]
fn test_children_count_present_when_set() {
    let node = AccessibilityNode {
        ref_id: None,
        role: "group".into(),
        identity: crate::NodeIdentity {
            name: Some("Sidebar".into()),
            ..Default::default()
        },
        presentation: Default::default(),
        children_count: Some(47),
        subtree_truncated: false,
        children: vec![],
    };
    let json = serde_json::to_string(&node).unwrap();
    assert!(json.contains("\"children_count\":47"));
}

#[test]
fn test_children_count_backward_compat() {
    let json = r#"{"role":"button","name":"OK"}"#;
    let node: AccessibilityNode = serde_json::from_str(json).unwrap();
    assert!(node.children_count.is_none());
}

#[test]
fn test_rect_normal_roundtrip() {
    let rect = Rect {
        x: 10.5,
        y: 20.3,
        width: 100.0,
        height: 50.0,
    };
    let json = serde_json::to_string(&rect).unwrap();
    let back: Rect = serde_json::from_str(&json).unwrap();
    assert_eq!(back.x, 10.5);
    assert_eq!(back.width, 100.0);
}

/// AppInfo.bundle_id is annotated skip_serializing_if = "Option::is_none".
/// When absent it must not appear in the JSON — agents must tolerate its
/// absence rather than fail on a missing key.
#[test]
fn app_info_bundle_id_none_omitted_from_json() {
    let info = AppInfo {
        name: "Finder".into(),
        pid: crate::ProcessId::new(42),
        bundle_id: None,
        process_instance: Some("test-instance".into()),
        presentation: None,
    };
    let json = serde_json::to_string(&info).unwrap();
    assert!(
        !json.contains("\"bundle_id\":"),
        "bundle_id must be absent when None, json={json}"
    );
}

/// When bundle_id is Some it must appear in the JSON with the correct value.
#[test]
fn app_info_bundle_id_some_present_in_json() {
    let info = AppInfo {
        name: "Safari".into(),
        pid: crate::ProcessId::new(7),
        bundle_id: Some("com.apple.Safari".into()),
        process_instance: Some("test-instance".into()),
        presentation: None,
    };
    let json = serde_json::to_string(&info).unwrap();
    assert!(
        json.contains("\"bundle_id\":\"com.apple.Safari\""),
        "bundle_id must be present when Some, json={json}"
    );
}

/// AppInfo round-trips through serde with all fields intact.
/// Uses field-by-field comparison because AppInfo does not derive PartialEq.
#[test]
fn app_info_roundtrip_preserves_all_fields() {
    let original = AppInfo {
        name: "TextEdit".into(),
        pid: crate::ProcessId::new(1234),
        bundle_id: Some("com.apple.TextEdit".into()),
        process_instance: Some("test-instance".into()),
        presentation: Some(crate::AppPresentation::Background),
    };
    let json = serde_json::to_string(&original).unwrap();
    let back: AppInfo = serde_json::from_str(&json).unwrap();
    assert_eq!(back.name, original.name);
    assert_eq!(back.pid, original.pid);
    assert_eq!(back.bundle_id, original.bundle_id);
    assert_eq!(back.process_instance, original.process_instance);
    assert_eq!(back.presentation, original.presentation);
}

/// Agents may produce AppInfo JSON without a bundle_id key (e.g. non-macOS adapters
/// or older protocol versions). Deserialization must succeed and yield None.
/// This pins the JSON backward-compat contract: bundle_id is always optional on the wire.
#[test]
fn app_info_bundle_id_missing_key_deserializes_to_none() {
    let json = r#"{"name":"Finder","pid":42}"#;
    let info: AppInfo =
        serde_json::from_str(json).expect("deserialize AppInfo without bundle_id key");
    assert_eq!(info.bundle_id, None);
    assert_eq!(info.name, "Finder");
    assert_eq!(info.pid, 42);
}

/// AccessibilityNode.bounds is annotated skip_serializing_if = "Option::is_none".
/// When the adapter or ref-alloc pipeline strips bounds, the key must not
/// appear in the JSON, keeping token counts low.
#[test]
fn accessibility_node_bounds_none_omitted_from_json() {
    let node = AccessibilityNode {
        ref_id: None,
        role: "button".into(),
        identity: crate::NodeIdentity {
            name: Some("OK".into()),
            ..Default::default()
        },
        presentation: Default::default(),
        children_count: None,
        subtree_truncated: false,
        children: vec![],
    };
    let json = serde_json::to_string(&node).unwrap();
    assert!(
        !json.contains("\"bounds\":"),
        "bounds must be absent when None, json={json}"
    );
}

/// AccessibilityNode.hint is annotated skip_serializing_if = "Option::is_none".
/// When not provided by the platform adapter, it must not appear in the JSON.
#[test]
fn accessibility_node_hint_none_omitted_from_json() {
    let node = AccessibilityNode {
        ref_id: None,
        role: "textfield".into(),
        identity: Default::default(),
        presentation: Default::default(),
        children_count: None,
        subtree_truncated: false,
        children: vec![],
    };
    let json = serde_json::to_string(&node).unwrap();
    assert!(
        !json.contains("\"hint\":"),
        "hint must be absent when None, json={json}"
    );
}

fn descriptor_node() -> AccessibilityNode {
    AccessibilityNode {
        ref_id: None,
        role: "button".into(),
        identity: Default::default(),
        presentation: Default::default(),
        children_count: None,
        subtree_truncated: false,
        children: vec![],
    }
}

/// The four descriptor fields are absent by default: a node that supplies none
/// must serialize byte-identically to the schema before they existed. This is
/// what keeps the macOS golden fixtures the regression proof that core changed
/// shape without changing output.
#[test]
fn descriptor_fields_absent_serialize_to_the_legacy_shape() {
    let node = descriptor_node();
    let json = serde_json::to_string(&node).unwrap();

    for key in ["subrole", "role_description", "placeholder", "dom_classes"] {
        assert!(
            !json.contains(key),
            "descriptor field {key} must be absent when unset, json={json}"
        );
    }
    assert!(json.contains("\"role\":\"button\""));
}

/// Each present field serializes under its documented name; an empty
/// `dom_classes` list is omitted, not emitted as `[]`.
#[test]
fn descriptor_fields_present_serialize_under_documented_names() {
    let mut node = descriptor_node();
    node.presentation.descriptors = crate::NodeDescriptor {
        subrole: Some("button-icon".into()),
        role_description: Some("Push button".into()),
        placeholder: Some("Enter name".into()),
        dom_classes: vec!["btn".into(), "primary".into()],
    };
    let json = serde_json::to_string(&node).unwrap();

    assert!(json.contains("\"subrole\":\"button-icon\""));
    assert!(json.contains("\"role_description\":\"Push button\""));
    assert!(json.contains("\"placeholder\":\"Enter name\""));
    assert!(json.contains("\"dom_classes\":[\"btn\",\"primary\"]"));
}

/// Empty `dom_classes` is omitted rather than serialized as an empty array,
/// so a node with only a subrole stays quiet about the list it does not have.
#[test]
fn empty_dom_classes_is_omitted() {
    let mut node = descriptor_node();
    node.presentation.descriptors = crate::NodeDescriptor {
        subrole: Some("split".into()),
        ..Default::default()
    };
    let json = serde_json::to_string(&node).unwrap();

    assert!(json.contains("\"subrole\":\"split\""));
    assert!(
        !json.contains("dom_classes"),
        "empty dom_classes must be omitted, json={json}"
    );
    assert!(!json.contains("\"role_description\":"));
    assert!(!json.contains("\"placeholder\":"));
}

#[test]
fn node_presentation_never_serializes_ref_bounds() {
    let presentation = crate::NodePresentation {
        ref_bounds: Some(Rect {
            x: 4.0,
            y: 8.0,
            width: 120.0,
            height: 24.0,
        }),
        ..Default::default()
    };
    let json = serde_json::to_string(&presentation).unwrap();

    assert!(
        !json.contains("ref_bounds"),
        "ref_bounds is evidence, not envelope output, json={json}"
    );
}

/// A node with the fields present round-trips through deserialization with all
/// fields intact — pinned both ways, so a future serde mis-threading shows up
/// in the schema test rather than later.
#[test]
fn descriptor_fields_roundtrip_both_ways() {
    let original = crate::NodeDescriptor {
        subrole: Some("treeitem-alt".into()),
        role_description: Some("List item".into()),
        placeholder: None,
        dom_classes: vec!["leaf".into()],
    };
    let json = serde_json::to_string(&original).unwrap();
    let back: crate::NodeDescriptor = serde_json::from_str(&json).unwrap();

    assert_eq!(back.subrole, original.subrole);
    assert_eq!(back.role_description, original.role_description);
    assert_eq!(back.placeholder, original.placeholder);
    assert_eq!(back.dom_classes, original.dom_classes);
}
