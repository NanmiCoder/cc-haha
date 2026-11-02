use super::*;
use crate::commands::get::{self, GetArgs, GetProperty};

fn get_property(
    snapshot: &str,
    adapter: &dyn PlatformAdapter,
    property: GetProperty,
) -> Result<Value, AppError> {
    get::execute(
        GetArgs {
            ref_id: format!("@{snapshot}:e1"),
            property,
        },
        adapter,
        &CommandContext::default(),
    )
}

#[test]
fn get_states_and_is_checked_agree_after_both_live_transitions() {
    let _guard = HomeGuard::new();
    for (saved, live, expected) in [
        (vec![], vec![state::CHECKED.into()], true),
        (vec![state::CHECKED.into()], vec![], false),
    ] {
        let snapshot = save_entry(entry(saved, None, vec![]));
        let adapter = LiveStateAdapter::with_live(visible_bounds(), live.clone());
        let observed = get_property(&snapshot, &adapter, GetProperty::States).unwrap();
        let checked = execute(
            IsArgs {
                ref_id: format!("@{}:e1", snapshot),
                property: IsProperty::Checked,
            },
            &adapter,
            &CommandContext::default(),
        )
        .unwrap();
        assert_eq!(observed["value"], json!(live));
        assert_eq!(checked["result"], expected);
    }
}

#[test]
fn get_bounds_reads_the_resolved_elements_current_geometry() {
    let _guard = HomeGuard::new();
    let mut saved = entry(vec![], None, vec![]);
    saved.geometry.bounds = Some(Rect {
        x: 90.0,
        ..visible_bounds()
    });
    saved.geometry.bounds_hash = saved
        .geometry
        .bounds
        .and_then(|bounds| bounds.bounds_hash());
    let snapshot = save_entry(saved);
    let adapter = LiveStateAdapter::with_live(visible_bounds(), vec![]);
    let observed = get_property(&snapshot, &adapter, GetProperty::Bounds).unwrap();
    assert_eq!(observed["value"], json!(visible_bounds()));
}

#[test]
fn unsupported_live_reads_preserve_existing_is_fallback_contract() {
    let _guard = HomeGuard::new();
    let snapshot = save_entry(entry(vec![state::CHECKED.into()], None, vec![]));
    let adapter = LiveStateAdapter::without_live_support();
    let observed = get_property(&snapshot, &adapter, GetProperty::States).unwrap();
    assert_eq!(observed["value"], json!([state::CHECKED]));
    assert_eq!(
        get_property(&snapshot, &adapter, GetProperty::Bounds).unwrap()["value"],
        Value::Null
    );
}

struct FailedLiveRead;

impl ObservationOps for FailedLiveRead {
    fn get_live_value(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<String>, AdapterError> {
        Err(AdapterError::timeout("live read failed"))
    }

    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_live_state(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<ElementState>, AdapterError> {
        Err(AdapterError::timeout("live read failed"))
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        Err(AdapterError::timeout("live read failed"))
    }
}

impl ActionOps for FailedLiveRead {}
impl InputOps for FailedLiveRead {}
impl SystemOps for FailedLiveRead {}

#[test]
fn failed_live_reads_never_become_successful_cached_answers() {
    let _guard = HomeGuard::new();
    let snapshot = save_entry(entry(vec![state::CHECKED.into()], None, vec![]));
    for property in [
        GetProperty::States,
        GetProperty::Bounds,
        GetProperty::Text,
        GetProperty::Value,
    ] {
        let error = get_property(&snapshot, &FailedLiveRead, property).unwrap_err();
        assert!(
            matches!(error, AppError::Adapter(error) if error.code == crate::ErrorCode::Timeout)
        );
    }
}

#[test]
fn is_enabled_and_wait_enabled_agree_on_live_evidence() {
    let _guard = HomeGuard::new();
    let saved = entry(vec![], None, vec![]);
    let snapshot = save_entry(saved.clone());
    for enabled in [Some(false), None, Some(true)] {
        let adapter = LiveStateAdapter::with_live(visible_bounds(), vec![]);
        adapter.state.lock().unwrap().as_mut().unwrap().enabled = enabled;
        let result = execute(
            IsArgs {
                ref_id: format!("@{}:e1", snapshot.clone()),
                property: IsProperty::Enabled,
            },
            &adapter,
            &CommandContext::default(),
        )
        .unwrap();
        let wait = crate::commands::wait_predicate::observe(
            &saved,
            &NativeHandle::null(),
            &crate::commands::wait_predicate::ElementPredicate::Enabled,
            &adapter,
            crate::Deadline::standard().unwrap(),
            crate::actionability::StabilityExpectation::strict_hash(None),
        )
        .unwrap();
        assert_eq!(result["applicable"], wait["applicable"]);
        assert_eq!(result["result"], wait["enabled"] == true);
    }
}

#[path = "get_live_value_tests.rs"]
mod live_value_tests;
