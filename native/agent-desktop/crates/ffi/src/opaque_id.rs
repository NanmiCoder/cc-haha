use std::sync::atomic::{AtomicUsize, Ordering};

use agent_desktop_core::{AdapterError, ErrorCode};

pub(crate) fn allocate(
    counter: &AtomicUsize,
    resource: &'static str,
) -> Result<usize, AdapterError> {
    counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |next| {
            next.checked_add(1)
        })
        .map_err(|_| {
            AdapterError::new(
                ErrorCode::Internal,
                format!("{resource} identifier space exhausted"),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocation_never_wraps_or_reuses_zero() {
        let counter = AtomicUsize::new(usize::MAX);
        assert!(allocate(&counter, "Test").is_err());
        assert_eq!(counter.load(Ordering::Relaxed), usize::MAX);
    }
}
