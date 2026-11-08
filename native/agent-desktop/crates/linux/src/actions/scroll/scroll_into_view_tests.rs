use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use super::*;

#[derive(Clone)]
struct Clockwork {
    now: Rc<Cell<Duration>>,
    lease: Duration,
}

impl Waiter for Clockwork {
    fn elapsed(&self) -> Duration {
        self.now.get()
    }

    fn pause(&mut self, span: Duration) {
        self.now.set(self.now.get() + span);
    }

    fn remaining(&self) -> Duration {
        self.lease.saturating_sub(self.now.get())
    }
}

fn clock(lease_ms: u64) -> Clockwork {
    Clockwork {
        now: Rc::new(Cell::new(Duration::ZERO)),
        lease: Duration::from_millis(lease_ms),
    }
}

fn rect(x: i32, y: i32, width: i32, height: i32) -> Extents {
    Extents {
        x,
        y,
        width,
        height,
    }
}

struct Fake {
    clock: Clockwork,
    toolkit: &'static str,
    view: View,
    scroll_to_answer: bool,
    scroll_to_moves: bool,
    scroll_to_calls: usize,
    bar: BarFound,
    range: Option<BarRange>,
    geometry: Geometry,
    latency: Duration,
    writes: Vec<f64>,
    moves_on_write: bool,
    arrival: Option<Duration>,
    bar_axis: Option<Axis>,
    observe_error: bool,
    observe_stale: bool,
    view_stale: bool,
}

impl Fake {
    fn new(clock: Clockwork) -> Self {
        Self {
            clock,
            toolkit: "GTK",
            view: View {
                offscreen: Some(true),
                hidden: false,
                window_minimized: false,
                bounds_provable: true,
            },
            scroll_to_answer: false,
            scroll_to_moves: false,
            scroll_to_calls: 0,
            bar: BarFound::Found {
                extents: Some(rect(410, 0, 10, 420)),
            },
            range: Some(BarRange {
                min: 0.0,
                max: 10_482.0,
                current: 0.0,
            }),
            geometry: Geometry {
                target: Some(rect(2, 5526, 420, 22)),
                container: Some(rect(0, 0, 420, 420)),
                frame: Some(rect(0, 0, 420, 420)),
                neighbour: None,
            },
            latency: Duration::from_millis(600),
            writes: Vec::new(),
            moves_on_write: true,
            arrival: None,
            bar_axis: None,
            observe_error: false,
            observe_stale: false,
            view_stale: false,
        }
    }

    fn arrives_in(&mut self, latency: Duration) {
        self.arrival = Some(self.clock.now.get() + latency);
    }
}

impl ScrollPort for Fake {
    fn toolkit(&mut self) -> ToolkitId {
        ToolkitId {
            name: Some(self.toolkit.to_owned()),
            version: None,
        }
    }

    fn view(&mut self) -> Result<View, AdapterError> {
        if self.view_stale {
            return Err(stale());
        }
        Ok(self.view)
    }

    fn observe(&mut self) -> Result<Option<bool>, AdapterError> {
        if self.observe_stale {
            return Err(stale());
        }
        if self.observe_error {
            return Err(AdapterError::timeout("observation timed out"));
        }
        let landed = self.arrival.is_some_and(|at| self.clock.now.get() >= at);
        Ok(Some(!landed))
    }

    fn scroll_to(&mut self) -> Result<bool, AdapterError> {
        self.scroll_to_calls += 1;
        if self.scroll_to_moves {
            let latency = self.latency;
            self.arrives_in(latency);
        }
        Ok(self.scroll_to_answer)
    }

    fn geometry(&mut self) -> Result<Geometry, AdapterError> {
        Ok(self.geometry)
    }

    fn find_bar(&mut self, axis: Axis) -> Result<BarFound, AdapterError> {
        if self.bar_axis.is_some_and(|only| only != axis) {
            return Ok(BarFound::Missing { container: true });
        }
        Ok(self.bar)
    }

    fn range(&mut self) -> Result<Option<BarRange>, AdapterError> {
        Ok(self.range)
    }

