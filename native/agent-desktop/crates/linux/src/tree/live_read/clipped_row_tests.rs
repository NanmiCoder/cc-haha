use agent_desktop_core::{ActionOps, InputOps, ObservationOps, SystemOps};
use std::sync::Mutex;

use agent_desktop_core::{
    Action, ActionRequest, ActionResult, AdapterError, Deadline, InteractionLease, LiveElement,
    NativeHandle, Rect, RefEntry,
};

use crate::actions::physical_target::tests::fake::FakeWorld;
use crate::input::physical::target_pointer::{ClickSpec, click_steps};
use crate::system::x11::window::window_x11_state::WindowX11State;
use crate::tree::element::ancestry::Ancestry;
use crate::tree::live::test_support::{read_of, ref_entry, words};
use crate::tree::live_read::live_project::{live_element, pointer_rect};
use crate::tree::observe::node_evidence::evidence_for;
use crate::tree::placement::Placement;
use crate::tree::vocabulary::state_bits::{ENABLED, SHOWING, VISIBLE};
use crate::tree::{AtspiElement, Extents, Field, ObservedRead};

struct Sidebar {
    scene: Mutex<(ObservedRead, Placement)>,
    events: Mutex<Vec<String>>,
}

impl Sidebar {
    fn new() -> Self {
        let mut read = read_of(32, "Mouse & Touchpad", &["activate"]);
        read.node.traits.states = Field::Present(words(&[ENABLED, VISIBLE, SHOWING]));
        let frame = AtspiElement::new(":1.1", "/frame", 1);
        let pane = AtspiElement::new(":1.1", "/pane", 1);
        read.node
            .element
            .set_ancestry(Ancestry::of(Some(frame), Some(pane), false));
        let placed = Placement {
            node: Some(Extents {
                x: 0,
                y: 100,
                width: 40,
                height: 20,
            }),
            frame: Some(Extents {
                x: 0,
                y: 0,
                width: 500,
                height: 500,
            }),
            container: Some(Extents {
                x: 0,
                y: 0,
                width: 200,
                height: 105,
            }),
            x11: Some(WindowX11State {
                client_origin: (100, 100),
                client_id: 7,
                shadow: (0, 0, 0, 0),
                hidden: false,
            }),
            ..Placement::default()
        };
        Self {
            scene: Mutex::new((read, placed)),
            events: Mutex::default(),
        }
    }
}

impl ObservationOps for Sidebar {
    fn resolve_element_strict(
        &self,
        _: &RefEntry,
        _: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.events.lock().unwrap().push("resolve".into());
        Ok(self
            .scene
            .lock()
            .unwrap()
            .0
            .node
            .element
            .clone()
            .into_native_handle())
    }

    fn get_live_element(&self, _: &NativeHandle, _: Deadline) -> Result<LiveElement, AdapterError> {
        let scene = self.scene.lock().unwrap();
        let evidence = evidence_for(&scene.0, &scene.0.node.element);
        live_element(&scene.0, &evidence, &scene.1, false)
    }

    fn get_element_bounds(
        &self,
        _: &NativeHandle,
        _: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        let scene = self.scene.lock().unwrap();
        Ok(pointer_rect(&scene.0, &scene.1))
    }
}

impl ActionOps for Sidebar {
    fn scroll_into_view(&self, _: &NativeHandle, _: &InteractionLease) -> Result<(), AdapterError> {
        self.events.lock().unwrap().push("scroll".into());
        self.scene.lock().unwrap().1.node.as_mut().unwrap().y = 60;
        Ok(())
    }

    fn execute_action(
        &self,
        _: &NativeHandle,
        request: ActionRequest,
        lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        let scene = self.scene.lock().unwrap();
        let mut world = FakeWorld::x11().with_bounds(pointer_rect(&scene.0, &scene.1));
        world.clip = Some(scene.1.clone());
        let steps = click_steps(
            &world,
            &scene.0.node.element,
            ClickSpec::left(1, request.verified_point().cloned()),
            request.policy,
            lease.deadline(),
        )?;
        assert!(
            world
                .entries()
                .contains(&"plan_click 120,170 Left 1".to_owned())
        );
        assert_eq!(world.count("sent"), 1);
        self.events.lock().unwrap().push("click".into());
        Ok(ActionResult::from_execution(&Action::Click, steps))
    }
}

impl InputOps for Sidebar {}
impl SystemOps for Sidebar {
    fn resolve_window_strict(
        &self,
        window: &agent_desktop_core::WindowInfo,
        _: Deadline,
    ) -> Result<agent_desktop_core::WindowInfo, AdapterError> {
        Ok(window.clone())
    }

    fn focus_window(
        &self,
        _: &agent_desktop_core::WindowInfo,
        _: &InteractionLease,
    ) -> Result<(), AdapterError> {
        Ok(())
    }

    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        InteractionLease::guarded(deadline, ())
    }
}

#[test]
fn a_clipped_row_is_scrolled_into_view_and_clicked_at_its_new_geometry() {
    let adapter = Sidebar::new();
    let mut entry = ref_entry("option");
    entry.process.process_instance = Some("fixture-instance".into());
    entry.source.source_window_id = Some("fixture-window".into());
    entry.identity.name = Some("Mouse & Touchpad".into());
    entry.geometry.bounds = Some(Rect {
        x: 100.0,
        y: 200.0,
        width: 40.0,
        height: 20.0,
    });
    let result = agent_desktop_core::ref_action::execute_entry(
        &adapter,
        &entry,
        ActionRequest::headed(Action::Click),
    )
    .unwrap();
    assert_eq!(result.action, "click");
    let events = adapter.events.lock().unwrap();
    assert_eq!(*events, ["resolve", "scroll", "resolve", "click"]);
}
