use std::cell::RefCell;
use std::collections::VecDeque;
use std::time::Duration;

use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, ErrorCode, MouseButton, Point, Rect,
};

use crate::input::backend::Backend;
use crate::input::delivery::Delivery;
use crate::input::delivery::Gate;
use crate::input::keyboard::keymap::Keymap;
use crate::input::keyboard::keysym_step::KeysymStep;
use crate::input::physical::target_world::PhysicalWorld;
use crate::input::plan::Plan;
use crate::tree::AtspiElement;

pub(crate) struct FakeWorld {
    pub(crate) backend: Backend,
    pub(crate) reads: RefCell<VecDeque<Option<bool>>>,
    pub(crate) focus_reads: RefCell<VecDeque<bool>>,
    pub(crate) bounds: Option<Rect>,
    pub(crate) log: RefCell<Vec<String>>,
    pub(crate) clip: Option<crate::tree::placement::Placement>,
    pub(crate) pointer_reads: RefCell<VecDeque<Result<(), AdapterError>>>,
    pub(crate) pointer_delays: RefCell<VecDeque<Duration>>,
    pub(crate) sink: Option<crate::input::x11::fake_sink::FakeSink>,
}

impl FakeWorld {
    pub(crate) fn x11() -> Self {
        Self::on(Backend::X11(":0".to_owned()))
    }

    pub(crate) fn wayland() -> Self {
        Self::on(Backend::Wayland)
    }

    fn on(backend: Backend) -> Self {
        Self {
            backend,
            reads: RefCell::new(VecDeque::from([Some(true)])),
            focus_reads: RefCell::new(VecDeque::from([true])),
            bounds: Some(Rect {
                x: 100.0,
                y: 200.0,
                width: 40.0,
                height: 20.0,
            }),
            log: RefCell::new(Vec::new()),
            clip: None,
            pointer_reads: RefCell::default(),
            pointer_delays: RefCell::default(),
            sink: None,
        }
    }

    pub(crate) fn active_script(self, reads: &[Option<bool>]) -> Self {
        *self.reads.borrow_mut() = reads.iter().copied().collect();
        self
    }

    pub(crate) fn with_bounds(mut self, bounds: Option<Rect>) -> Self {
        self.bounds = bounds;
        self
    }

    pub(crate) fn entries(&self) -> Vec<String> {
        self.log.borrow().clone()
    }

    pub(crate) fn count(&self, prefix: &str) -> usize {
        self.log
            .borrow()
            .iter()
            .filter(|entry| entry.starts_with(prefix))
            .count()
    }

    pub(crate) fn sent_nothing(&self) -> bool {
        self.count("sent") + self.count("moved") == 0
    }

    fn note(&self, entry: impl Into<String>) {
        self.log.borrow_mut().push(entry.into());
    }

    fn deliver(
        &self,
        units: impl IntoIterator<Item = bool>,
        gate: Gate<'_>,
    ) -> Result<Delivery, AdapterError> {
        let mut delivered = 0u32;
        for input in units {
            gate()?;
            self.note(if input { "sent" } else { "moved" });
            delivered += 1;
        }
        Ok(Delivery {
            delivered_events: delivered,
        })
    }
}

impl PhysicalWorld for FakeWorld {
    fn focus_target(&self, _: &AtspiElement, _: Deadline) -> Result<(), AdapterError> {
        self.note("focus_target");
        Ok(())
    }

    fn target_focused(&self, _: &AtspiElement, _: Deadline) -> Result<bool, AdapterError> {
        self.note("target_focused");
        let mut reads = self.focus_reads.borrow_mut();
        Ok(if reads.len() > 1 {
            reads.pop_front().unwrap()
        } else {
            *reads.front().unwrap()
        })
    }

    fn backend(&self) -> Result<Backend, AdapterError> {
        Ok(self.backend.clone())
    }

    fn keymap(&self, _deadline: Deadline) -> Result<Keymap, AdapterError> {
        self.note("keymap");
        let mut map = Keymap::sample();
        map.keysyms[16..20].copy_from_slice(&[0x6e, 0x4e, 0, 0]);
        Ok(map)
    }

    fn frame_active(
        &self,
        _element: &AtspiElement,
        _deadline: Deadline,
    ) -> Result<Option<bool>, AdapterError> {
        self.note("read_active");
        let mut reads = self.reads.borrow_mut();
        Ok(if reads.len() > 1 {
            reads.pop_front().flatten()
        } else {
            reads.front().copied().flatten()
        })
    }

    fn bounds(
        &self,
        _element: &AtspiElement,
        _deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        self.note("bounds");
        Ok(self.bounds)
    }

    fn validate_pointer(
        &self,
        element: &AtspiElement,
        point: &Point,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        if let Some(delay) = self.pointer_delays.borrow_mut().pop_front() {
            std::thread::sleep(delay);
            if deadline.is_expired() {
                return Err(deadline.timeout_error());
            }
        }
        if let Some(result) = self.pointer_reads.borrow_mut().pop_front() {
            return result;
        }
        match &self.clip {
            Some(placed) => crate::input::physical::physical_aim::validate(
                point,
                placed,
                element.scroll_container().is_some(),
            ),
            None => Ok(()),
        }
    }

    fn plan_click(
        &self,
        map: &Keymap,
        at: Point,
        button: &MouseButton,
        count: u32,
    ) -> Result<Plan, AdapterError> {
        self.note(format!("plan_click {},{} {button:?} {count}", at.x, at.y));
        crate::input::mouse::pointer_plan::plan_click(map, at, button, count, &[])
    }

    fn send_plans(
        &self,
        plans: Vec<Plan>,
        gate: Gate<'_>,
        deadline: Deadline,
    ) -> Result<Delivery, AdapterError> {
        if let Some(sink) = &self.sink {
            return crate::input::x11::fake_sink::run(sink, plans, gate, deadline, None);
        }
        self.deliver(
            plans.iter().map(|plan| {
                !plan
                    .steps
                    .iter()
                    .all(|step| matches!(step, crate::input::step::Step::MoveTo { .. }))
                    || plan.steps.is_empty()
            }),
            gate,
        )
    }

    fn send_keysyms(
        &self,
        chunks: &[Vec<KeysymStep>],
        gate: Gate<'_>,
        _deadline: Deadline,
    ) -> Result<Delivery, AdapterError> {
        self.deliver((0..chunks.len()).map(|_| true), gate)
    }

    fn pointer_refusal(&self, what: &'static str) -> AdapterError {
        AdapterError::new(
            ErrorCode::ActionNotSupported,
            format!("pointer_refusal {what}"),
        )
    }

    fn pause(&self, _duration: Duration) {
        self.note("pause");
    }
}

pub(crate) fn element() -> AtspiElement {
    AtspiElement::new(":1.2", "/leaf", 7)
}

pub(crate) fn deadline() -> Deadline {
    Deadline::detached_after(30_000).expect("a thirty second deadline must build")
}

pub(crate) fn expired() -> Deadline {
    let deadline = Deadline::detached_after(1).expect("a one millisecond deadline must build");
    std::thread::sleep(Duration::from_millis(5));
    deadline
}

pub(crate) fn check_of(error: &AdapterError) -> Option<String> {
    error
        .details
        .as_ref()
        .and_then(|details| details["check"].as_str())
        .map(str::to_owned)
}

pub(crate) fn not_delivered(error: &AdapterError) -> bool {
    error.disposition == DeliverySemantics::not_delivered()
}
