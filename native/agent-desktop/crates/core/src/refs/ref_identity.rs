use crate::{
    IdentityMatch,
    locator::live_locator::{IdentifierEvidence, LocatorField},
    refs::RefEntry,
    tree::roles::is_mutable_value_role,
};

pub fn has_meaningful_identity(entry: &RefEntry) -> bool {
    if entry.identity.retained_object.is_some() {
        return true;
    }
    entry.identity.native_id.as_ref().is_some_and(|identifier| {
        crate::tree::accname::non_blank(Some(identifier.value.as_str())).is_some()
    }) || has_stable_text_identity(entry)
}

pub fn has_stable_text_identity(entry: &RefEntry) -> bool {
    stable_name(
        entry.identity.role.as_str(),
        entry.identity.name.as_deref(),
        entry.identity.value.as_deref(),
    )
    .is_some()
        || stable_value(
            entry.identity.role.as_str(),
            entry.identity.value.as_deref(),
        )
        .is_some()
        || crate::tree::accname::non_blank(entry.identity.description.as_deref()).is_some()
}

/// Whether an element's own identifier or stable text identifies it, ignoring
/// any retained object. A platform that can only retain a positional object
/// path must not present that path as identity evidence for a node its
/// identifier or text already names, because the path moves when the siblings
/// are reordered.
pub fn identity_fields_are_meaningful(
    role: &str,
    name: Option<&str>,
    value: Option<&str>,
    description: Option<&str>,
    native_id: Option<&str>,
) -> bool {
    crate::tree::accname::non_blank(native_id).is_some()
        || stable_name(role, name, value).is_some()
        || stable_value(role, value).is_some()
        || crate::tree::accname::non_blank(description).is_some()
}

pub fn identity_match(
    entry: &RefEntry,
    actual_name: &LocatorField<String>,
    actual_value: &LocatorField<String>,
    actual_description: &LocatorField<String>,
    actual_identifiers: &IdentifierEvidence,
) -> IdentityMatch {
    if let Some(expected) = entry.identity.retained_object.as_deref() {
        return match (
            crate::tree::accname::non_blank(Some(expected)),
            actual_identifiers.retained_object(),
        ) {
            (Some(expected), Some(actual)) => equality_match(expected, actual),
            _ => IdentityMatch::Unknown,
        };
    }
    if let Some(expected) = entry.identity.native_id.as_ref() {
        let Some(expected_value) = crate::tree::accname::non_blank(Some(expected.value.as_str()))
        else {
            return IdentityMatch::Unknown;
        };
        if actual_identifiers
            .identifiers()
            .iter()
            .any(|actual| actual.kind == expected.kind && actual.value == expected_value)
        {
            return IdentityMatch::Match;
        }
        if !actual_identifiers.is_complete() {
            return IdentityMatch::Unknown;
        }
        return IdentityMatch::NoMatch;
    }

    stable_text_match(entry, actual_name, actual_value, actual_description)
}

#[cfg(test)]
pub(crate) fn identity_matches(
    entry: &RefEntry,
    actual_name: Option<&str>,
    actual_value: Option<&str>,
    actual_description: Option<&str>,
    actual_native_id: Option<&str>,
) -> bool {
    let actual_name = option_field(actual_name);
    let actual_value = option_field(actual_value);
    let actual_description = option_field(actual_description);
    let identifiers = IdentifierEvidence::typed(
        actual_native_id
            .into_iter()
            .map(|value| crate::ElementIdentifier {
                kind: crate::IdentifierKind::AxIdentifier,
                value: value.to_string(),
            }),
        actual_native_id.map(|_| 0),
        true,
    );
    identity_match(
        entry,
        &actual_name,
        &actual_value,
        &actual_description,
        &identifiers,
    ) == IdentityMatch::Match
}

