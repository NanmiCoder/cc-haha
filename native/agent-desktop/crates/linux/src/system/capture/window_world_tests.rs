use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use agent_desktop_core::{AdapterError, Deadline, DisplayInfo, ErrorCode, WindowInfo};

use crate::system::capture::window_context::WindowLookup;
use crate::system::capture::window_xid::XidOutcome;
use crate::system::x11::X11State;
use crate::system::x11::stacking::stacking_read::StackingRead;
use crate::system::x11::stacking::stacking_source::StackingSource;

pub(crate) struct Seq<T> {
    items: Mutex<(Vec<T>, usize)>,
}

impl<T: Clone> Seq<T> {
    pub(crate) fn of(items: Vec<T>) -> Self {
        Self {
            items: Mutex::new((items, 0)),
        }
    }

    pub(crate) fn next(&self) -> T {
        let mut guard = self.items.lock().expect("sequence lock");
        let at = guard.1.min(guard.0.len() - 1);
        guard.1 += 1;
        guard.0[at].clone()
    }

    pub(crate) fn set(&self, items: Vec<T>) {
        *self.items.lock().expect("sequence lock") = (items, 0);
    }
}

pub(crate) struct FakeStacking {
    pub(crate) reads: Seq<StackingRead>,
    pub(crate) per_target: Mutex<HashMap<u32, StackingRead>>,
    pub(crate) clients: Mutex<X11State>,
    pub(crate) read_count: AtomicUsize,
}

impl StackingSource for FakeStacking {
    fn read_within(&self, target_client: u32, _deadline: Deadline) -> StackingRead {
        self.read_count.fetch_add(1, Ordering::SeqCst);
        match self
            .per_target
            .lock()
            .expect("per target lock")
            .get(&target_client)
        {
            Some(read) => read.clone(),
            None => self.reads.next(),
        }
    }

    fn clients_within(&self, _deadline: Deadline) -> X11State {
        self.clients.lock().expect("clients lock").clone()
    }
}

pub(crate) struct FakeLookup {
    pub(crate) resolved: Seq<Option<WindowInfo>>,
    pub(crate) xids: Seq<XidOutcome>,
    pub(crate) displays: Seq<Option<Vec<DisplayInfo>>>,
    pub(crate) calls: AtomicUsize,
}

impl WindowLookup for FakeLookup {
    fn resolve(
        &self,
        _window: &WindowInfo,
        _deadline: Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.resolved
            .next()
            .ok_or_else(|| AdapterError::new(ErrorCode::WindowNotFound, "The window is gone"))
    }

    fn xid(&self, _window: &WindowInfo, _deadline: Deadline) -> XidOutcome {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.xids.next()
    }

    fn displays(&self, _deadline: Deadline) -> Result<Vec<DisplayInfo>, AdapterError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.displays
            .next()
            .ok_or_else(|| AdapterError::internal("displays unavailable"))
    }
}
