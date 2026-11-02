use crate::locator::live_locator::LocatorField;
use crate::tree::name_evidence::NameEvidence;
use crate::tree::name_slot_status::{NameSlotStatus, SlotStatus};

/// The accessible-name precedence, and the only one in the product.
///
/// Both adapters call this. That is the point of it: the precedence was
/// documented here and implemented a second time inside the macOS adapter,
/// and the two disagreed - the shipped one ranked `description` fifth while
/// the documented one ranked it last, and only the documented one had no
/// caller. A second divergent copy for Windows is the outcome this function
/// exists to prevent.
///
/// The order below is the **shipped** one, so the documented precedence and the
/// one that actually produced every snapshot now agree.
///
/// Uncertainty travels downward, which is what a plain `Option`-returning
/// version structurally cannot express: if a stronger source failed to read,
/// the answer is `Unknown` even when a weaker source has a value, because the
/// value that would have won may be the one that is missing. Falling through to
/// the weaker source would publish a name the element may not have.
pub fn resolve_name(evidence: &NameEvidence, status: &NameSlotStatus) -> LocatorField<String> {
    let mut uncertain = false;
    for (candidate, slot) in ordered_sources(evidence, status) {
        match slot {
            SlotStatus::Suppressed => continue,
            SlotStatus::Uncertain => uncertain = true,
            SlotStatus::Certain => {}
        }
        if let Some(value) = non_blank(candidate) {
            return if uncertain {
                LocatorField::Unknown
            } else {
                LocatorField::Known(value.to_string())
            };
        }
    }
    if uncertain {
        LocatorField::Unknown
    } else {
        LocatorField::Absent
    }
}

/// The description, which is only a description when something else is already
/// the name.
///
/// An element whose only evidence is a description has that description as its
/// name, so repeating it here would emit the same string twice under two
/// labels and tell a calling agent nothing.
pub fn resolve_description(
    evidence: &NameEvidence,
    status: &NameSlotStatus,
) -> LocatorField<String> {
    let stronger = stronger_sources(evidence, status);
    let named = stronger.iter().any(|(candidate, slot)| {
        *slot != SlotStatus::Suppressed && non_blank(*candidate).is_some()
    });
    let name_uncertain = stronger
        .iter()
        .any(|(_, slot)| *slot == SlotStatus::Uncertain);
    let suppressed = status.description == SlotStatus::Suppressed;
    let description = if suppressed {
        None
    } else {
        non_blank(evidence.description.as_deref())
    };
    let uncertain = !suppressed && status.description == SlotStatus::Uncertain;
    match (description, named, name_uncertain) {
        (Some(_), true, _) if uncertain => LocatorField::Unknown,
        (Some(value), true, _) => LocatorField::Known(value.to_string()),
        (Some(_), false, true) => LocatorField::Unknown,
        (None, true, _) if uncertain => LocatorField::Unknown,
        (None, false, true) if uncertain => LocatorField::Unknown,
        _ => LocatorField::Absent,
    }
}

/// The name a caller with no uncertainty channel gets.
///
/// It delegates rather than repeating the order, so the two cannot drift apart
/// again: there is one array of sources in this file and both entry points read
/// it.
pub fn compute_name(evidence: &NameEvidence) -> Option<String> {
    resolve_name(evidence, &NameSlotStatus::default())
        .known()
        .cloned()
}

pub fn compute_description(evidence: &NameEvidence) -> Option<String> {
    resolve_description(evidence, &NameSlotStatus::default())
        .known()
        .cloned()
}

/// The precedence itself: strongest first.
fn ordered_sources<'a>(
    evidence: &'a NameEvidence,
    status: &NameSlotStatus,
) -> [(Option<&'a str>, SlotStatus); 7] {
    let stronger = stronger_sources(evidence, status);
    [
        stronger[0],
        stronger[1],
        stronger[2],
        stronger[3],
        (evidence.description.as_deref(), status.description),
        (evidence.child_label.as_deref(), status.child_label),
        (evidence.placeholder.as_deref(), status.placeholder),
    ]
}

/// The sources that outrank a description, which is what decides whether a
/// description is a description at all.
fn stronger_sources<'a>(
    evidence: &'a NameEvidence,
    status: &NameSlotStatus,
) -> [(Option<&'a str>, SlotStatus); 4] {
    [
        (evidence.explicit_label.as_deref(), status.explicit_label),
        (
            evidence.labelled_by_text.as_deref(),
            status.labelled_by_text,
        ),
        (evidence.native_title.as_deref(), status.native_title),
        (evidence.static_value.as_deref(), status.static_value),
    ]
}

/// An empty string is not text a caller reads, so it is treated the same as
/// absent. Generic over `Option<&str>` and `Option<String>` so it serves
/// borrowed and owned callers alike without either re-implementing it or
/// paying for a round trip through the other's representation.
pub(crate) fn non_blank<S: AsRef<str>>(value: Option<S>) -> Option<S> {
    value.filter(|text| !text.as_ref().trim().is_empty())
}

#[cfg(test)]
#[path = "accname_tests.rs"]
mod tests;
