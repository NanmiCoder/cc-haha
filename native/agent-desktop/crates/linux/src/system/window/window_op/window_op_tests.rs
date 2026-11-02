use std::cell::{Cell, RefCell};
use std::collections::VecDeque;

use agent_desktop_core::{ProcessId, WindowState};
use serde_json::Value;

use super::*;
use crate::system::process::process_facts::ProcessFacts;
use crate::system::window::window_id;
use crate::system::x11::twin_tie::Twins;
use crate::tree::Extents;

#[path = "window_op_refusal_tests.rs"]
mod refusals;

#[path = "window_op_place_tests.rs"]
mod place;

#[path = "window_op_hold_tests.rs"]
mod hold;

#[path = "window_op_settle_tests.rs"]
mod settle;

#[path = "window_op_wayland_tests.rs"]
mod wayland;

#[path = "window_op_twin_tests.rs"]
mod twin;

#[path = "window_op_shadow_world_tests.rs"]
mod shadow;

pub(super) const CLIENT: u32 = 0x0040_0003;
pub(super) const INSTANCE: &str = "abcd1234:99";

pub(super) struct World {
    pub(super) clients: RefCell<VecDeque<ControlRead<Vec<X11Client>>>>,
    pub(super) facts: RefCell<VecDeque<ControlRead<WindowFacts>>>,
    pub(super) lookups: RefCell<VecDeque<Lookup>>,
    pub(super) writes: RefCell<Vec<(u32, WindowWrite)>>,
    pub(super) write_result: Result<(), ControlError>,
    pub(super) lifts: Cell<u32>,
    pub(super) lift_result: Lifted,
    pub(super) overview: Option<bool>,
    pub(super) overview_reads: Cell<u32>,
    pub(super) wayland: bool,
    pub(super) stopped: bool,
    pub(super) reaction: Option<fn(&[WindowWrite]) -> WindowFacts>,
    pub(super) remembered: RefCell<Option<Extents>>,
    pub(super) remember_calls: RefCell<Vec<Option<Extents>>>,
    pub(super) twins: Option<Twins>,
    pub(super) active: Option<u32>,
}

pub(super) fn process(instance: &str) -> Lookup {
    Lookup::Found(ProcessFacts {
        executable: None,
        comm: "app".to_owned(),
        exe_basename: None,
        instance: instance.to_owned(),
    })
}

pub(super) fn client(id: u32, title: &str) -> X11Client {
    X11Client {
        shadow: (0, 0, 0, 0),
        id,
        hidden: false,
        pid: Some(100),
        title: title.to_owned(),
        extents: None,
        bounds: None,
    }
}

pub(super) fn state(x: i32, y: i32, width: i32, height: i32) -> WindowFacts {
    WindowFacts {
        client: Extents {
            x,
            y,
            width,
            height,
        },
        hidden: false,
        maximized_vertical: false,
        maximized_horizontal: false,
    }
}

impl World {
    pub(super) fn showing(facts: WindowFacts) -> Self {
        Self {
            clients: RefCell::new(VecDeque::from([ControlRead::Ready(vec![client(
                CLIENT, "Doc",
            )])])),
            facts: RefCell::new(VecDeque::from([ControlRead::Ready(facts)])),
            lookups: RefCell::new(VecDeque::from([process(INSTANCE)])),
            writes: RefCell::new(Vec::new()),
            write_result: Ok(()),
            lifts: Cell::new(0),
            lift_result: Lifted::Cleared,
            overview: None,
            overview_reads: Cell::new(0),
            wayland: false,
            stopped: false,
            reaction: None,
            remembered: RefCell::new(None),
            remember_calls: RefCell::new(Vec::new()),
            twins: None,
            active: None,
        }
    }

    pub(super) fn then_showing(self, facts: WindowFacts) -> Self {
        self.facts.borrow_mut().push_back(ControlRead::Ready(facts));
        self
    }

    pub(super) fn writes(&self) -> usize {
        self.writes.borrow().len()
    }
}

fn next<T: Clone>(queue: &RefCell<VecDeque<T>>) -> T {
    let mut queue = queue.borrow_mut();
    if queue.len() > 1 {
        queue.pop_front().expect("a queued answer")
    } else {
        queue.front().cloned().expect("an answer")
    }
}

impl ClientWorld for World {
    fn global_position(&self) -> bool {
        false
    }

    fn twins(&self, _win: &WindowInfo) -> Option<Twins> {
        self.twins.clone()
    }
}

impl OpWorld for World {
    fn lookup(&self, _pid: u32) -> Lookup {
        next(&self.lookups)
    }

    fn stopped(&self, _pid: u32) -> bool {
        self.stopped
    }

    fn clients(&self) -> ControlRead<Vec<X11Client>> {
        next(&self.clients)
    }

    fn active_client(&self) -> Option<u32> {
        self.active
    }

    fn facts(&self, _client: u32) -> ControlRead<WindowFacts> {
        if let Some(reaction) = self.reaction {
            let written: Vec<WindowWrite> = self
                .writes
                .borrow()
                .iter()
                .map(|(_, write)| write.clone())
                .collect();
            return ControlRead::Ready(reaction(&written));
        }
        next(&self.facts)
    }

    fn write(&self, client: u32, write: &WindowWrite) -> Result<(), ControlError> {
        self.writes.borrow_mut().push((client, write.clone()));
        self.write_result
    }

