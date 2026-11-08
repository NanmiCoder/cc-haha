use agent_desktop_core::AdapterError;
use serde_json::json;
use std::time::{Duration, Instant};

pub(crate) const MAX_IPC_SLICE: Duration = Duration::from_millis(250);

#[cfg(test)]
pub(crate) fn from_timeout(started: Instant, timeout: Duration) -> Instant {
    started.checked_add(timeout).unwrap_or(started)
}

pub(crate) fn from_operation(
    deadline: agent_desktop_core::Deadline,
) -> Result<Instant, AdapterError> {
    let remaining = deadline.remaining();
    if remaining.is_zero() {
        return Err(deadline.timeout_error());
    }
    Instant::now()
        .checked_add(remaining)
        .ok_or_else(|| AdapterError::timeout("Accessibility deadline overflowed"))
}

pub(crate) fn remaining(deadline: Instant) -> Result<Duration, AdapterError> {
    remaining_at(deadline, Instant::now())
}

pub(crate) fn prepare(
    element: &super::AXElement,
    deadline: Instant,
) -> Result<Duration, AdapterError> {
    super::properties::ax_ipc::prepare(element, deadline)
}

fn remaining_at(deadline: Instant, now: Instant) -> Result<Duration, AdapterError> {
    let remaining = deadline.saturating_duration_since(now);
    if remaining.is_zero() {
        return Err(
            AdapterError::timeout("Live locator deadline exhausted").with_details(json!({
                "kind": "locator_deadline_exhausted",
                "retryable": true,
            })),
        );
    }
    Ok(remaining)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remaining_budget_is_derived_from_one_absolute_deadline() {
        let started = Instant::now();
        let deadline = from_timeout(started, Duration::from_millis(100));
        let now = started + Duration::from_millis(40);

        assert_eq!(
            remaining_at(deadline, now).unwrap(),
            Duration::from_millis(60)
        );
    }

    #[test]
    fn exhausted_and_overflowing_budgets_fail_closed() {
        let started = Instant::now();
        let deadline = from_timeout(started, Duration::from_millis(1));

        let error = remaining_at(deadline, deadline).expect_err("deadline must be exhausted");
        assert!(error.is_explicitly_retryable());
        assert_eq!(from_timeout(started, Duration::MAX), started);
    }

    #[test]
    fn operation_deadline_rejects_expired_inputs() {
        assert!(from_operation(agent_desktop_core::Deadline::after(0).unwrap()).is_err());
    }
}
