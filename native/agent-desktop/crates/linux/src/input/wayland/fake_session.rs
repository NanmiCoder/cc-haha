use std::cell::RefCell;
use std::rc::Rc;

use agent_desktop_core::{AdapterError, Deadline};

use super::key_session::KeySession;

pub(super) struct FakeSession {
    log: Rc<RefCell<Vec<String>>>,
    pub(super) fail_on: Option<&'static str>,
    pub(super) drops_first_key: bool,
    pub(super) resumed: bool,
    pub(super) retains: bool,
    pub(super) arrived: Vec<(u32, bool)>,
    keys_seen: u32,
}

impl FakeSession {
    pub(super) fn new() -> Self {
        Self {
            log: Rc::default(),
            fail_on: None,
            drops_first_key: false,
            resumed: false,
            retains: false,
            arrived: Vec::new(),
            keys_seen: 0,
        }
    }

    pub(super) fn failing_on(label: &'static str) -> Self {
        Self {
            fail_on: Some(label),
            ..Self::new()
        }
    }

    pub(super) fn events(&self) -> Vec<String> {
        self.log.borrow().clone()
    }

    pub(super) fn log(&self) -> Rc<RefCell<Vec<String>>> {
        Rc::clone(&self.log)
    }

    fn record(&mut self, label: String) -> Result<(), AdapterError> {
        self.log.borrow_mut().push(label.clone());
        if self.fail_on == Some(label.as_str()) {
            return Err(AdapterError::internal("the fake failed this step")
                .with_suggestion("Retry the command"));
        }
        Ok(())
    }
}

impl KeySession for FakeSession {
    fn create(&mut self, _deadline: Deadline) -> Result<(), AdapterError> {
        self.record("create".into())
    }

    fn start(&mut self, _deadline: Deadline) -> Result<(), AdapterError> {
        self.record("start".into())
    }

    fn keysym(&mut self, keysym: u32, down: bool, _deadline: Deadline) -> Result<(), AdapterError> {
        let edge = if down { "down" } else { "up" };
        let first = self.keys_seen == 0;
        self.keys_seen += 1;
        if !(self.drops_first_key && first) {
            self.arrived.push((keysym, down));
        }
        self.record(format!("{edge}:{keysym:x}"))
    }

    fn stop(&mut self, _deadline: Deadline) -> Result<(), AdapterError> {
        self.record("stop".into())
    }

    fn resumed(&self) -> bool {
        self.resumed
    }

    fn retain(&self) -> bool {
        self.retains
    }
}
