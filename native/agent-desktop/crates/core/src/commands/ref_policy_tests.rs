use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    Action, AdapterError, Direction,
    actions::action_request::ActionRequest,
    actions::action_result::ActionResult,
    actions::interaction_policy::InteractionPolicy,
    adapter::NativeHandle,
    commands::{
        check, clear, click, collapse, double_click, expand, focus, helpers::RefArgs, right_click,
        scroll, scroll_to, select, set_value, toggle, triple_click, type_text, uncheck,
    },
    context::CommandContext,
    refs::refs_store::RefStore,
    refs::refs_test_support::HomeGuard,
    refs::{RefEntry, RefMap},
};
use std::sync::Mutex;

/// Every command module stem whose execute function calls `context.request_base(`.
/// Adding a new ref-action command requires adding its stem here; the
/// `every_ref_action_command_is_registered_in_the_policy_list` guard enforces this.
const POLICY_TESTED_COMMANDS: &[&str] = &[
    "check",
    "clear",
    "click",
    "collapse",
    "double_click",
    "expand",
    "focus",
    "press",
    "right_click",
    "scroll",
    "scroll_to",
    "select",
    "set_value",
    "toggle",
    "triple_click",
    "type_text",
    "type_text_interval",
    "uncheck",
];

struct RecordingAdapter {
    requests: Mutex<Vec<ActionRequest>>,
}

impl RecordingAdapter {
    fn new() -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
        }
    }

    fn last_request(&self) -> ActionRequest {
        self.requests.lock().unwrap().last().cloned().unwrap()
    }
}

impl ObservationOps for RecordingAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    crate::adapter::complete_live_observation!(
        "textfield",
        "Target",
        [
            crate::actions::capability::CLICK,
            crate::actions::capability::RIGHT_CLICK,
            crate::actions::capability::SET_VALUE,
            crate::actions::capability::SET_FOCUS,
            crate::actions::capability::EXPAND,
            crate::actions::capability::COLLAPSE,
            crate::actions::capability::SELECT,
            crate::actions::capability::TOGGLE,
            crate::actions::capability::SCROLL,
            crate::actions::capability::SCROLL_TO,
            crate::actions::capability::TYPE_TEXT,
        ],
        adapter => crate::adapter::recorded_action_state(&adapter.requests.lock().unwrap())
    );

    fn get_text_selection(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<std::ops::Range<usize>>, AdapterError> {
        let len = crate::adapter::recorded_action_state(&self.requests.lock().unwrap())
            .value
            .unwrap_or_default()
            .encode_utf16()
            .count();
        Ok(Some(0..len))
    }
}

impl ActionOps for RecordingAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        self.requests.lock().unwrap().push(request);
        Ok(ActionResult::delivered_unverified("ok"))
    }
}

impl InputOps for RecordingAdapter {}

impl SystemOps for RecordingAdapter {
    crate::adapter::guarded_interaction_lease!();
    crate::adapter::exact_window_focus!();
}

fn snapshot_id() -> String {
    let mut refmap = RefMap::new();
    let bounds = crate::Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    refmap.allocate(RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "textfield".into(),
            name: Some("Target".into()),
            value: None,
            description: None,
            native_id: None,
        },
        geometry: crate::RefGeometry {
            bounds_space: None,
            bounds: Some(bounds),
            bounds_hash: bounds.bounds_hash(),
        },
        capabilities: crate::RefCapabilities {
            states: vec![],
            available_actions: vec![
                "Check".into(),
                "Clear".into(),
                "Click".into(),
                "Collapse".into(),
                "DoubleClick".into(),
                "Expand".into(),
                "RightClick".into(),
                "Scroll".into(),
                "ScrollTo".into(),
                "Select".into(),
                "SetFocus".into(),
                "SetValue".into(),
                "Toggle".into(),
                "TripleClick".into(),
                "TypeText".into(),
                "Uncheck".into(),
            ],
        },
        source: crate::RefSource {
            source_app: Some("Fixture".into()),
            source_window_id: Some("w-1".into()),
            source_window_title: Some("Fixture".into()),
            source_window_bounds_hash: None,
            source_surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    });
    RefStore::new().unwrap().save_new_snapshot(&refmap).unwrap()
}

fn ref_args(snapshot_id: &str) -> RefArgs {
    RefArgs {
        ref_id: format!("@{}:e1", snapshot_id.to_owned()),
        timeout_ms: None,
    }
}

fn assert_headless(request: &ActionRequest) {
    assert_eq!(request.policy, InteractionPolicy::headless());
}

