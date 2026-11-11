use agent_desktop_core::{
    LocatorField, NameEvidence, NameSlotStatus, SlotStatus, resolve_description, resolve_name,
};

use super::properties::ElementProperties;
use super::properties::property_ids::TreeProperty;
use super::properties::property_outcome::PropertyOutcome;

/// What reading an element's `LabeledBy` relation produced.
///
/// The four outcomes are not interchangeable, and collapsing any two of them
/// would either lose a name or publish one that should have been withheld.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LabelOutcome {
    /// The provider publishes no label relation for this element. A15-1
    /// measured this on all twenty elements of a Win32 fixture, where the
    /// client-side proxy has no MSAA relation to derive one from - so it is
    /// the ordinary case, not a failure.
    Unlabelled,
    /// The label resolved and its text is readable.
    Text(String),
    /// The label resolved and the target reports `IsPassword`. A15-2 measured
    /// this case as constructible: a non-secure control labelled by a secure
    /// one. The referring element's own gate never sees it, because the
    /// content came from a different element.
    Withheld,
    /// The relation or the target's name could not be read.
    Failed,
}

/// Supplies the name-evidence slots this platform can fill, and computes
/// nothing.
///
/// The name itself comes from `agent_desktop_core::resolve_name`, the one
/// precedence in the product. This function's whole job is to say what each
/// slot holds and how certain it is.
///
/// **`Name` is the strong signal on Windows, and `labelled_by_text` is not a
/// routine override.** UIA's `Name` is not macOS's `AXTitle`: it is already the
/// provider's own *computed* accessible name, which on a well-behaved provider
/// has typically absorbed the very label relationship `LabeledBy` describes.
/// Feeding both into a precedence that ranks `labelled_by_text` above
/// `native_title` would let a fragment override the name its own provider
/// finalised. So the label is supplied only when `Name` has nothing to say, and
/// the slot is suppressed otherwise.
pub fn name_fields(
    properties: &ElementProperties,
    label: &LabelOutcome,
) -> (LocatorField<String>, LocatorField<String>) {
    let evidence = evidence_of(properties, label);
    let status = status_of(properties, label);
    (
        resolve_name(&evidence, &status),
        resolve_description(&evidence, &status),
    )
}

fn evidence_of(properties: &ElementProperties, label: &LabelOutcome) -> NameEvidence {
    NameEvidence {
        native_title: text_of(properties.get(TreeProperty::Name)),
        labelled_by_text: match label {
            LabelOutcome::Text(text) => Some(text.clone()),
            LabelOutcome::Unlabelled | LabelOutcome::Withheld | LabelOutcome::Failed => None,
        },
        description: description_of(properties),
        explicit_label: None,
        static_value: None,
        child_label: None,
        placeholder: placeholder_of(properties),
    }
}

/// The placeholder input slot, filled from `HelpText` where it is not already
/// the description - the same rule the output `placeholder` descriptor uses.
///
/// The slot exists so a placeholder-only control (a text field whose only
/// accessible text is its prompt) can still receive a name; without it, such a
/// control would be unreferenced even though UIA publishes the prompt in
/// `HelpText`.
fn placeholder_of(properties: &ElementProperties) -> Option<String> {
    super::descriptor::placeholder_of(properties)
}

/// `FullDescription` is the description, with `HelpText` as its fallback.
///
/// The choice is made here, once, rather than per call site. A15-4 measured
/// both as readable and empty on every Win32 control type, so the measurement
/// does not pick between them; Microsoft documents `FullDescription` as the
/// extended description and `HelpText` as a brief one, so the richer source
/// wins and the other backs it up. `HelpText` never doubles as a placeholder:
/// `placeholder` is a separate evidence field this module does not fill, and
/// a property serving two slots is how the same string ends up reported
/// twice under different names.
fn description_of(properties: &ElementProperties) -> Option<String> {
    text_of(properties.get(TreeProperty::FullDescription))
        .or_else(|| text_of(properties.get(TreeProperty::HelpText)))
}

