use agent_desktop_core::LocatorField;

use super::resolve_role;
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::{ElementProperties, PropertyOutcome, PropertyValue};

#[cfg(target_os = "windows")]
use crate::tree::test_support::flag;
#[cfg(target_os = "windows")]
use agent_desktop_core::tree::roles::{INTERACTIVE_ROLES, is_canonical_role};
#[cfg(target_os = "windows")]
use uiautomation::types::ControlType;

#[cfg(target_os = "windows")]
const ALL_CONTROL_TYPES: [ControlType; 41] = [
    ControlType::Button,
    ControlType::Calendar,
    ControlType::CheckBox,
    ControlType::ComboBox,
    ControlType::Edit,
    ControlType::Hyperlink,
    ControlType::Image,
    ControlType::ListItem,
    ControlType::List,
    ControlType::Menu,
    ControlType::MenuBar,
    ControlType::MenuItem,
    ControlType::ProgressBar,
    ControlType::RadioButton,
    ControlType::ScrollBar,
    ControlType::Slider,
    ControlType::Spinner,
    ControlType::StatusBar,
    ControlType::Tab,
    ControlType::TabItem,
    ControlType::Text,
    ControlType::ToolBar,
    ControlType::ToolTip,
    ControlType::Tree,
    ControlType::TreeItem,
    ControlType::Custom,
    ControlType::Group,
    ControlType::Thumb,
    ControlType::DataGrid,
    ControlType::DataItem,
    ControlType::Document,
    ControlType::SplitButton,
    ControlType::Window,
    ControlType::Pane,
    ControlType::Header,
    ControlType::HeaderItem,
    ControlType::Table,
    ControlType::TitleBar,
    ControlType::Separator,
    ControlType::SemanticZoom,
    ControlType::AppBar,
];

/// Roles [`INTERACTIVE_ROLES`] requires a producer for, that this map has
/// none for. Asserted explicitly rather than assumed: neither Windows
/// control type nor any pattern combination on it produces a color-well or a
/// taskbar dock item, so both stay platform-private to macOS.
#[cfg(target_os = "windows")]
const UNPRODUCED_INTERACTIVE_ROLES: [&str; 2] = ["colorwell", "dockitem"];

#[cfg(target_os = "windows")]
fn control_type_props(
    control_type: ControlType,
    extra: Vec<(TreeProperty, PropertyOutcome)>,
) -> ElementProperties {
    let mut reads = vec![(
        TreeProperty::ControlType,
        PropertyOutcome::Known(PropertyValue::Number(control_type as i32)),
    )];
    reads.extend(extra);
    ElementProperties::from_reads(reads)
}

#[cfg(target_os = "windows")]
fn role_of(control_type: ControlType, extra: Vec<(TreeProperty, PropertyOutcome)>) -> String {
    match resolve_role(&control_type_props(control_type, extra)) {
        LocatorField::Known(role) => role,
        other => panic!("expected LocatorField::Known for {control_type:?}, got {other:?}"),
    }
}

#[cfg(target_os = "windows")]
#[test]
fn every_emitted_role_is_in_the_core_vocabulary() {
    for control_type in ALL_CONTROL_TYPES {
        let role = role_of(control_type, Vec::new());
        assert!(
            is_canonical_role(&role),
            "{control_type:?} emitted {role}, which is not canonical"
        );
    }
}

#[cfg(target_os = "windows")]
fn producible_interactive_roles() -> Vec<String> {
    vec![
        role_of(ControlType::Button, Vec::new()),
        role_of(
            ControlType::Button,
            vec![flag(TreeProperty::ToggleAvailable, true)],
        ),
        role_of(
            ControlType::Button,
            vec![flag(TreeProperty::ExpandCollapseAvailable, true)],
        ),
        role_of(ControlType::CheckBox, Vec::new()),
        role_of(ControlType::ComboBox, Vec::new()),
        role_of(ControlType::Edit, Vec::new()),
        role_of(ControlType::Hyperlink, Vec::new()),
        role_of(ControlType::ListItem, Vec::new()),
        role_of(
            ControlType::List,
            vec![flag(TreeProperty::SelectionAvailable, true)],
        ),
        role_of(ControlType::MenuItem, Vec::new()),
        role_of(ControlType::RadioButton, Vec::new()),
        role_of(ControlType::Slider, Vec::new()),
        role_of(ControlType::Spinner, Vec::new()),
        role_of(ControlType::TabItem, Vec::new()),
        role_of(ControlType::TreeItem, Vec::new()),
        role_of(ControlType::SplitButton, Vec::new()),
        role_of(
            ControlType::DataItem,
            vec![flag(TreeProperty::GridItemAvailable, true)],
        ),
        role_of(
            ControlType::Document,
            vec![
                flag(TreeProperty::ValueAvailable, true),
                flag(TreeProperty::ValueIsReadOnly, false),
            ],
        ),
    ]
}

