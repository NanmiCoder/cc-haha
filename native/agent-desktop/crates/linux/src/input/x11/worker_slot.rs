use std::sync::{Arc, Condvar, Mutex, OnceLock, PoisonError};

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use serde_json::json;

/// One input worker at a time. A call whose deadline passed returns while its
/// worker is still releasing held input; the next call must not start until
/// that release is over, or the release would land inside the new gesture.
#[derive(Debug, Default)]
pub(crate) struct WorkerSlot {
    busy: Mutex<bool>,
    freed: Condvar,
}

pub(crate) struct SlotGuard {
    slot: Arc<WorkerSlot>,
}

pub(crate) fn shared() -> Arc<WorkerSlot> {
    static SLOT: OnceLock<Arc<WorkerSlot>> = OnceLock::new();
    Arc::clone(SLOT.get_or_init(Arc::default))
}

impl WorkerSlot {
    pub(crate) fn claim(self: &Arc<Self>, deadline: Deadline) -> Result<SlotGuard, AdapterError> {
        let mut busy = self.busy.lock().unwrap_or_else(PoisonError::into_inner);
        while *busy {
            let left = deadline.remaining();
            if left.is_zero() {
                return Err(release_outstanding());
            }
            busy = self
                .freed
                .wait_timeout(busy, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        *busy = true;
        Ok(SlotGuard {
            slot: Arc::clone(self),
        })
    }
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        *self
            .slot
            .busy
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = false;
        self.slot.freed.notify_all();
    }
}

fn release_outstanding() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "An earlier input call is still releasing its input, so this call sent nothing",
    )
    .with_suggestion("Wait a moment, then retry")
    .with_details(json!({
        "cause": "previous_release_outstanding",
        "physical_delivery_started": false,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
}