fn text_of(outcome: PropertyOutcome) -> Option<String> {
    outcome.non_blank_text()
}

/// Folds this platform's own gating into the per-slot status before core sees
/// it, so no UIA concept crosses into shared code.
fn status_of(properties: &ElementProperties, label: &LabelOutcome) -> NameSlotStatus {
    NameSlotStatus {
        native_title: slot_of(properties.get(TreeProperty::Name)),
        labelled_by_text: label_slot(properties, label),
        description: description_slot(properties),
        explicit_label: SlotStatus::Suppressed,
        static_value: SlotStatus::Suppressed,
        child_label: SlotStatus::Suppressed,
        placeholder: placeholder_slot(properties),
    }
}

/// The placeholder slot's status, mirroring the source rule:
///
/// - when `FullDescription` is a real answer, `HelpText` is free to be the
///   placeholder, and the slot tracks the `HelpText` read's certainty;
/// - when `FullDescription` is blank or failed, `HelpText` is the description
///   (per `description_of`), there is no placeholder claim, and the slot is
///   `Suppressed` so the placeholder never double-reports the description.
fn placeholder_slot(properties: &ElementProperties) -> SlotStatus {
    if text_of(properties.get(TreeProperty::FullDescription)).is_some() {
        match properties.get(TreeProperty::HelpText) {
            PropertyOutcome::Unknown => SlotStatus::Uncertain,
            PropertyOutcome::Known(_) | PropertyOutcome::Absent => SlotStatus::Certain,
        }
    } else {
        SlotStatus::Suppressed
    }
}

/// The label slot's status, which is where the provider-authority rule lives.
///
/// A resolved label is suppressed outright when `Name` already answered,
/// rather than being allowed to outrank it. When `Name` is empty the label is
/// admitted, which is the case it exists for.
fn label_slot(properties: &ElementProperties, label: &LabelOutcome) -> SlotStatus {
    if text_of(properties.get(TreeProperty::Name)).is_some() {
        return SlotStatus::Suppressed;
    }
    match label {
        LabelOutcome::Text(_) => SlotStatus::Certain,
        LabelOutcome::Unlabelled | LabelOutcome::Withheld => SlotStatus::Suppressed,
        LabelOutcome::Failed => SlotStatus::Uncertain,
    }
}

/// A non-blank answer from either source outranks everything else: one
/// property producing real text is a real answer about the element, even if
/// the other read failed. `Known("")` is not that answer - a measured Win32
/// shape reports both properties as empty strings, and `text_of` already
/// treats a blank string the same as no value, so counting it as "answered"
/// here would let a source whose read actually failed pass for a source that
/// definitively has nothing. Only once neither source produced non-blank text
/// does a failed read matter - and then it must cloud the slot rather than
/// let a provider that definitively has nothing (both `Absent`, or blank text
/// with no failed read alongside it) look the same as a read that simply
/// broke.
fn description_slot(properties: &ElementProperties) -> SlotStatus {
    let full = properties.get(TreeProperty::FullDescription);
    let help = properties.get(TreeProperty::HelpText);
    if text_of(full.clone()).is_some() || text_of(help.clone()).is_some() {
        SlotStatus::Certain
    } else if matches!(full, PropertyOutcome::Unknown) || matches!(help, PropertyOutcome::Unknown) {
        SlotStatus::Uncertain
    } else {
        SlotStatus::Certain
    }
}

fn slot_of(outcome: PropertyOutcome) -> SlotStatus {
    match outcome {
        PropertyOutcome::Unknown => SlotStatus::Uncertain,
        PropertyOutcome::Known(_) | PropertyOutcome::Absent => SlotStatus::Certain,
    }
}

