use std::sync::atomic::{AtomicU8, AtomicU32, Ordering};

const STARTED: u8 = 1;
const CANCELLED: u8 = 2;

#[derive(Debug, Default)]
pub(crate) struct Progress {
    dispatch: AtomicU8,
    delivered: AtomicU32,
}

impl Progress {
    pub(crate) fn cancel(&self) {
        self.dispatch.fetch_or(CANCELLED, Ordering::SeqCst);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.dispatch.load(Ordering::SeqCst) & CANCELLED != 0
    }

    pub(crate) fn begin_dispatch(&self) -> bool {
        self.dispatch
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |state| {
                (state & CANCELLED == 0).then_some(state | STARTED)
            })
            .is_ok()
    }

    pub(crate) fn has_started(&self) -> bool {
        self.dispatch.load(Ordering::SeqCst) & STARTED != 0
    }

    pub(crate) fn record(&self, delivered: u32) {
        self.delivered.store(delivered, Ordering::SeqCst);
    }

    pub(crate) fn delivered(&self) -> u32 {
        self.delivered.load(Ordering::SeqCst)
    }
}
