use super::*;
use crate::tree::fixture::bootstrap;
use crate::tree::fixture::{CONTENT_MARKER, HostedFixture, SECURE_MARKER};
use crate::tree::properties::read_cached;
use uiautomation::UIElement;

fn walk_children(handle: isize) -> Vec<crate::tree::element::UIAElement> {
    let root = crate::tree::automation::root_from_hwnd(
        handle,
        agent_desktop_core::Deadline::standard().expect("a standard deadline"),
    )
    .expect("the fixture window resolves");
    let client = crate::tree::automation::automation_client().expect("a UIA client");
    let walker = client
        .get_raw_view_walker()
        .expect("the raw view walker is available");
    let mut children: Vec<UIElement> = Vec::new();
    if let Ok(mut current) = walker.get_first_child(&root.0) {
        loop {
            let next = walker.get_next_sibling(&current);
            children.push(current);
            match next {
                Ok(sibling) => current = sibling,
                Err(_) => break,
            }
        }
    }
    children
        .into_iter()
        .map(crate::tree::element::UIAElement::from)
        .collect()
}

/// The gate asserted against a real out-of-process provider, not only
/// against the projection: text typed into the fixture's `ES_PASSWORD`
/// control must appear in no read outcome for `Value`, `Name` or
/// `HelpText`.
#[test]
fn secure_content_never_reaches_a_read_outcome_from_a_live_provider() {
    bootstrap();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let children = walk_children(fixture.handle());

    let secure = children
        .iter()
        .map(|child| read_live(child).0)
        .find(ElementProperties::is_secure)
        .expect("the fixture exposes a control reporting IsPassword");

    for property in TreeProperty::VALUE_BEARING {
        let rendered = format!("{:?}", secure.get(property));
        assert!(
            !rendered.contains(SECURE_MARKER),
            "{} leaked secure content",
            property.as_str()
        );
        assert_eq!(secure.get(property), PropertyOutcome::Absent);
    }
}

#[test]
fn a_live_read_distinguishes_present_content_from_an_unimplemented_property() {
    bootstrap();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let children = walk_children(fixture.handle());
    let all: Vec<ElementProperties> = children.iter().map(|child| read_live(child).0).collect();

    assert!(
        all.iter().any(|properties| matches!(
            properties.get(TreeProperty::Value),
            PropertyOutcome::Known(PropertyValue::Text(ref value)) if value.contains(CONTENT_MARKER)
        )),
        "a plain control's content must read back as Known"
    );
    assert!(
        all.iter().any(|properties| matches!(
            properties.get(TreeProperty::AutomationId),
            PropertyOutcome::Known(_) | PropertyOutcome::Absent
        )),
        "an unimplemented property must classify Absent, never Unknown"
    );
    assert!(
        all.iter().all(|properties| !matches!(
            properties.get(TreeProperty::ClassName),
            PropertyOutcome::Unknown
        )),
        "a readable property must never classify Unknown on a healthy provider"
    );
}

/// A14-9: once the host process exits, the client-side HWND proxy answers
/// property reads locally with an empty string rather than failing, so
/// process death is no more detectable through a property read than
/// through the sibling terminator (A14-4).
///
/// The guarantee actually made is asserted instead, and it is the one
/// that matters downstream: a provider that went away is never reported
/// as a provider that does not implement the property. `Absent` feeds
/// completeness gating as a legitimate answer; fabricating it here would
/// let a dead target satisfy `EvidenceRequirements` it never answered.
#[test]
fn a_read_after_the_provider_exits_never_fabricates_absent() {
    bootstrap();
    let mut fixture = HostedFixture::spawn().expect("the fixture host starts");
    let children = walk_children(fixture.handle());
    assert!(!children.is_empty(), "the fixture exposes child controls");

    fixture.terminate();
    std::thread::sleep(std::time::Duration::from_millis(750));

    let (properties, _) = read_live(&children[0]);

    for property in [
        TreeProperty::ClassName,
        TreeProperty::Name,
        TreeProperty::Value,
    ] {
        assert_ne!(
            properties.get(property),
            PropertyOutcome::Absent,
            "a provider that went away must not be reported as not implementing {}",
            property.as_str()
        );
    }
}

