use super::TreeProperty;

/// Every variant of `TreeProperty`, listed once for the identity gates below.
///
/// Completeness is not trusted to a reader: `the_listed_properties_are_every_variant_the_enum_declares`
/// diffs this list against the enum's own declaration in the source file, so a
/// variant added to `TreeProperty` without joining this list fails there rather
/// than quietly escaping every assertion here.
pub(super) const ALL_PROPERTIES: &[TreeProperty] = &[
    TreeProperty::Name,
    TreeProperty::AutomationId,
    TreeProperty::ClassName,
    TreeProperty::HelpText,
    TreeProperty::FullDescription,
    TreeProperty::LabeledBy,
    TreeProperty::Value,
    TreeProperty::LegacyValue,
    TreeProperty::BoundingRectangle,
    TreeProperty::IsPassword,
    TreeProperty::IsOffscreen,
    TreeProperty::IsEnabled,
    TreeProperty::IsControlElement,
    TreeProperty::IsContentElement,
    TreeProperty::IsKeyboardFocusable,
    TreeProperty::HasKeyboardFocus,
    TreeProperty::IsRequiredForForm,
    TreeProperty::IsDataValidForForm,
    TreeProperty::IsDialog,
    TreeProperty::ToggleState,
    TreeProperty::ExpandCollapseState,
    TreeProperty::SelectionItemIsSelected,
    TreeProperty::ValueIsReadOnly,
    TreeProperty::RangeValueIsReadOnly,
    TreeProperty::SelectionCanSelectMultiple,
    TreeProperty::WindowIsModal,
    TreeProperty::LegacyState,
    TreeProperty::LegacyDefaultAction,
    TreeProperty::InvokeAvailable,
    TreeProperty::ToggleAvailable,
    TreeProperty::ExpandCollapseAvailable,
    TreeProperty::SelectionItemAvailable,
    TreeProperty::SelectionAvailable,
    TreeProperty::ValueAvailable,
    TreeProperty::RangeValueAvailable,
    TreeProperty::ScrollAvailable,
    TreeProperty::ScrollItemAvailable,
    TreeProperty::WindowAvailable,
    TreeProperty::GridItemAvailable,
    TreeProperty::TableItemAvailable,
    TreeProperty::LegacyAvailable,
    TreeProperty::ProviderDescription,
    TreeProperty::ControlType,
    TreeProperty::RuntimeId,
    TreeProperty::LocalizedControlType,
    TreeProperty::AriaRole,
];

/// The variant names the enum declares, read from the source rather than from
/// a second hand-written list.
fn declared_variants() -> Vec<String> {
    let source = include_str!("property_ids.rs");
    let start = source
        .find("pub enum TreeProperty {")
        .expect("the enum declaration is in this file");
    let body = &source[start..];
    let end = body.find("\n}").expect("the enum declaration is closed");
    body[..end]
        .lines()
        .skip(1)
        .map(str::trim)
        .filter(|line| line.ends_with(','))
        .map(|line| line.trim_end_matches(',').to_string())
        .collect()
}

#[test]
fn the_listed_properties_are_every_variant_the_enum_declares() {
    let declared = declared_variants();
    assert!(
        !declared.is_empty(),
        "reading no variants would make every gate in this file vacuous"
    );

    let listed: Vec<String> = ALL_PROPERTIES
        .iter()
        .map(|property| format!("{property:?}"))
        .collect();
    for variant in &declared {
        assert!(
            listed.contains(variant),
            "{variant} is declared on the enum and is missing from ALL_PROPERTIES"
        );
    }
    assert_eq!(listed.len(), declared.len());
}

/// `as_str()` is the sole identifier of a failed property in the structured
/// error payload that reaches a session trace segment and the trace export, so
/// two properties sharing a name would make those payloads unreadable.
///
/// Asserting only that each name is non-empty passes on a collision, which is
/// the failure this pins: a name is a value, not a presence.
#[test]
fn every_property_carries_a_name_no_other_property_uses() {
    let mut seen: Vec<&'static str> = Vec::new();
    for property in ALL_PROPERTIES {
        let name = property.as_str();
        assert!(!name.is_empty(), "{property:?} names itself with nothing");
        assert!(
            !seen.contains(&name),
            "{property:?} reports {name}, which another property already reports"
        );
        seen.push(name);
    }
    assert_eq!(seen.len(), ALL_PROPERTIES.len());
}

/// Three names spelled out, because the UI Automation spelling and this
/// crate's variant spelling deliberately differ for the legacy family, and a
/// uniqueness check alone would accept a wholesale renaming.
#[test]
fn the_names_that_do_not_match_their_variant_spelling_are_pinned() {
    assert_eq!(TreeProperty::LegacyValue.as_str(), "LegacyIAccessibleValue");
    assert_eq!(TreeProperty::Name.as_str(), "Name");
    assert_eq!(TreeProperty::HelpText.as_str(), "HelpText");
}

/// A2-5 measured that UI Automation property ids are build-specific, so every
/// id comes from the crate's generated constants. What that mapping must
/// guarantee is that no two properties resolve to the same constant: a
/// mis-mapped variant makes the walk read one property's value into another
/// property's slot, which no amount of "the call returned something" observes.
///
/// The previous form of this check called `uia_property` and discarded the
/// answer, so it could only fail by failing to compile.
#[cfg(target_os = "windows")]
#[test]
fn no_two_properties_resolve_to_the_same_automation_constant() {
    use super::uia_property;

    let mut seen: Vec<(String, TreeProperty)> = Vec::new();
    for property in ALL_PROPERTIES {
        let resolved = format!("{:?}", uia_property(*property));
        if let Some((_, other)) = seen.iter().find(|(candidate, _)| candidate == &resolved) {
            panic!("{property:?} and {other:?} both resolve to {resolved}");
        }
        seen.push((resolved, *property));
    }
    assert_eq!(seen.len(), ALL_PROPERTIES.len());
}
