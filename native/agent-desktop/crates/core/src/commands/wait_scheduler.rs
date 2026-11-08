use std::time::Duration;

use crate::{Deadline, SignalFilter, WaitWakeup, adapter::PlatformAdapter};

pub(crate) const POLL_INTERVAL: Duration = Duration::from_millis(100);

pub(crate) struct WaitScheduler {
    wakeup: Option<Box<dyn WaitWakeup>>,
}

impl WaitScheduler {
    pub(crate) fn new(
        adapter: &dyn PlatformAdapter,
        filter: &SignalFilter,
        deadline: Deadline,
    ) -> Self {
        Self {
            wakeup: adapter.subscribe_wait(filter, deadline).ok().flatten(),
        }
    }

    pub(crate) fn wait(&mut self, deadline: Deadline) {
        if deadline.is_expired() {
            return;
        }
        let poll = deadline.capped(POLL_INTERVAL);
        if let Some(wakeup) = self.wakeup.as_mut() {
            if wakeup.wait(poll).is_ok() {
                return;
            }
            self.wakeup = None;
            return;
        }
        std::thread::sleep(poll.remaining());
    }
}