#[test]
fn default_ref_commands_use_least_permissive_supported_policy() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_id();
    let adapter = RecordingAdapter::new();
    let context = CommandContext::default();

    click::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    let double_click_error =
        double_click::execute(ref_args(&snapshot_id), &adapter, &context).unwrap_err();
    assert_eq!(double_click_error.code(), "POLICY_DENIED");
    let triple_click_error =
        triple_click::execute(ref_args(&snapshot_id), &adapter, &context).unwrap_err();
    assert_eq!(triple_click_error.code(), "POLICY_DENIED");
    let before_right_click = adapter.requests.lock().unwrap().len();
    let _ = right_click::execute(ref_args(&snapshot_id), &adapter, &context);
    assert_eq!(
        adapter.requests.lock().unwrap().len(),
        before_right_click + 1
    );
    clear::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    toggle::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    check::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    uncheck::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    expand::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    collapse::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    scroll_to::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    set_value::execute(
        set_value::SetValueArgs {
            ref_id: format!("@{}:e1", snapshot_id.clone()),
            value: "value".into(),
            timeout_ms: None,
        },
        &adapter,
        &context,
    )
    .unwrap();
    select::execute(
        select::SelectArgs {
            ref_id: format!("@{}:e1", snapshot_id.clone()),
            value: "choice".into(),
            timeout_ms: None,
        },
        &adapter,
        &context,
    )
    .unwrap();
    let before_type = adapter.requests.lock().unwrap().len();
    type_text::execute(
        type_text::TypeArgs {
            ref_id: format!("@{}:e1", snapshot_id.clone()),
            text: "text".into(),
            timeout_ms: None,
            interval_ms: None,
        },
        &adapter,
        &context,
    )
    .unwrap();
    let type_request = adapter.requests.lock().unwrap()[before_type].clone();
    assert_eq!(type_request.policy, InteractionPolicy::headless());
    scroll::execute(
        scroll::ScrollArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            direction: Direction::Down,
            amount: 1,
            timeout_ms: None,
        },
        &adapter,
        &context,
    )
    .unwrap();

    for request in adapter.requests.lock().unwrap().iter() {
        assert_headless(request);
    }
}

#[test]
fn focus_command_is_explicit_headless_policy() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_id();
    let adapter = RecordingAdapter::new();

    focus::execute(ref_args(&snapshot_id), &adapter, &CommandContext::default()).unwrap();

    let request = adapter.last_request();
    assert!(matches!(request.action, Action::SetFocus));
    assert_eq!(request.policy, InteractionPolicy::headless());
}

#[test]
fn headed_context_reaches_every_ref_action_without_policy_downgrade() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_id();
    let adapter = RecordingAdapter::new();
    let context = CommandContext::default().with_headed(true);

    click::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    double_click::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    triple_click::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    let before_right_click = adapter.requests.lock().unwrap().len();
    let _ = right_click::execute(ref_args(&snapshot_id), &adapter, &context);
    assert_eq!(
        adapter.requests.lock().unwrap().len(),
        before_right_click + 1,
        "a headed right click must still reach the adapter"
    );
    clear::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    toggle::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    check::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    uncheck::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    expand::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    collapse::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    scroll_to::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    focus::execute(ref_args(&snapshot_id), &adapter, &context).unwrap();
    set_value::execute(
        set_value::SetValueArgs {
            ref_id: format!("@{}:e1", snapshot_id.clone()),
            value: "value".into(),
            timeout_ms: None,
        },
        &adapter,
        &context,
    )
    .unwrap();
    select::execute(
        select::SelectArgs {
            ref_id: format!("@{}:e1", snapshot_id.clone()),
            value: "choice".into(),
            timeout_ms: None,
        },
        &adapter,
        &context,
    )
    .unwrap();
    type_text::execute(
        type_text::TypeArgs {
            ref_id: format!("@{}:e1", snapshot_id.clone()),
            text: "text".into(),
            timeout_ms: None,
            interval_ms: None,
        },
        &adapter,
        &context,
    )
    .unwrap();
    scroll::execute(
        scroll::ScrollArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            direction: Direction::Down,
            amount: 1,
            timeout_ms: None,
        },
        &adapter,
        &context,
    )
    .unwrap();

    for request in adapter.requests.lock().unwrap().iter() {
        assert_eq!(
            request.policy,
            InteractionPolicy::headed(),
            "unexpected policy for {:?}",
            request.action
        );
    }
}

#[test]
fn every_ref_action_command_is_registered_in_the_policy_list() {
    let commands_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
    let covered: std::collections::BTreeSet<&str> =
        POLICY_TESTED_COMMANDS.iter().copied().collect();

    let mut uncovered: Vec<String> = std::fs::read_dir(&commands_dir)
        .expect("commands directory must be readable")
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "rs") {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .map(ToOwned::to_owned)
            } else {
                None
            }
        })
        .filter(|stem| !stem.ends_with("_tests"))
        .filter(|stem| {
            if covered.contains(stem.as_str()) {
                return false;
            }
            let path = commands_dir.join(format!("{stem}.rs"));
            let source = std::fs::read_to_string(&path).unwrap_or_default();
            source.contains("context.request_base(")
        })
        .collect();

    uncovered.sort();
    assert!(
        uncovered.is_empty(),
        "new ref-action command(s) call context.request_base( but are not in POLICY_TESTED_COMMANDS: {uncovered:?}\n\
         Add each stem to POLICY_TESTED_COMMANDS and write a matching policy assertion."
    );
}