/// Pins the fix that keeps a deadline-truncated bounded read from opening the
/// secure-field gate: `read_with` used to `continue` past a truncated
/// property without recording anything, so once the deadline expired before
/// `IsPassword` was reached, its entry was missing from the read set
/// entirely rather than present as `Unknown` - and `ElementProperties::
/// from_reads` treats a missing `IsPassword` entry exactly like a read set
/// that never requested the property at all, defaulting `is_secure()` to
/// `false`. An already-expired deadline forces every property past `Name` to
/// truncate, so this exercises the real production path
/// (`properties::read_live_bounded`) rather than a hand-built read set:
/// `is_secure()` must still come back `true`, and nothing on the element
/// must read back as a genuine, un-withheld answer.
#[test]
fn a_deadline_truncated_bounded_read_still_closes_the_secure_gate() {
    bootstrap();
    let client = crate::tree::automation::automation_client().expect("a UIA client");
    let root: crate::tree::element::UIAElement = client
        .get_root_element()
        .expect("the desktop root element is available")
        .into();

    let expired = agent_desktop_core::Deadline::after(1).expect("a short deadline");
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert!(
        expired.is_expired(),
        "the deadline must already be expired before the bounded read runs"
    );

    let (properties, errors) = read_live_bounded(&root, expired);

    assert!(
        !errors.is_empty(),
        "a fully truncated read must surface the deadline's own timeout"
    );
    assert!(
        properties.is_secure(),
        "a deadline-truncated IsPassword read must fail closed rather than default the gate open"
    );
    for property in TreeProperty::VALUE_BEARING {
        assert_eq!(
            properties.get(property),
            PropertyOutcome::Unknown,
            "{} must stay unread rather than fabricate an answer",
            property.as_str()
        );
    }
}

/// The failure branch, forced deterministically rather than by killing a
/// process: a property the cache request never carried cannot be answered,
/// and must classify `Unknown` with a structured error.
#[test]
fn a_read_that_genuinely_fails_classifies_unknown_and_never_absent() {
    bootstrap();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let root = crate::tree::automation::root_from_hwnd(
        fixture.handle(),
        agent_desktop_core::Deadline::standard().expect("a standard deadline"),
    )
    .expect("the fixture window resolves");
    let client = crate::tree::automation::automation_client().expect("a UIA client");
    let request = client
        .create_cache_request()
        .expect("an empty cache request builds");
    request
        .set_element_mode(uiautomation::types::ElementMode::Full)
        .expect("the element mode is settable");
    let sparse = root
        .0
        .build_updated_cache(&request)
        .map(crate::tree::element::UIAElement::from)
        .expect("an element with an empty cache");

    let (properties, errors) = read_cached(&sparse);

    assert!(
        !errors.is_empty(),
        "a read that cannot be answered must surface a structured error"
    );
    assert_eq!(
        properties.get(TreeProperty::ClassName),
        PropertyOutcome::Unknown
    );
    assert_ne!(
        properties.get(TreeProperty::ClassName),
        PropertyOutcome::Absent
    );
}

/// The live-provider form of the secure-field scenario, rather than a synthetic
/// error: a failed read on a control whose text *is* a unique marker must
/// produce an error carrying none of it.
///
/// The failure is forced deterministically with an empty cache request, so
/// the element is real, its text is real, and the read genuinely cannot be
/// answered. `ref_action.rs` clones message and details into session JSONL
/// and the trace HTML export, so a leak here is persisted, not transient.
#[test]
fn a_failed_read_on_a_marker_bearing_control_leaks_none_of_it() {
    bootstrap();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let client = crate::tree::automation::automation_client().expect("a UIA client");
    let request = client
        .create_cache_request()
        .expect("an empty cache request builds");
    request
        .set_element_mode(uiautomation::types::ElementMode::Full)
        .expect("the element mode is settable");

    let marked = walk_children(fixture.handle())
        .into_iter()
        .find(|child| {
            matches!(
                read_live(child).0.get(TreeProperty::Value),
                PropertyOutcome::Known(PropertyValue::Text(ref value))
                    if value.contains(CONTENT_MARKER)
            )
        })
        .expect("the fixture exposes a control carrying the marker");
    let uncacheable = marked
        .0
        .build_updated_cache(&request)
        .map(crate::tree::element::UIAElement::from)
        .expect("the same element with an empty cache");

    let (_, errors) = read_cached(&uncacheable);

    assert!(!errors.is_empty(), "the read must genuinely have failed");
    for error in errors {
        let rendered = format!(
            "{}|{}|{}",
            error.message,
            error.platform_detail.unwrap_or_default(),
            serde_json::to_string(&error.details).unwrap_or_default()
        );
        assert!(
            !rendered.contains(CONTENT_MARKER),
            "a failed read leaked the control's text: {rendered}"
        );
    }
}