    fn lift(&self, _client: u32) -> Result<Lifted, AdapterError> {
        self.lifts.set(self.lifts.get() + 1);
        Ok(self.lift_result.clone())
    }

    fn overview_open(&self) -> Option<bool> {
        self.overview_reads.set(self.overview_reads.get() + 1);
        self.overview
    }

    fn remember(&self, _win: &WindowInfo, _client: u32, rectangle: Option<Extents>) {
        self.remember_calls.borrow_mut().push(rectangle);
        *self.remembered.borrow_mut() = rectangle;
    }

    fn remembered(&self, _win: &WindowInfo, _client: u32) -> Option<Extents> {
        *self.remembered.borrow()
    }

    fn on_wayland(&self) -> bool {
        self.wayland
    }

    fn displays(&self) -> Vec<Rect> {
        vec![Rect {
            x: 0.0,
            y: 0.0,
            width: 1280.0,
            height: 800.0,
        }]
    }
}

pub(super) fn window() -> WindowInfo {
    WindowInfo {
        id: window_id::encode(":1.7", "/org/a11y/atspi/accessible/5").expect("an id"),
        title: "Doc".to_owned(),
        app: "app".to_owned(),
        pid: ProcessId::new(100),
        process_instance: Some(INSTANCE.to_owned()),
        bounds: None,
        state: WindowState::default(),
    }
}

pub(super) fn budget() -> Deadline {
    Deadline::after(250).expect("a deadline builds")
}

pub(super) fn resize(width: f64, height: f64) -> WindowOp {
    WindowOp::Resize { width, height }
}

fn wide(width: i32, height: i32) -> WindowFacts {
    state(10, 10, width, height)
}

#[test]
fn a_read_back_in_transition_is_waited_out_not_judged() {
    let world = World::showing(wide(400, 300)).then_showing(wide(562, 693));
    run(&world, &window(), &resize(562.0, 693.0), budget()).expect("the settled read holds");
}

#[test]
fn a_clamped_resize_is_unverified_with_requested_observed_and_display_bounds() {
    let world = World::showing(wide(982, 797));
    let error = run(&world, &window(), &resize(982.0, 802.0), budget()).expect_err("a clamp");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.expect("details");
    assert_eq!(details["requested"]["height"], 802);
    assert_eq!(details["observed"]["height"], 797);
    assert_eq!(details["display_bounds"][0]["width"], 1280.0);
    assert_eq!(details["display_bounds"][0]["height"], 800.0);
    assert_eq!(details["target"]["id"], window().id);
    assert_eq!(details["target"]["process"]["instance"], INSTANCE);
    assert_eq!(details["steps"][0]["label"], "window_resize");
    assert_eq!(details["steps"][0]["outcome"], "succeeded");
    assert_eq!(details["steps"][0]["verified"], false);
}

#[test]
fn a_state_request_the_manager_ignored_is_unverified_without_display_bounds() {
    let world = World::showing(wide(300, 200));
    let error = run(&world, &window(), &WindowOp::Maximize, budget()).expect_err("ignored");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.expect("details");
    assert_eq!(details["requested"]["maximized"], true);
    assert!(details.get("display_bounds").is_none());
}

#[test]
fn a_read_that_never_answers_is_unverified_never_ok() {
    let mut world = World::showing(wide(1, 1));
    world.facts = RefCell::new(VecDeque::from([ControlRead::Unavailable]));
    let error = run(&world, &window(), &resize(5.0, 5.0), budget()).expect_err("no read-back");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.expect("details");
    assert_eq!(details["observed"], Value::Null);
    assert_eq!(details["cause"], "readback_unavailable");
}

#[test]
fn a_process_that_changed_after_the_write_is_not_found_and_unverified() {
    let world = World::showing(wide(562, 693));
    world
        .lookups
        .replace(VecDeque::from([process(INSTANCE), process("other:1")]));
    let error = run(&world, &window(), &resize(562.0, 693.0), budget()).expect_err("replaced");
    assert_eq!(error.code, ErrorCode::WindowNotFound);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(world.writes(), 1);
}

#[test]
fn a_destroyed_window_is_not_found_and_not_delivered() {
    let mut world = World::showing(wide(1, 1));
    world.write_result = Err(ControlError::BadWindow);
    let error = run(&world, &window(), &resize(5.0, 5.0), budget()).expect_err("gone");
    assert_eq!(error.code, ErrorCode::WindowNotFound);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn a_write_that_may_have_reached_the_server_is_uncertain() {
    let mut world = World::showing(wide(1, 1));
    world.write_result = Err(ControlError::SendFailed);
    let error = run(&world, &window(), &resize(5.0, 5.0), budget()).expect_err("broken");
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
}

#[test]
fn a_stopped_application_is_unresponsive_and_nothing_is_written_or_read() {
    let mut world = World::showing(wide(300, 200));
    world.stopped = true;
    for op in [
        resize(500.0, 400.0),
        WindowOp::Move { x: 1.0, y: 2.0 },
        WindowOp::Minimize,
        WindowOp::Maximize,
        WindowOp::Restore,
    ] {
        let error = run(&world, &window(), &op, budget()).expect_err("stopped");
        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    }
    assert_eq!(world.writes(), 0);
    assert_eq!(world.lifts.get(), 0);
}