/// The cross-element secure gate, as a decision on plain values.
///
/// A label's text crosses an element boundary: the referring element's own
/// per-element secure gate never sees it, because the content came from a
/// different element's `Name`. This function is the only thing standing
/// between a secure target's text and a different, non-secure element's
/// published name, so it is kept free of COM types and given its own tests -
/// including one that proves the secure branch is load-bearing by removing
/// it and watching a test fail.
fn label_from_target(target_is_secure: bool, target_name: Result<String, ()>) -> LabelOutcome {
    if target_is_secure {
        return LabelOutcome::Withheld;
    }
    match target_name {
        Err(()) => LabelOutcome::Failed,
        Ok(text) if text.trim().is_empty() => LabelOutcome::Unlabelled,
        Ok(text) => LabelOutcome::Text(text),
    }
}

/// The fail-closed policy behind the target's `IsPassword` read: a property
/// that could not be read is not evidence the target is safe, so it is
/// treated the same as a confirmed secure target.
fn secure_from_read(read: Result<bool, ()>) -> bool {
    read.unwrap_or(true)
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{LabelOutcome, label_from_target, secure_from_read};
    use crate::tree::element::UIAElement;
    use crate::tree::properties::property_ids::{TreeProperty, uia_property};
    use uiautomation::UIElement;
    use uiautomation::variants::{Value, Variant};

    /// Resolves an element's `LabeledBy` target and reads its name.
    ///
    /// **The relation rides the cache; the target's own properties do not.**
    /// A15-3 measured that a cached element-returning property hands back a
    /// target whose `get_cached_property_value` fails `E_INVALIDARG` for the
    /// very properties the same request asked for. So the relation costs
    /// nothing on an unlabelled node - it is one more property in a batch
    /// already being fetched - and the target's `Name` and `IsPassword` are
    /// read live, for the labelled nodes alone. On the WPF fixture that is two
    /// of forty-six.
    ///
    /// The COM reads happen here; the policy on what they mean lives in
    /// `label_from_target`, which this function only calls.
    pub fn read_label(element: &UIAElement, cached: bool) -> LabelOutcome {
        let property = uia_property(TreeProperty::LabeledBy);
        let variant = if cached {
            element.0.get_cached_property_value(property)
        } else {
            element.0.get_property_value(property)
        };
        let Ok(variant) = variant else {
            return LabelOutcome::Failed;
        };
        let Some(target) = element_of(&variant) else {
            return LabelOutcome::Unlabelled;
        };
        label_from_target(is_secure(&target), read_name(&target))
    }

    fn read_name(target: &UIElement) -> Result<String, ()> {
        target
            .get_property_value(uia_property(TreeProperty::Name))
            .map_err(|_| ())
            .and_then(|name| name.get_string().map_err(|_| ()))
    }

    fn is_secure(target: &UIElement) -> bool {
        let read = match target.get_property_value(uia_property(TreeProperty::IsPassword)) {
            Err(_) => Err(()),
            Ok(variant) => Ok(!matches!(variant.get_value(), Ok(Value::BOOL(false)))),
        };
        secure_from_read(read)
    }

    fn element_of(variant: &Variant) -> Option<UIElement> {
        use windows::Win32::UI::Accessibility::IUIAutomationElement;
        use windows::core::Interface;
        let Ok(Value::UNKNOWN(unknown)) = variant.get_value() else {
            return None;
        };
        let element: IUIAutomationElement = unknown.cast().ok()?;
        Some(UIElement::from(&element))
    }
}

#[cfg(target_os = "windows")]
pub use imp::read_label;

/// The non-Windows twin. The relation is a UI Automation concept with no
/// counterpart here; every element is simply unlabelled, which is the same
/// answer A15-1 measured on the Win32 proxy.
#[cfg(not(target_os = "windows"))]
pub fn read_label(_element: &super::element::UIAElement, _cached: bool) -> LabelOutcome {
    LabelOutcome::Unlabelled
}

#[cfg(test)]
#[path = "name_evidence_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "name_evidence_description_tests.rs"]
mod tests_description;
