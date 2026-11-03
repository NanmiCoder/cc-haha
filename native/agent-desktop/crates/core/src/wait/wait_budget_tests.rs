use std::time::Instant;

use crate::{Deadline, ErrorCode, MAX_WAIT_TIMEOUT_MS, wait_timeout_duration};

#[test]
fn maximum_timeout_is_accepted() {
    assert_eq!(
        wait_timeout_duration(MAX_WAIT_TIMEOUT_MS)
            .unwrap()
            .as_millis(),
        u128::from(MAX_WAIT_TIMEOUT_MS)
    );
}

#[test]
fn oversized_timeout_is_rejected_before_deadline_math() {
    let error = wait_timeout_duration(u64::MAX).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(error.details.unwrap()["timeout_ms"], u64::MAX);
    assert_eq!(
        Deadline::at(Instant::now(), u64::MAX).unwrap_err().code,
        ErrorCode::InvalidArgs
    );
}
