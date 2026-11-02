use agent_desktop_core::{
    ElementIdentifier, IdentifierEvidence, IdentifierKind, LocatorEvidence, LocatorField,
    LocatorRefEvidence,
};

use super::property_ids::TreeProperty;
use super::property_outcome::{PropertyOutcome, PropertyValue};

/// Withholds a value-bearing property from a secure element.
///
/// Only a value that was actually read is replaced. A read that failed carries
/// no content, so there is nothing to withhold — and rewriting it to `Absent`
/// would claim the provider does not implement the property, which is false
/// and is exactly the fabrication A14-9 forbids: `Absent` is a legitimate
/// answer that satisfies `EvidenceRequirements`, and a target that never
/// answered must not be able to satisfy them.
fn withheld(outcome: PropertyOutcome) -> PropertyOutcome {
    match outcome {
        PropertyOutcome::Known(_) => PropertyOutcome::Absent,
        PropertyOutcome::Absent => PropertyOutcome::Absent,
        PropertyOutcome::Unknown => PropertyOutcome::Unknown,
    }
}

/// A `Known` value read as a boolean, accepting the two shapes a provider may
/// answer a documented-`VT_BOOL` property with: `VT_BOOL` itself (`Flag`), or
/// the `VT_I4` divergence `is_secure`'s doc comment names (`Number`, nonzero
/// meaning true). `None` for any other `Known` shape, which is not this
/// provider's divergence and must not be guessed at.
fn known_as_bool(value: &PropertyValue) -> Option<bool> {
    match value {
        PropertyValue::Flag(value) => Some(*value),
        PropertyValue::Number(value) => Some(*value != 0),
        _ => None,
    }
}

fn withholds_content(outcome: &PropertyOutcome) -> bool {
    match outcome {
        PropertyOutcome::Known(value) => known_as_bool(value).unwrap_or(true),
        PropertyOutcome::Unknown => true,
        PropertyOutcome::Absent => false,
    }
}

/// What the vocabulary modules made of one element's read set.
///
/// These travel together because they are resolved together, from the same
/// batch, by the same walk step. Passing them as five separate arguments to
/// the projection was the alternative, and it put the projection one slot away
/// from the parameter limit with every future evidence field making it worse.
#[derive(Debug, Clone)]
pub struct ResolvedVocabulary {
    pub role: LocatorField<String>,
    pub available_actions: LocatorField<Vec<String>>,
    pub states: LocatorField<Vec<String>>,
    pub name: LocatorField<String>,
    pub description: LocatorField<String>,
}

impl ResolvedVocabulary {
    /// The answer for an element nothing was read from: every slot unknown.
    /// Used by the non-Windows twin and by tests that assert on other slots.
    pub fn unknown() -> Self {
        Self {
            role: LocatorField::Unknown,
            available_actions: LocatorField::Unknown,
            states: LocatorField::Unknown,
            name: LocatorField::Unknown,
            description: LocatorField::Unknown,
        }
    }
}

/// Every property read for one element, already gated on `IsPassword`.
#[derive(Debug, Clone, Default)]
pub struct ElementProperties {
    entries: Vec<(TreeProperty, PropertyOutcome)>,
    secure: bool,
}

impl ElementProperties {
    pub fn from_reads(reads: Vec<(TreeProperty, PropertyOutcome)>) -> Self {
        let secure = reads
            .iter()
            .find(|(property, _)| *property == TreeProperty::IsPassword)
            .is_some_and(|(_, outcome)| withholds_content(outcome));
        let entries = reads
            .into_iter()
            .map(|(property, outcome)| {
                if secure && property.is_value_bearing() {
                    (property, withheld(outcome))
                } else {
                    (property, outcome)
                }
            })
            .collect();
        Self { entries, secure }
    }

    /// Decides the secure-field gate from one `IsPassword` outcome.
    ///
    /// Fails closed, because the cost is asymmetric: withholding a name that
    /// was not secret loses a little evidence, while publishing one that was
    /// puts a password into a snapshot, a session JSONL segment and a trace
    /// HTML export.
    ///
    /// - `Known(true)` is the ordinary answer, and a non-zero integer is the
    ///   same answer from a provider that returns `VT_I4` where UIA documents
    ///   `VT_BOOL`. Reading only `VT_BOOL` would let such a provider open the
    ///   gate.
    /// - `Unknown` means the read failed, which is not evidence the element is
    ///   safe, so it withholds too.
    /// - `Absent` means the provider answered and does not implement the
    ///   property, which is a real answer: not a password field.
    ///
    /// An element whose read set never requested `IsPassword` is not gated at
    /// all - there was nothing to gate, and the caller chose the property set.
    pub fn is_secure(&self) -> bool {
        self.secure
    }

    pub fn get(&self, property: TreeProperty) -> PropertyOutcome {
        self.entries
            .iter()
            .find(|(candidate, _)| *candidate == property)
            .map(|(_, outcome)| outcome.clone())
            .unwrap_or(PropertyOutcome::Unknown)
    }

    /// Replaces one property's outcome in place, pushing it when the read
    /// set never carried it. `get` answers the first matching entry, so an
    /// override must replace rather than append.
    pub(crate) fn set(&mut self, property: TreeProperty, outcome: PropertyOutcome) {
        match self
            .entries
            .iter()
            .position(|(candidate, _)| *candidate == property)
        {
            Some(index) => self.entries[index] = (property, outcome),
            None => self.entries.push((property, outcome)),
        }
    }

