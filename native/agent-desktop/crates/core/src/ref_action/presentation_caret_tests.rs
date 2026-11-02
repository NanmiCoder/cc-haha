use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::ref_action::execute_entry_with_context;
use crate::{
    Action, ActionRequest, ActionResult, AdapterError, CommandContext, CursorOverlayControl,
    CursorPhase, Rect, RefEntry, actions::capability,
};
use std::sync::Mutex;

const CARET: Rect = Rect {
    x: 40.0,
    y: 4.0,
    width: 2.0,
    height: 14.0,
};

struct CaretAdapter {
    caret: Option<Rect>,
    focused: bool,
    value: Mutex<Option<String>>,
    presented: Mutex<Vec<CursorOverlayControl>>,
}

impl CaretAdapter {
    fn new(caret: Option<Rect>) -> Self {
        Self {
            caret,
            focused: false,
            value: Mutex::new(None),
            presented: Mutex::new(Vec::new()),
        }
    }
}

impl ObservationOps for CaretAdapter {
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
        Ok(self.caret)
    }

    crate::adapter::complete_live_observation!(
        "textfield",
        "Name",
        [capability::CLICK, capability::TYPE_TEXT, capability::SET_VALUE],
        adapter => crate::ElementState {
            role: "textfield".into(),
            states: if adapter.focused {
                vec![crate::tree::state::FOCUSED.into()]
            } else {
                Vec::new()
            },
            value: adapter.value.lock().unwrap().clone(),
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        }
    );
}

impl ActionOps for CaretAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        if let Action::TypeText(text) | Action::SetValue(text) = &request.action {
            *self.value.lock().unwrap() = Some(text.clone());
        }
        Ok(ActionResult::delivered_unverified("type"))
    }
}

impl InputOps for CaretAdapter {}

impl SystemOps for CaretAdapter {
    crate::adapter::guarded_interaction_lease!();
    crate::adapter::exact_window_focus!();

    fn update_cursor_overlay(&self, control: &CursorOverlayControl) -> Result<(), AdapterError> {
        self.presented.lock().unwrap().push(control.clone());
        Ok(())
    }
}

fn field() -> RefEntry {
    let bounds = Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    let mut entry = crate::adapter::minimal_ref_entry("textfield", Some("Name"));
    entry.geometry.bounds = Some(bounds);
    entry.geometry.bounds_hash = bounds.bounds_hash();
    entry.capabilities.available_actions = vec![
        capability::CLICK.into(),
        capability::TYPE_TEXT.into(),
        capability::SET_VALUE.into(),
    ];
    entry.source.source_app = Some("Fixture".into());
    entry.source.source_window_id = Some("w-42".into());
    entry.source.source_window_title = Some("Fixture".into());
    entry
}

fn overlay_context() -> CommandContext {
    let config = crate::CursorOverlayConfig::enabled(None, 6).expect("valid config");
    CommandContext::default().with_cursor_overlay_session("test-session", config)
}

fn type_into(adapter: &CaretAdapter) {
    execute_entry_with_context(
        adapter,
        &field(),
        ActionRequest::headless(Action::TypeText("hello".into())),
        &overlay_context(),
    )
    .expect("type succeeds");
}

#[test]
fn typing_draws_the_caret_at_the_insertion_point_and_drops_the_outline() {
    let adapter = CaretAdapter::new(Some(CARET));
    type_into(&adapter);

    let presented = adapter.presented.lock().unwrap();
    let caret = presented
        .iter()
        .filter_map(CursorOverlayControl::instruction)
        .find(|instruction| instruction.phase() == CursorPhase::Caret)
        .expect("a caret instruction");
    assert_eq!(caret.target(), Some(&CARET));
    let effect = presented
        .iter()
        .filter_map(CursorOverlayControl::instruction)
        .find(|instruction| instruction.phase() == CursorPhase::Effect)
        .expect("an effect instruction");
    assert!(effect.is_click(), "typing clicks into its field first");
    assert!(
        effect.target().is_none(),
        "the caret marks the field, so the element outline is left off"
    );
}

#[test]
fn a_field_without_an_insertion_point_keeps_its_outline_and_draws_no_caret() {
    let adapter = CaretAdapter::new(None);
    type_into(&adapter);

    let presented = adapter.presented.lock().unwrap();
    assert!(
        presented
            .iter()
            .filter_map(CursorOverlayControl::instruction)
            .all(|instruction| instruction.phase() != CursorPhase::Caret)
    );
    let effect = presented
        .last()
        .and_then(CursorOverlayControl::instruction)
        .expect("an effect instruction");
    assert_eq!(effect.phase(), CursorPhase::Effect);
    assert!(effect.target().is_some());
}

#[test]
fn typing_into_a_field_that_already_has_focus_plays_no_click_ripple() {
    let adapter = CaretAdapter {
        focused: true,
        ..CaretAdapter::new(Some(CARET))
    };
    type_into(&adapter);

    let presented = adapter.presented.lock().unwrap();
    let effect = presented
        .iter()
        .filter_map(CursorOverlayControl::instruction)
        .find(|instruction| instruction.phase() == CursorPhase::Effect)
        .expect("an effect instruction");
    assert!(
        !effect.is_click(),
        "the field is typed into where it is, so nothing clicks into it"
    );
}
