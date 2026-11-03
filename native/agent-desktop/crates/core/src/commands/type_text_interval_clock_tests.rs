use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::commands::type_text::{TypeArgs, execute};
use crate::refs::refs_test_support::HomeGuard;
use crate::{ActionRequest, ActionResult, AdapterError, CommandContext, RefEntry};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A field whose first keystroke is slow to land, as when the interaction
/// lease or the app stalls, recording when each keystroke arrived.
#[derive(Default)]
struct SlowFirstKeystroke {
    typed: Mutex<String>,
    landed: Mutex<Vec<Instant>>,
}

impl ObservationOps for SlowFirstKeystroke {
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
        [crate::actions::capability::TYPE_TEXT],
        adapter => crate::ElementState {
            role: "textfield".into(),
            states: Vec::new(),
            value: Some(adapter.typed.lock().unwrap().clone()),
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        }
    );
}

impl ActionOps for SlowFirstKeystroke {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        if self.landed.lock().unwrap().is_empty() {
            std::thread::sleep(Duration::from_millis(600));
        }
        if let crate::Action::TypeText(text) = request.action {
            self.typed.lock().unwrap().push_str(&text);
        }
        self.landed.lock().unwrap().push(Instant::now());
        Ok(ActionResult::delivered_unverified("type_text"))
    }
}

impl InputOps for SlowFirstKeystroke {}

impl SystemOps for SlowFirstKeystroke {
    crate::adapter::guarded_interaction_lease!();
}

/// A slow first keystroke pushes the grid back rather than leaving the rest
/// to catch up half an interval apart.
#[test]
fn a_slow_first_keystroke_does_not_rush_the_rest() {
    let _guard = HomeGuard::new();
    let snapshot_id =
        crate::commands::helpers::test_support::save_one_ref_snapshot("textfield", "SetValue");
    let adapter = SlowFirstKeystroke::default();

    execute(
        TypeArgs {
            ref_id: format!("@{snapshot_id}:e1"),
            text: "abcd".into(),
            timeout_ms: None,
            interval_ms: Some(200),
        },
        &adapter,
        &CommandContext::default(),
    )
    .expect("typing succeeds");

    assert_eq!(*adapter.typed.lock().unwrap(), "abcd");
    let landed = adapter.landed.lock().unwrap();
    let after_slow = landed[2] - landed[1];
    assert!(
        after_slow >= Duration::from_millis(90),
        "keystrokes landed {after_slow:?} apart"
    );
    let spread = landed[3] - landed[1];
    assert!(
        spread >= Duration::from_millis(300),
        "the last three keystrokes landed within {spread:?}, so the grid caught up \
         instead of sliding back"
    );
}
