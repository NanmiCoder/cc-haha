//! How one read becomes one field in the capture, and what is withheld.
//!
//! Every rule that decides what a value looks like in a committed capture
//! lives here, so widening one of them cannot be done in a place that misses
//! the others.

use agent_desktop_core::LocatorField;
use agent_desktop_windows::tree::properties::{PropertyOutcome, PropertyValue};
use serde_json::{Value, json};

use super::profile_path::redact_paths;

/// Substituted for every run-varying host value, matching the placeholders the
/// earlier committed captures already use.
const REDACTED_PID: &str = "<pid>";
const REDACTED_PROVIDER: &str = "<providerid>";
const REDACTED_PATH: &str = "<userprofile>";

/// Reports an unresolvable target as a structured skip.
///
/// Never a silent empty dump: a capture containing nothing reads as evidence
/// that the tree was empty.
pub fn skipped(reason: &str) -> String {
    json!({ "status": "skipped", "reason": reason }).to_string()
}

/// Replaces every run-varying or host-identifying value in a provider string.
///
/// `ProviderDescription` embeds a process id and a hexadecimal provider id,
/// and a user path can appear in a module path, so the substitution runs
/// before anything reaches the capture file. Each key consumes its **whole**
/// value: a substitution that stops at the first non-digit leaves the tail of
/// a `0x`-prefixed id in the file, which is a leak that reads as redacted.
pub fn normalise(text: &str) -> String {
    let substituted = substitute_after(text, "pid:", REDACTED_PID);
    let substituted = substitute_after(&substituted, "providerId:", REDACTED_PROVIDER);
    redact_paths(&substituted, &profile_roots(), REDACTED_PATH)
}

fn profile_roots() -> Vec<String> {
    let mut roots = ["USERPROFILE", "HOME"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .collect::<Vec<_>>();
    if let (Ok(drive), Ok(path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        roots.push(format!("{drive}{path}"));
    }
    roots
}

fn substitute_after(text: &str, key: &str, replacement: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(key) {
        out.push_str(&rest[..at + key.len()]);
        let value = &rest[at + key.len()..];
        let consumed = value
            .find(|character: char| !(character.is_ascii_alphanumeric()))
            .unwrap_or(value.len());
        if consumed == 0 {
            rest = value;
            continue;
        }
        out.push_str(replacement);
        rest = &value[consumed..];
    }
    out.push_str(rest);
    out
}

pub fn text_of(outcome: &PropertyOutcome) -> Option<String> {
    match outcome {
        PropertyOutcome::Known(PropertyValue::Text(value)) => Some(value.clone()),
        _ => None,
    }
}

pub fn slot(outcome: &PropertyOutcome) -> Value {
    match outcome {
        PropertyOutcome::Known(PropertyValue::Text(value)) => json!(normalise(value)),
        PropertyOutcome::Known(PropertyValue::Flag(value)) => json!(value),
        PropertyOutcome::Known(PropertyValue::Number(value)) => json!(value),
        PropertyOutcome::Known(PropertyValue::Bounds(bounds)) => json!({
            "x": bounds.x, "y": bounds.y, "width": bounds.width, "height": bounds.height
        }),
        PropertyOutcome::Absent => json!("<absent>"),
        PropertyOutcome::Unknown => json!("<unknown>"),
    }
}

/// Records a text slot as presence and length only, never its content.
///
/// **Every free-text property is rendered through this, not only `Name`.**
/// `slot()` renders any `Known(Text(..))` verbatim, so `HelpText`,
/// `FullDescription` and any `LegacyIAccessible` string would land in a
/// committed capture as literal text read out of somebody's real application.
/// Only `ClassName` and the provider description are deliberately rendered
/// verbatim through `slot()`.
pub fn text_presence(outcome: &PropertyOutcome) -> Value {
    match text_of(outcome) {
        Some(value) => json!({ "present": true, "chars": value.chars().count() }),
        None => json!({ "present": false, "outcome": slot(outcome) }),
    }
}

/// The evidence field's own presence, taken from the resolved slot rather than
/// from a raw property, so it reports what a consumer would actually receive.
pub fn field_presence(field: &LocatorField<String>) -> Value {
    match field {
        LocatorField::Known(value) => json!({ "present": true, "chars": value.chars().count() }),
        LocatorField::Absent => json!({ "present": false, "outcome": "<absent>" }),
        LocatorField::Unknown => json!({ "present": false, "outcome": "<unknown>" }),
    }
}

/// Renders a resolved evidence slot, keeping the tri-state visible.
///
/// `Absent` and `Unknown` are rendered as distinct markers rather than both
/// collapsing to an empty value, because that difference is the whole point of
/// the slot: `Absent` is the provider answering, `Unknown` is a read that
/// failed. A census that showed them the same way would hide exactly the
/// distinction it exists to report.
///
/// This and [`role_of`] are the same three arms over different payloads. One
/// generic function would need a `Serialize` bound, and `serde` is not a
/// dependency of this crate - widening a shipped crate's dependency surface to
/// collapse six lines of dev tooling is the worse trade.
pub fn field_list(field: &LocatorField<Vec<String>>) -> Value {
    match field {
        LocatorField::Known(values) => json!(values),
        LocatorField::Absent => json!("<absent>"),
        LocatorField::Unknown => json!("<unknown>"),
    }
}

pub fn role_of(field: &LocatorField<String>) -> Value {
    match field {
        LocatorField::Known(role) => json!(role),
        LocatorField::Absent => json!("<absent>"),
        LocatorField::Unknown => json!("<unknown>"),
    }
}

/// Regression gate for the redaction rule this module exists to enforce.
///
/// These prove `text_presence`/`field_presence` themselves withhold their
/// input. The other half of the rule - that `render_node` in `render.rs`
/// calls the withholding renderer rather than `slot()` for each text-bearing
/// property - is gated separately, by `render_node_tests.rs`: a revert there
/// of `automation_id`, `help_text`, `full_description`, `legacy_default_action`,
/// `name`, or `description` back to a verbatim renderer fails that test.
#[cfg(test)]
#[path = "render_slots_tests.rs"]
mod tests;