#[cfg(target_os = "windows")]
#[test]
fn every_interactive_role_is_either_produced_or_explicitly_unproduced() {
    let produced = producible_interactive_roles();
    for role in INTERACTIVE_ROLES {
        assert!(
            produced.iter().any(|candidate| candidate == role)
                || UNPRODUCED_INTERACTIVE_ROLES.contains(role),
            "{role} is neither produced by any control type in this map nor listed in UNPRODUCED_INTERACTIVE_ROLES"
        );
    }
    for role in UNPRODUCED_INTERACTIVE_ROLES {
        assert!(
            !produced.iter().any(|candidate| candidate == role),
            "{role} is listed unproduced but some input in this map now produces it"
        );
    }
}

/// The ARIA-containment table is large enough on its own to press the
/// 400-line file cap, so it lives in its own file rather than crowding out
/// the vocabulary tests above. It is a `tests`-only submodule, declared here
/// rather than in `tree/mod.rs`, so it needs no coordination with whoever
/// owns that file.
#[cfg(target_os = "windows")]
#[path = "roles_aria_tests.rs"]
mod aria;

/// The fixture-coverage union pin needs an enumeration of every role
/// [`super::control_type_role`] can produce, which is large enough alongside
/// the vocabulary tests above to press the 400-line file cap, so it lives in
/// its own file the same way [`aria`] does.
#[cfg(target_os = "windows")]
#[path = "roles_fixture_coverage_tests.rs"]
mod fixture_coverage;

#[cfg(target_os = "windows")]
#[test]
fn tab_and_tabitem_inversion_is_pinned() {
    assert_eq!(role_of(ControlType::Tab, Vec::new()), "tablist");
    assert_eq!(role_of(ControlType::TabItem, Vec::new()), "tab");
}

#[cfg(target_os = "windows")]
#[test]
fn button_advertising_toggle_becomes_switch_not_button() {
    assert_eq!(
        role_of(
            ControlType::Button,
            vec![flag(TreeProperty::ToggleAvailable, true)]
        ),
        "switch"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn checkbox_advertising_toggle_stays_checkbox_not_switch() {
    assert_eq!(
        role_of(
            ControlType::CheckBox,
            vec![flag(TreeProperty::ToggleAvailable, true)]
        ),
        "checkbox"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn a_failed_read_only_read_resolves_document_not_textfield() {
    assert_eq!(
        role_of(
            ControlType::Document,
            vec![
                flag(TreeProperty::ValueAvailable, true),
                (TreeProperty::ValueIsReadOnly, PropertyOutcome::Unknown),
            ]
        ),
        "document"
    );
    assert_eq!(
        role_of(
            ControlType::Document,
            vec![
                flag(TreeProperty::ValueAvailable, true),
                flag(TreeProperty::ValueIsReadOnly, false),
            ]
        ),
        "textfield"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn custom_advertising_griditem_or_tableitem_becomes_cell() {
    assert_eq!(
        role_of(
            ControlType::Custom,
            vec![flag(TreeProperty::GridItemAvailable, true)]
        ),
        "cell"
    );
    assert_eq!(
        role_of(
            ControlType::Custom,
            vec![flag(TreeProperty::TableItemAvailable, true)]
        ),
        "cell"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn custom_advertising_neither_pattern_stays_unknown() {
    assert_eq!(role_of(ControlType::Custom, Vec::new()), "unknown");
}

#[cfg(target_os = "windows")]
#[test]
fn dataitem_advertising_neither_pattern_stays_row() {
    assert_eq!(role_of(ControlType::DataItem, Vec::new()), "row");
}

#[test]
fn an_unrecognized_control_type_id_yields_unknown_role_not_a_failed_read() {
    let properties = ElementProperties::from_reads(vec![(
        TreeProperty::ControlType,
        PropertyOutcome::Known(PropertyValue::Number(1)),
    )]);
    assert_eq!(
        resolve_role(&properties),
        LocatorField::Known("unknown".to_string())
    );
}

#[test]
fn a_failed_control_type_read_yields_locator_field_unknown_not_a_known_unknown_role() {
    let properties =
        ElementProperties::from_reads(vec![(TreeProperty::ControlType, PropertyOutcome::Unknown)]);
    assert_eq!(resolve_role(&properties), LocatorField::Unknown);
}

#[test]
fn an_absent_control_type_read_yields_a_known_unknown_role() {
    let properties =
        ElementProperties::from_reads(vec![(TreeProperty::ControlType, PropertyOutcome::Absent)]);
    assert_eq!(
        resolve_role(&properties),
        LocatorField::Known("unknown".to_string())
    );
}
