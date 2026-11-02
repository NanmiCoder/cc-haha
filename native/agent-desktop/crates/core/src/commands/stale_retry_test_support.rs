use crate::{AdapterError, ErrorCode, adapter::NativeHandle};
use std::sync::atomic::{AtomicU32, Ordering};

pub(crate) struct StaleRetryCounter {
    calls: AtomicU32,
    fail_until: u32,
}

impl StaleRetryCounter {
    pub(crate) fn new(fail_until: u32) -> Self {
        Self {
            calls: AtomicU32::new(0),
            fail_until,
        }
    }

    pub(crate) fn attempt(&self) -> Result<NativeHandle, AdapterError> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if n <= self.fail_until {
            return Err(AdapterError::new(ErrorCode::StaleRef, "not yet resolvable")
                .with_details(serde_json::json!({ "retryable": true })));
        }
        Ok(NativeHandle::null())
    }

    pub(crate) fn calls(&self) -> u32 {
        self.calls.load(Ordering::SeqCst)
    }
}
