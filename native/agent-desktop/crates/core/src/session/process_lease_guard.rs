use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::{AdapterError, Deadline};

static PROCESS_LEASE_HELD: AtomicBool = AtomicBool::new(false);

pub struct ProcessLeaseGuard {
    contention_count: u64,
}

impl ProcessLeaseGuard {
    pub fn acquire(deadline: Deadline) -> Result<Self, AdapterError> {
        let mut contention_count = 0_u64;
        loop {
            if PROCESS_LEASE_HELD
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                if deadline.is_expired() {
                    PROCESS_LEASE_HELD.store(false, Ordering::Release);
                    return Err(timeout(deadline, contention_count));
                }
                return Ok(Self { contention_count });
            }
            contention_count = contention_count.saturating_add(1);
            let remaining = deadline.remaining();
            if remaining.is_zero() {
                return Err(timeout(deadline, contention_count));
            }
            std::thread::sleep(remaining.min(Duration::from_millis(1)));
        }
    }

    pub fn contention_count(&self) -> u64 {
        self.contention_count
    }
}

impl Drop for ProcessLeaseGuard {
    fn drop(&mut self) {
        PROCESS_LEASE_HELD.store(false, Ordering::Release);
    }
}

fn timeout(deadline: Deadline, contention_count: u64) -> AdapterError {
    deadline.timeout_error().with_details(serde_json::json!({
        "kind": "interaction_process_lock_timeout",
        "contention_count": contention_count,
    }))
}
