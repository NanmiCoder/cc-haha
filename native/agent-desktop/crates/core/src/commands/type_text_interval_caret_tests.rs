use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::commands::type_text::{TypeArgs, execute};
use crate::refs::refs_test_support::HomeGuard;
use crate::{
    ActionRequest, ActionResult, AdapterError, CommandContext, CursorOverlayControl, CursorPhase,
    Rect, RefEntry, actions::capability,
};
use std::sync::Mutex;

/// A text field that reports an insertion point and records what the
/// overlay was asked to draw.
#[derive(Default)]
struct CaretField {
    typed: Mutex<String>,
    presented: Mutex<Vec<CursorOverlayControl>>,
}

impl ObservationOps for CaretField {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_insertion_caret(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        let typed = self.typed.lock().unwrap().chars().count() as f64;
        Ok(Some(Rect {
            x: 10.0 + typed * 7.0,
            y: 4.0,
            width: 2.0,
            height: 14.0,
        }))
    }

    crate::adapter::complete_live_observation!(
        "textfield",
        "Name",
        [capability::CLICK, capability::TYPE_TEXT],
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

impl ActionOps for CaretField {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        if let crate::Action::TypeText(text) = request.action {
            self.typed.lock().unwrap().push_str(&text);
        }
        Ok(ActionResult::delivered_unverified("type_text"))
    }
}

impl InputOps for CaretField {}

impl SystemOps for CaretField {
    crate::adapter::guarded_interaction_lease!();
    crate::adapter::exact_window_focus!();

    fn update_cursor_overlay(&self, control: &CursorOverlayControl) -> Result<(), AdapterError> {
        self.presented.lock().unwrap().push(control.clone());
        Ok(())
    }
}

fn field_in_session(session: &str) -> String {
    let bounds = Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    let mut entry = crate::adapter::minimal_ref_entry("textfield", Some("Name"));
    entry.geometry.bounds = Some(bounds);
    entry.geometry.bounds_hash = bounds.bounds_hash();
    entry.capabilities.available_actions =
        vec![capability::CLICK.into(), capability::TYPE_TEXT.into()];
    entry.source.source_app = Some("Fixture".into());
    entry.source.source_window_id = Some("w-42".into());
    entry.source.source_window_title = Some("Fixture".into());
    let mut refmap = crate::refs::RefMap::new();
    refmap.allocate(entry);
    crate::refs::refs_store::RefStore::for_session(Some(session))
        .expect("the session store")
        .save_new_snapshot(&refmap)
        .expect("the snapshot")
}

/// `type --interval-ms` keeps the caret on the insertion point as it types:
/// the first keystroke places it, and every keystroke after it moves it.
#[test]
fn an_interval_burst_moves_the_caret_with_every_keystroke() {
    let _home = HomeGuard::new();
    let snapshot_id = field_in_session("test-session");
    let adapter = CaretField::default();
    let config = crate::CursorOverlayConfig::enabled(None, 6).expect("valid config");
    let context = CommandContext::default().with_cursor_overlay_session("test-session", config);

    execute(
        TypeArgs {
            ref_id: format!("@{snapshot_id}:e1"),
            text: "hello".into(),
            timeout_ms: None,
            interval_ms: Some(5),
        },
        &adapter,
        &context,
    )
    .expect("typing succeeds");

    let carets: Vec<f64> = adapter
        .presented
        .lock()
        .unwrap()
        .iter()
        .filter_map(CursorOverlayControl::instruction)
        .filter(|instruction| instruction.phase() == CursorPhase::Caret)
        .filter_map(|instruction| instruction.target().map(|caret| caret.x))
        .collect();
    assert_eq!(
        carets,
        [17.0, 24.0, 31.0, 38.0, 45.0],
        "one caret per keystroke, each at the insertion point it left"
    );
}
