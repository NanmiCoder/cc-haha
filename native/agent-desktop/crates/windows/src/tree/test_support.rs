//! Small, generic test builders shared across otherwise-unrelated test
//! modules - too broadly useful to belong to any one of them, and too small
//! to be worth re-typing in each.

use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::{ElementProperties, PropertyOutcome, PropertyValue};
#[cfg(target_os = "windows")]
use agent_desktop_core::NativeHandle;

/// Builds an `ElementProperties` from an explicit read set, the way every
/// producer test stages one node's evidence.
pub(crate) fn props(reads: &[(TreeProperty, PropertyOutcome)]) -> ElementProperties {
    ElementProperties::from_reads(reads.to_vec())
}

pub(crate) fn flag(property: TreeProperty, value: bool) -> (TreeProperty, PropertyOutcome) {
    (property, PropertyOutcome::Known(PropertyValue::Flag(value)))
}

pub(crate) fn number(property: TreeProperty, value: i32) -> (TreeProperty, PropertyOutcome) {
    (
        property,
        PropertyOutcome::Known(PropertyValue::Number(value)),
    )
}

pub(crate) fn text(value: &str) -> PropertyOutcome {
    PropertyOutcome::Known(PropertyValue::Text(value.into()))
}

/// A handle no resolved attempt should ever reach - the retry loop's own
/// tests use it to prove a classification without a live provider.
#[cfg(target_os = "windows")]
pub(crate) fn unreachable_handle() -> NativeHandle {
    NativeHandle::new(())
}

/// Asserts that no non-doc line of any `(name, source)` pair satisfies
/// `is_banned`, skipping `///`/`//!` prose so a comment describing the ban is
/// never mistaken for a violation of it.
pub(crate) fn assert_source_forbids(sources: &[(&str, &str)], is_banned: impl Fn(&str) -> bool) {
    for (name, source) in sources {
        for (number, line) in source.lines().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("///") || trimmed.starts_with("//!") {
                continue;
            }
            assert!(
                !is_banned(line),
                "{name}:{} carries a banned token: {line}",
                number + 1
            );
        }
    }
}

/// The `WindowInfo` every fixture-backed test builds for a `HostedFixture`:
/// its live pid and process generation, and the fixed title/app the fixture
/// process always reports.
#[cfg(target_os = "windows")]
pub(crate) fn fixture_window(
    fixture: &crate::tree::fixture::HostedFixture,
) -> agent_desktop_core::WindowInfo {
    let pid = agent_desktop_core::ProcessId::new(fixture.process_id());
    let token = crate::system::process_identity::token_for_pid(pid)
        .unwrap()
        .expect("a live fixture process has a token");
    agent_desktop_core::WindowInfo {
        id: format!("w-{}", fixture.handle()),
        title: "agent-desktop fixture".into(),
        app: "fixture.exe".into(),
        pid,
        process_instance: Some(token),
        bounds: None,
        state: Default::default(),
    }
}

/// How many children UI Automation reports directly under a rooted surface -
/// the same `find_all(TreeScope::Children, true_condition)` a `list-surfaces`
/// caller issues, so a test can pin the count independent of the walk.
#[cfg(target_os = "windows")]
pub(crate) fn rooted_child_count(root: &crate::tree::element::UIAElement) -> usize {
    use uiautomation::types::TreeScope;

    let client = crate::tree::automation::automation_client().expect("client");
    let condition = client.create_true_condition().expect("condition");
    root.0
        .find_all(TreeScope::Children, &condition)
        .expect("the rooted surface's children")
        .len()
}
