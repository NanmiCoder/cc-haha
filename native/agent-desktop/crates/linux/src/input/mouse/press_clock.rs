use std::time::{Duration, Instant};

use agent_desktop_core::{AdapterError, Deadline, ErrorCode};
use serde_json::json;

/// Times the presses of a multi-click gesture against its press-to-press budget.
pub(crate) struct PressClock {
    budget: Option<Duration>,
    last_press: Option<Instant>,
}

impl PressClock {
    pub(crate) fn new(budget: Option<Duration>) -> Self {
        Self {
            budget,
            last_press: None,
        }
    }

    /// The command deadline cut to what is left of the budget since the last
    /// press. Refuses when none is left.
    pub(crate) fn check_deadline(&self, deadline: Deadline) -> Result<Deadline, AdapterError> {
        let (Some(budget), Some(pressed)) = (self.budget, self.last_press) else {
            return Ok(deadline);
        };
        let left = budget.saturating_sub(pressed.elapsed());
        if left.is_zero() {
            return Err(window_elapsed(budget));
        }
        Ok(deadline.capped(left))
    }

    pub(crate) fn pressed(&mut self) {
        self.last_press = Some(Instant::now());
    }

    /// A check that failed after its own deadline expired, while the command
    /// deadline still had time, ran out of the press budget, whatever the read
    /// that was cut short reported.
    pub(crate) fn explain(
        &self,
        error: AdapterError,
        check: Deadline,
        command: Deadline,
    ) -> AdapterError {
        match self.budget {
            Some(budget)
                if self.last_press.is_some() && check.is_expired() && !command.is_expired() =>
            {
                window_elapsed(budget)
            }
            _ => error,
        }
    }
}

fn window_elapsed(budget: Duration) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The receiver check did not finish inside the double-click window, so no further click was sent",
    )
    .with_details(json!({
        "kind": "multi_click_window",
        "budget_ms": budget.as_millis(),
    }))
    .with_suggestion("The clicks already sent were delivered as separate clicks; read the application before retrying")
}

#[cfg(test)]
#[path = "press_clock_tests.rs"]
mod tests;