/// Whether one element's stable text carves a live identity that can refute
/// or corroborate the stored one.
///
/// Public because the Windows resolver composes it with `identity_match` to
/// keep its AutomationId-first corroboration rule: an id that still resolves
/// onto a candidate whose stable text drifted must be refuted, the A7-3
/// wrong-target shape. macOS consumes only `identity_match`, which already
/// routes id-less entries here; Windows runs the corroboration tier itself.
pub fn stable_text_match(
    entry: &RefEntry,
    actual_name: &LocatorField<String>,
    actual_value: &LocatorField<String>,
    actual_description: &LocatorField<String>,
) -> IdentityMatch {
    let expected_name = stable_name(
        entry.identity.role.as_str(),
        entry.identity.name.as_deref(),
        entry.identity.value.as_deref(),
    );
    let expected_value = stable_value(
        entry.identity.role.as_str(),
        entry.identity.value.as_deref(),
    );
    let expected_description =
        crate::tree::accname::non_blank(entry.identity.description.as_deref());
    let actual_name = stable_name_field(entry.identity.role.as_str(), actual_name, actual_value);
    let actual_value = stable_value_field(entry.identity.role.as_str(), actual_value);
    let actual_description = meaningful_field(actual_description);

    if let Some(expected) = expected_name {
        return match_primary_identity(expected, actual_name, actual_value);
    }
    if let Some(expected) = expected_value {
        return match_primary_identity(expected, actual_value, actual_name);
    }
    if let Some(expected) = expected_description {
        return match_primary_identity(expected, actual_description, actual_name);
    }
    if is_mutable_value_role(entry.identity.role.as_str()) {
        return IdentityMatch::Unknown;
    }
    empty_identity_match([actual_name, actual_value, actual_description])
}

fn match_primary_identity(
    expected: &str,
    actual_primary: LocatorField<&str>,
    actual_fallback: LocatorField<&str>,
) -> IdentityMatch {
    match actual_primary {
        LocatorField::Known(actual) => equality_match(expected, actual),
        LocatorField::Unknown => IdentityMatch::Unknown,
        LocatorField::Absent => match actual_fallback {
            LocatorField::Known(actual) => equality_match(expected, actual),
            LocatorField::Unknown => IdentityMatch::Unknown,
            LocatorField::Absent => IdentityMatch::NoMatch,
        },
    }
}

fn equality_match(expected: &str, actual: &str) -> IdentityMatch {
    if actual == expected {
        IdentityMatch::Match
    } else {
        IdentityMatch::NoMatch
    }
}

fn empty_identity_match(fields: [LocatorField<&str>; 3]) -> IdentityMatch {
    if fields.iter().any(LocatorField::is_unknown) {
        return IdentityMatch::Unknown;
    }
    if fields
        .iter()
        .any(|field| matches!(field, LocatorField::Known(_)))
    {
        IdentityMatch::NoMatch
    } else {
        IdentityMatch::Unknown
    }
}

#[cfg(test)]
fn option_field(value: Option<&str>) -> LocatorField<String> {
    value
        .map(str::to_string)
        .map(LocatorField::Known)
        .unwrap_or(LocatorField::Absent)
}

fn meaningful_field(field: &LocatorField<String>) -> LocatorField<&str> {
    match field {
        LocatorField::Known(value) => crate::tree::accname::non_blank(Some(value.as_str()))
            .map(LocatorField::Known)
            .unwrap_or(LocatorField::Absent),
        LocatorField::Absent => LocatorField::Absent,
        LocatorField::Unknown => LocatorField::Unknown,
    }
}

fn stable_name_field<'a>(
    role: &str,
    name: &'a LocatorField<String>,
    value: &LocatorField<String>,
) -> LocatorField<&'a str> {
    let name = meaningful_field(name);
    if !is_mutable_value_role(role) {
        return name;
    }
    let LocatorField::Known(name) = name else {
        return name;
    };
    match meaningful_field(value) {
        LocatorField::Known(value) if value_matches_name(Some(value), name) => LocatorField::Absent,
        LocatorField::Known(_) | LocatorField::Absent => LocatorField::Known(name),
        LocatorField::Unknown => LocatorField::Unknown,
    }
}

fn stable_value_field<'a>(role: &str, value: &'a LocatorField<String>) -> LocatorField<&'a str> {
    if is_mutable_value_role(role) {
        LocatorField::Absent
    } else {
        meaningful_field(value)
    }
}

fn stable_name<'a>(role: &str, name: Option<&'a str>, value: Option<&str>) -> Option<&'a str> {
    let name = crate::tree::accname::non_blank(name)?;
    if is_mutable_value_role(role)
        && value_matches_name(crate::tree::accname::non_blank(value), name)
    {
        None
    } else {
        Some(name)
    }
}

fn stable_value<'a>(role: &str, value: Option<&'a str>) -> Option<&'a str> {
    (!is_mutable_value_role(role))
        .then(|| crate::tree::accname::non_blank(value))
        .flatten()
}

fn value_matches_name(value: Option<&str>, name: &str) -> bool {
    value == Some(name)
        || numeric_text(value)
            .zip(numeric_text(Some(name)))
            .is_some_and(|(value, name)| value == name)
}

fn numeric_text(value: Option<&str>) -> Option<f64> {
    value
        .and_then(|text| text.parse::<f64>().ok())
        .filter(|number| number.is_finite())
}

#[cfg(test)]
#[path = "ref_identity_tests.rs"]
mod tests;