    fn write(&mut self, value: f64) -> Result<(), AdapterError> {
        self.writes.push(value);
        if self.moves_on_write {
            let latency = self.latency;
            self.arrives_in(latency);
        }
        Ok(())
    }
}

fn stale() -> AdapterError {
    AdapterError::stale_ref_because("Stored ref's element no longer exists")
}

fn cause(error: &AdapterError) -> String {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("cause"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

#[test]
fn a_write_realised_at_1_3_seconds_is_a_success_and_not_a_failure_at_0_6() {
    let mut waiter = clock(5_000);
    let mut port = Fake::new(waiter.clone());
    port.latency = Duration::from_millis(1_300);
    drive(&mut port, &mut waiter).expect("the target arrives within the window");
    assert_eq!(port.writes, vec![5_526.0]);
}

#[test]
fn scroll_to_returning_true_is_never_taken_for_the_target_arriving() {
    let mut waiter = clock(10_000);
    let mut port = Fake::new(waiter.clone());
    port.toolkit = "Chromium";
    port.scroll_to_answer = true;
    port.scroll_to_moves = false;
    drive(&mut port, &mut waiter).expect("the bar rung moves the target");
    assert_eq!(port.scroll_to_calls, 1);
    assert_eq!(port.writes.len(), 1);
}

#[test]
fn scroll_to_that_moves_the_target_needs_no_bar_write() {
    let mut waiter = clock(10_000);
    let mut port = Fake::new(waiter.clone());
    port.toolkit = "Chromium";
    port.scroll_to_answer = true;
    port.scroll_to_moves = true;
    port.latency = Duration::from_millis(730);
    drive(&mut port, &mut waiter).expect("scroll_to moves the target");
    assert!(port.writes.is_empty());
}

#[test]
fn scroll_to_answering_false_moves_on_to_the_bar() {
    let mut waiter = clock(10_000);
    let mut port = Fake::new(waiter.clone());
    port.toolkit = "Chromium";
    drive(&mut port, &mut waiter).expect("the bar moves the target");
    assert_eq!(port.scroll_to_calls, 1);
    assert_eq!(port.writes.len(), 1);
}

#[test]
fn gtk_skips_scroll_to_because_it_never_moves_anything_there() {
    let mut waiter = clock(10_000);
    let mut port = Fake::new(waiter.clone());
    drive(&mut port, &mut waiter).expect("the bar moves the target");
    assert_eq!(port.scroll_to_calls, 0);
}

#[test]
fn a_target_already_on_screen_with_provable_bounds_is_left_alone() {
    let mut waiter = clock(5_000);
    let mut port = Fake::new(waiter.clone());
    port.view.offscreen = Some(false);
    drive(&mut port, &mut waiter).expect("nothing to do");
    assert!(port.writes.is_empty());
    assert_eq!(port.scroll_to_calls, 0);
}

#[test]
fn an_on_screen_target_whose_bounds_are_withheld_is_refused_with_the_true_cause() {
    let mut waiter = clock(5_000);
    let mut port = Fake::new(waiter.clone());
    port.view.offscreen = Some(false);
    port.view.bounds_provable = false;
    let error = drive(&mut port, &mut waiter).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(cause(&error), "bounds_not_provable");
    assert!(port.writes.is_empty());
    assert_eq!(port.scroll_to_calls, 0);
}

#[test]
fn a_hidden_target_is_refused_without_a_write() {
    let mut waiter = clock(5_000);
    let mut port = Fake::new(waiter.clone());
    port.view.offscreen = None;
    port.view.hidden = true;
    let error = drive(&mut port, &mut waiter).expect_err("refused");
    assert_eq!(cause(&error), "target_hidden");
    assert!(port.writes.is_empty());
}

#[test]
fn a_bar_already_at_the_limit_writes_nothing_and_says_so() {
    let mut waiter = clock(5_000);
    let mut port = Fake::new(waiter.clone());
    port.range = Some(BarRange {
        min: 0.0,
        max: 10_482.0,
        current: 10_482.0,
    });
    let error = drive(&mut port, &mut waiter).expect_err("at the limit");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(cause(&error), "scroll_bar_at_limit");
    assert!(port.writes.is_empty());
}

#[test]
fn a_toolkit_that_moves_nothing_ends_in_an_honest_failure_naming_what_was_tried() {
    let mut waiter = clock(10_000);
    let mut port = Fake::new(waiter.clone());
    port.toolkit = "Qt";
    port.bar = BarFound::Missing { container: true };
    let error = drive(&mut port, &mut waiter).expect_err("nothing moves it");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(cause(&error), "no_scroll_bar");
    let details = error.details.expect("details");
    assert_eq!(details["physical_delivery_started"], false);
    assert_eq!(
        details["rungs_tried"],
        serde_json::json!(["scroll_to", "scroll_bar_value"])
    );
}

#[test]
fn no_container_and_no_scroll_to_is_not_supported_and_names_the_container() {
    let mut waiter = clock(10_000);
    let mut port = Fake::new(waiter.clone());
    port.toolkit = "Chromium";
    port.bar = BarFound::Missing { container: false };
    let error = drive(&mut port, &mut waiter).expect_err("no route");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(cause(&error), "no_scroll_container");
}

#[test]
fn a_gtk3_target_without_a_position_scrolls_forward_by_its_sibling_distance() {
    let mut waiter = clock(10_000);
    let mut port = Fake::new(waiter.clone());
    port.geometry.target = None;
    port.geometry.neighbour = Some((250, rect(0, 60, 420, 40)));
    drive(&mut port, &mut waiter).expect("the bar moves the target");
    assert_eq!(port.writes, vec![10_060.0]);
    let mut backward = Fake::new(waiter.clone());
    backward.geometry.target = None;
    backward.geometry.neighbour = Some((-3, rect(0, 60, 420, 40)));
    backward.range = Some(BarRange {
        min: 0.0,
        max: 10_482.0,
        current: 5_000.0,
    });
    drive(&mut backward, &mut waiter).expect("the bar moves the target");
    assert_eq!(backward.writes, vec![4_940.0]);
}

#[test]
fn a_target_with_neither_a_position_nor_a_sibling_cannot_be_aimed_at() {
    let mut waiter = clock(10_000);
    let mut port = Fake::new(waiter.clone());
    port.geometry.target = None;
    let error = drive(&mut port, &mut waiter).expect_err("cannot aim");
    assert_eq!(cause(&error), "target_position_unknown");
    assert!(port.writes.is_empty());
}

#[test]
fn a_write_that_never_lands_ends_inside_the_lease_and_not_realised() {
    let mut waiter = clock(1_000);
    let mut port = Fake::new(waiter.clone());
    port.moves_on_write = false;
    let error = drive(&mut port, &mut waiter).expect_err("never lands");
    assert_eq!(cause(&error), "target_not_realised");
    assert!(waiter.now.get() <= Duration::from_millis(1_000));
}

#[test]
fn a_target_that_stays_off_after_each_write_is_rewritten_a_bounded_number_of_times() {
    let mut waiter = clock(60_000);
    let mut port = Fake::new(waiter.clone());
    port.moves_on_write = false;
    let error = drive(&mut port, &mut waiter).expect_err("never lands");
    assert_eq!(cause(&error), "target_not_realised");
    assert!(port.writes.len() <= MAX_WRITES);
}

#[test]
fn a_target_without_a_position_finds_the_horizontal_bar_when_no_vertical_one_moves() {
    let mut waiter = clock(10_000);
    let mut port = Fake::new(waiter.clone());
    port.geometry.target = None;
    port.geometry.neighbour = Some((250, rect(60, 0, 80, 200)));
    port.bar_axis = Some(Axis::Horizontal);
    drive(&mut port, &mut waiter).expect("the horizontal bar moves the target");
    assert_eq!(port.writes.len(), 1);
}

#[test]
fn a_target_in_a_minimized_window_gets_the_window_hidden_refusal_and_no_rung_runs() {
    let mut waiter = clock(5_000);
    let mut port = Fake::new(waiter.clone());
    port.view.window_minimized = true;
    let error = drive(&mut port, &mut waiter).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(cause(&error), "window_hidden");
    assert_eq!(port.scroll_to_calls, 0);
    assert!(port.writes.is_empty());
}

#[path = "scroll_delivery_tests.rs"]
mod delivery;
