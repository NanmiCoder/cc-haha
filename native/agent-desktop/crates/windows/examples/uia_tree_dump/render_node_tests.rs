//! Regression gate for `render_node`.
//!
//! `node()` is reachable only through `collect()` against a live `UIAElement`,
//! so nothing else in this crate renders an actual node in a test - a revert
//! of a call site inside `render_node` from `text_presence`/`field_presence`
//! back to `slot()` would pass every other test in this example. `render_node`
//! is COM-free by construction, which is what makes this test possible: it
//! plants a unique marker in every text-bearing input `render_node` reads and
//! asserts the marker appears nowhere in the rendered JSON, while the
//! presence and character count for each of those slots is still reported -
//! so the test cannot pass by rendering nothing.

use super::*;
use agent_desktop_core::LocatorField;
use agent_desktop_windows::tree::properties::PropertyValue;

const MARKER: &str = "ZZ-RENDER-NODE-LEAK-MARKER-do-not-serialize-2468";

fn marked_fields() -> NodeFields {
    NodeFields {
        position: Position {
            parent: None,
            index: 0,
            depth: 0,
        },
        properties: ElementProperties::from_reads(vec![
            (
                TreeProperty::AutomationId,
                PropertyOutcome::Known(PropertyValue::Text(MARKER.to_string())),
            ),
            (
                TreeProperty::HelpText,
                PropertyOutcome::Known(PropertyValue::Text(MARKER.to_string())),
            ),
            (
                TreeProperty::FullDescription,
                PropertyOutcome::Known(PropertyValue::Text(MARKER.to_string())),
            ),
            (
                TreeProperty::LegacyDefaultAction,
                PropertyOutcome::Known(PropertyValue::Text(MARKER.to_string())),
            ),
            (
                TreeProperty::LocalizedControlType,
                PropertyOutcome::Known(PropertyValue::Text(MARKER.to_string())),
            ),
            (
                TreeProperty::AriaRole,
                PropertyOutcome::Known(PropertyValue::Text(MARKER.to_string())),
            ),
        ]),
        vocabulary: ResolvedVocabulary {
            role: LocatorField::Known("button".to_string()),
            available_actions: LocatorField::Unknown,
            states: LocatorField::Unknown,
            name: LocatorField::Known(MARKER.to_string()),
            description: LocatorField::Known(MARKER.to_string()),
        },
        label: LabelOutcome::Text(MARKER.to_string()),
        provider_description: PropertyOutcome::Known(PropertyValue::Text(
            "not-a-marker-provider-description".to_string(),
        )),
        failed_reads: 0,
    }
}

#[test]
fn render_node_never_renders_a_marker_planted_in_every_text_slot() {
    let rendered = render_node(&marked_fields());

    let serialized = rendered.to_string();
    assert!(
        !serialized.contains(MARKER),
        "render_node leaked its marker: {serialized}"
    );

    let chars = MARKER.chars().count();
    assert_eq!(
        rendered["automation_id"],
        json!({ "present": true, "chars": chars })
    );
    assert_eq!(
        rendered["help_text"],
        json!({ "present": true, "chars": chars })
    );
    assert_eq!(
        rendered["full_description"],
        json!({ "present": true, "chars": chars })
    );
    assert_eq!(
        rendered["legacy_default_action"],
        json!({ "present": true, "chars": chars })
    );
    assert_eq!(rendered["name"], json!({ "present": true, "chars": chars }));
    assert_eq!(
        rendered["description"],
        json!({ "present": true, "chars": chars })
    );
    assert_eq!(rendered["labelled"], json!(true));

    assert_eq!(
        rendered["subrole"],
        json!({ "present": true, "chars": chars }),
        "AriaRole rendered presence-only, never its content"
    );
    assert_eq!(
        rendered["role_description"],
        json!({ "present": true, "chars": chars }),
        "LocalizedControlType rendered presence-only, never its content"
    );
    assert_eq!(
        rendered["placeholder"],
        json!({ "present": true, "chars": chars }),
        "the HelpText-derived placeholder rendered presence-only, never its content"
    );
}
