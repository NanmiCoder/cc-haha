//! The mapping from this crate's internal property vocabulary to the
//! automation client's generated constants.
//!
//! Split from `property_ids.rs` so that file stays inside the size cap: the
//! vocabulary and its gates are one concern, and which generated constant
//! each name resolves to is another that changes with the client crate
//! rather than with the vocabulary.

use super::TreeProperty;
use uiautomation::types::UIProperty;

/// Resolves an internal property to the crate's generated constant.
///
/// An exhaustive `match` with no catch-all arm, so adding a variant is a
/// compile error rather than a silent fallback to a wrong id.
pub fn uia_property(property: TreeProperty) -> UIProperty {
    match property {
        TreeProperty::Name => UIProperty::Name,
        TreeProperty::AutomationId => UIProperty::AutomationId,
        TreeProperty::ClassName => UIProperty::ClassName,
        TreeProperty::HelpText => UIProperty::HelpText,
        TreeProperty::FullDescription => UIProperty::FullDescription,
        TreeProperty::LabeledBy => UIProperty::LabeledBy,
        TreeProperty::Value => UIProperty::ValueValue,
        TreeProperty::LegacyValue => UIProperty::LegacyIAccessibleValue,
        TreeProperty::BoundingRectangle => UIProperty::BoundingRectangle,
        TreeProperty::IsPassword => UIProperty::IsPassword,
        TreeProperty::IsOffscreen => UIProperty::IsOffscreen,
        TreeProperty::IsEnabled => UIProperty::IsEnabled,
        TreeProperty::IsControlElement => UIProperty::IsControlElement,
        TreeProperty::IsContentElement => UIProperty::IsContentElement,
        TreeProperty::IsKeyboardFocusable => UIProperty::IsKeyboardFocusable,
        TreeProperty::HasKeyboardFocus => UIProperty::HasKeyboardFocus,
        TreeProperty::IsRequiredForForm => UIProperty::IsRequiredForForm,
        TreeProperty::IsDataValidForForm => UIProperty::IsDataValidForForm,
        TreeProperty::IsDialog => UIProperty::IsDialog,
        TreeProperty::ToggleState => UIProperty::ToggleToggleState,
        TreeProperty::ExpandCollapseState => UIProperty::ExpandCollapseExpandCollapseState,
        TreeProperty::SelectionItemIsSelected => UIProperty::SelectionItemIsSelected,
        TreeProperty::ValueIsReadOnly => UIProperty::ValueIsReadOnly,
        TreeProperty::RangeValueIsReadOnly => UIProperty::RangeValueIsReadOnly,
        TreeProperty::SelectionCanSelectMultiple => UIProperty::SelectionCanSelectMultiple,
        TreeProperty::WindowIsModal => UIProperty::WindowIsModal,
        TreeProperty::LegacyState => UIProperty::LegacyIAccessibleState,
        TreeProperty::LegacyDefaultAction => UIProperty::LegacyIAccessibleDefaultAction,
        TreeProperty::InvokeAvailable => UIProperty::IsInvokePatternAvailable,
        TreeProperty::ToggleAvailable => UIProperty::IsTogglePatternAvailable,
        TreeProperty::ExpandCollapseAvailable => UIProperty::IsExpandCollapsePatternAvailable,
        TreeProperty::SelectionItemAvailable => UIProperty::IsSelectionItemPatternAvailable,
        TreeProperty::SelectionAvailable => UIProperty::IsSelectionPatternAvailable,
        TreeProperty::ValueAvailable => UIProperty::IsValuePatternAvailable,
        TreeProperty::RangeValueAvailable => UIProperty::IsRangeValuePatternAvailable,
        TreeProperty::ScrollAvailable => UIProperty::IsScrollPatternAvailable,
        TreeProperty::ScrollItemAvailable => UIProperty::IsScrollItemPatternAvailable,
        TreeProperty::WindowAvailable => UIProperty::IsWindowPatternAvailable,
        TreeProperty::GridItemAvailable => UIProperty::IsGridItemPatternAvailable,
        TreeProperty::TableItemAvailable => UIProperty::IsTableItemPatternAvailable,
        TreeProperty::LegacyAvailable => UIProperty::IsLegacyIAccessiblePatternAvailable,
        TreeProperty::ProviderDescription => UIProperty::ProviderDescription,
        TreeProperty::ControlType => UIProperty::ControlType,
        TreeProperty::RuntimeId => UIProperty::RuntimeId,
        TreeProperty::LocalizedControlType => UIProperty::LocalizedControlType,
        TreeProperty::AriaRole => UIProperty::AriaRole,
    }
}