    /// Reads a boolean **through its gate**, which is the only safe way to
    /// read one.
    ///
    /// A15-7 measured that a pattern-state property returns a
    /// default-looking value - never the not-supported sentinel - on an
    /// element whose provider does not implement the pattern: a static text
    /// reports `ValueIsReadOnly` = `true` with no `Value` pattern at all.
    /// `TreeProperty::gate()` names the availability property that has to be
    /// `true` first, and this is the single accessor that consults it, so a
    /// caller cannot read a gated property without the gate. A property with
    /// no gate reads straight through.
    ///
    /// The value itself is read through [`known_as_bool`], the same
    /// documented-`VT_BOOL`-or-divergent-`VT_I4` acceptance `gate_open` uses:
    /// every property this crate reads with `gated_flag` - the `…Available`
    /// gates themselves included, which reach this accessor ungated - is
    /// documented `VT_BOOL`, so the same provider divergence applies here too.
    pub fn gated_flag(&self, property: TreeProperty) -> Option<bool> {
        if !self.gate_open(property) {
            return None;
        }
        match self.get(property) {
            PropertyOutcome::Known(value) => known_as_bool(&value),
            PropertyOutcome::Unknown | PropertyOutcome::Absent => None,
        }
    }

    pub fn gated_number(&self, property: TreeProperty) -> Option<i32> {
        if !self.gate_open(property) {
            return None;
        }
        self.get(property).number()
    }

    /// Whether a gated property's value means anything on this element.
    pub fn is_true(&self, property: TreeProperty) -> bool {
        self.gated_flag(property) == Some(true)
    }

    /// A15-7 measured the divergence on the *state* property; the same
    /// divergence reaches the *gate* property one hop earlier, undetected
    /// until code review: a provider can answer a documented-`VT_BOOL`
    /// `…Available` property as `VT_I4(1)`, and reading only `flag()` reads
    /// that answer as gate-CLOSED, silently dropping the element's role
    /// refinement, its advertised action, and its gated state. This mirrors
    /// `withholds_content`'s predicate rather than duplicating a second one: a
    /// `Known(true)` flag or a non-zero `Known` number opens the gate; an
    /// unread gate (`Unknown` or `Absent`) does not - "the read never
    /// happened" must never be read as "the gate is open".
    fn gate_open(&self, property: TreeProperty) -> bool {
        match property.gate() {
            Some(gate) => match self.get(gate) {
                PropertyOutcome::Known(value) => known_as_bool(&value).unwrap_or(false),
                PropertyOutcome::Unknown | PropertyOutcome::Absent => false,
            },
            None => true,
        }
    }

    /// Projects the read set onto the evidence slot shape core consumes, so
    /// the consumer needs no translation layer.
    ///
    /// Every interpreted slot is resolved by a vocabulary module from this
    /// same read set and threaded in by the caller, so this stays a projection
    /// and takes no decision of its own - notably the name, which core
    /// computes and no adapter does. `identifiers` uses
    /// `IdentifierEvidence::typed`, because `IdentifierEvidence::new` stamps
    /// every value `Unknown` and would void the ref downstream in
    /// `refs_validate.rs`.
    ///
    /// The value is the one place this projects rather than copies: a RichEdit
    /// control ends its text with a paragraph mark (`\r`) that is not user
    /// content, so an emptied field would read back as `"\r"` and every
    /// written value would gain one. That single trailing mark is dropped for
    /// RichEdit classes, matched case-insensitively (Character Map's is
    /// `RICHEDIT50W`); every other control reports its value verbatim.
    pub fn locator_evidence(&self, vocabulary: ResolvedVocabulary) -> LocatorEvidence {
        let value = self.value_without_rich_edit_terminator();
        let bounds = self.get(TreeProperty::BoundingRectangle).bounds();
        LocatorEvidence {
            role: vocabulary.role,
            name: vocabulary.name,
            description: vocabulary.description,
            value,
            identifiers: self.identifier_evidence(),
            states: vocabulary.states,
            ref_evidence: LocatorRefEvidence {
                window_bounds: LocatorField::Absent,
                bounds,
                available_actions: vocabulary.available_actions,
                descriptors: crate::tree::descriptor::descriptors(self),
            },
        }
    }

    fn value_without_rich_edit_terminator(&self) -> LocatorField<String> {
        match self.get(TreeProperty::Value).text() {
            LocatorField::Known(value) if self.is_rich_edit() && value.ends_with('\r') => {
                LocatorField::Known(value[..value.len() - 1].to_string())
            }
            other => other,
        }
    }

    fn is_rich_edit(&self) -> bool {
        matches!(
            self.get(TreeProperty::ClassName),
            PropertyOutcome::Known(PropertyValue::Text(class)) if class.to_ascii_lowercase().starts_with("richedit")
        )
    }

    fn identifier_evidence(&self) -> IdentifierEvidence {
        let automation_id = self.get(TreeProperty::AutomationId);
        match automation_id {
            PropertyOutcome::Known(PropertyValue::Text(value)) if !value.trim().is_empty() => {
                IdentifierEvidence::typed(
                    [ElementIdentifier {
                        kind: IdentifierKind::AutomationId,
                        value,
                    }],
                    Some(0),
                    true,
                )
            }
            PropertyOutcome::Known(_) | PropertyOutcome::Absent => IdentifierEvidence::absent(),
            PropertyOutcome::Unknown => IdentifierEvidence::unknown(),
        }
    }
}

#[cfg(test)]
#[path = "element_properties_tests.rs"]
mod tests;
