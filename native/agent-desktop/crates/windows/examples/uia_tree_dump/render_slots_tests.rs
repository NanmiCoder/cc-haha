use super::*;

const MARKER: &str = "ZZ-CENSUS-LEAK-MARKER-do-not-serialize-1234567";

#[test]
fn text_presence_never_renders_the_value() {
    let outcome = PropertyOutcome::Known(PropertyValue::Text(MARKER.to_string()));

    let rendered = text_presence(&outcome);

    assert!(
        !rendered.to_string().contains(MARKER),
        "text_presence leaked its input: {rendered}"
    );
    assert_eq!(
        rendered,
        json!({ "present": true, "chars": MARKER.chars().count() })
    );
}

#[test]
fn field_presence_never_renders_the_value() {
    let field = LocatorField::Known(MARKER.to_string());

    let rendered = field_presence(&field);

    assert!(
        !rendered.to_string().contains(MARKER),
        "field_presence leaked its input: {rendered}"
    );
    assert_eq!(
        rendered,
        json!({ "present": true, "chars": MARKER.chars().count() })
    );
}

/// A realistic `ProviderDescription`, in the shape the in-box providers
/// publish it: a decimal process id, a hexadecimal provider id, and a
/// module path under the running user's profile.
const PROVIDER_DESCRIPTION: &str = concat!(
    "[pid:4812,providerId:0x1A2B3C hwnd:0x90210 ",
    "Main(parent link):Microsoft: MSAA Proxy (unmanaged:C:",
    r"\Users\devbox\app\uiautomationcore.dll)]"
);

/// The whole substituted value is consumed, not the leading run of digits.
///
/// A substitution that stops at the first non-digit leaves the tail of a
/// `0x`-prefixed id in the capture - `providerId:<providerid>x1A2B3C` - and
/// that reads as redacted while still identifying the host. Asserting only
/// that the placeholder appears is exactly the prefix-shaped check that
/// would accept it, so the host values themselves are asserted absent.
#[test]
fn normalise_consumes_the_whole_value_of_every_host_identifier() {
    let normalised = normalise(PROVIDER_DESCRIPTION);

    for leaked in ["4812", "1A2B3C", "0x1A2B3C", "x1A2B3C", "devbox"] {
        assert!(
            !normalised.contains(leaked),
            "{leaked} survived redaction: {normalised}"
        );
    }
    assert!(
        normalised.contains(REDACTED_PID)
            && normalised.contains(REDACTED_PROVIDER)
            && normalised.contains(REDACTED_PATH),
        "each rule must leave its placeholder behind: {normalised}"
    );
}

/// The control that makes the assertions above discriminate: the input
/// really does carry the values, so a `normalise` that returned its input
/// unchanged would fail rather than pass for want of anything to redact.
#[test]
fn the_redaction_input_carries_the_values_it_is_asserted_to_lose() {
    for present in ["pid:4812", "providerId:0x1A2B3C", r"\Users\devbox\"] {
        assert!(
            PROVIDER_DESCRIPTION.contains(present),
            "{present} is missing from the fixture, so redacting it proves nothing"
        );
    }
}

/// A provider chain: one entry per provider, each with its own process id,
/// its own provider id and its own module path under a user profile. The
/// second user name is the value a first-occurrence rule commits verbatim.
const PROVIDER_CHAIN: &str = concat!(
    "[pid:4812,providerId:0x1A2B3C hwnd:0x90210 ",
    "Main(parent link):Microsoft: MSAA Proxy (unmanaged:C:",
    r"\Users\devbox\app\uiautomationcore.dll); ",
    "pid:991,providerId:0xFEED ",
    "Nonclient:Microsoft: Non-Client Proxy (unmanaged:D:",
    r"\Users\buildbot\host\uiautomationcore.dll)]"
);

/// No rule here is a first-occurrence rule. Every host value in the chain
/// is redacted, including the *second* module path: a `redact_paths` that
/// substituted only the first `\users\` would leave the later user name in
/// a committed capture while the placeholder already present made the
/// value read as redacted.
#[test]
fn every_substitution_redacts_each_occurrence_not_only_the_first() {
    let normalised = normalise(PROVIDER_CHAIN);

    for leaked in ["4812", "991", "FEED", "1A2B3C", "devbox", "buildbot"] {
        assert!(
            !normalised.contains(leaked),
            "a later occurrence of {leaked} survived: {normalised}"
        );
    }
    assert_eq!(
        normalised.matches(REDACTED_PATH).count(),
        2,
        "each profile path in the chain leaves its own placeholder: {normalised}"
    );
}

#[test]
fn normalise_redacts_forward_slash_user_profiles() {
    let provider = concat!(
        "first:C:/Users/DevUser/App/a.dll; ",
        "second:d:/USERS/BuildUser/Host/b.dll"
    );

    let normalised = normalise(provider);

    assert!(!normalised.contains("DevUser"), "{normalised}");
    assert!(!normalised.contains("BuildUser"), "{normalised}");
    assert_eq!(normalised.matches(REDACTED_PATH).count(), 2, "{normalised}");
}

/// The control for the chain fixture: it really does carry two distinct
/// user names, so asserting the second one absent proves the loop rather
/// than passing for want of a second path.
#[test]
fn the_chain_input_carries_two_distinct_user_paths() {
    for present in [r"\Users\devbox\", r"\Users\buildbot\"] {
        assert!(
            PROVIDER_CHAIN.contains(present),
            "{present} is missing from the chain fixture, so redacting it proves nothing"
        );
    }
}

/// A string carrying none of the host values is returned intact, so the
/// rules cannot pass the tests above by deleting text indiscriminately.
#[test]
fn a_string_with_nothing_to_redact_is_unchanged() {
    let harmless = "Main(parent link):Windows Presentation Foundation";
    assert_eq!(normalise(harmless), harmless);
}

#[test]
fn text_presence_keeps_absent_and_unknown_distinct() {
    let absent = text_presence(&PropertyOutcome::Absent);
    let unknown = text_presence(&PropertyOutcome::Unknown);

    assert_ne!(absent, unknown);
    assert_eq!(absent, json!({ "present": false, "outcome": "<absent>" }));
    assert_eq!(unknown, json!({ "present": false, "outcome": "<unknown>" }));
}

#[test]
fn field_presence_keeps_absent_and_unknown_distinct() {
    let absent = field_presence(&LocatorField::Absent);
    let unknown = field_presence(&LocatorField::Unknown);

    assert_ne!(absent, unknown);
    assert_eq!(absent, json!({ "present": false, "outcome": "<absent>" }));
    assert_eq!(unknown, json!({ "present": false, "outcome": "<unknown>" }));
}
