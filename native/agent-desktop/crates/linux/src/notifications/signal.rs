use std::time::{Duration, Instant};

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, WaitWakeup};
use zbus::MatchRule;
use zbus::message::Type;

use crate::system::signal::subscription::Subscription;

pub(crate) const SETTLE_BUDGET: Duration = Duration::from_millis(3_000);
const QUIET_AFTER_SIGNAL: Duration = Duration::from_millis(150);
const KEPT: usize = 64;
const INTERFACE: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Signal {
    ActionInvoked(u32),
    Closed(u32),
}

/// A subscription made before a press. Collecting from it, or dropping it,
/// ends its reader thread.
pub(crate) trait Held {
    fn collect(self: Box<Self>, budget: Duration) -> Vec<Signal>;
}

pub(crate) trait SignalSource {
    fn subscribe(&self, deadline: Deadline) -> Result<Box<dyn Held>, AdapterError>;
}

pub(crate) struct BusSignals;

impl SignalSource for BusSignals {
    fn subscribe(&self, deadline: Deadline) -> Result<Box<dyn Held>, AdapterError> {
        let fault = |error: zbus::Error| {
            AdapterError::new(
                ErrorCode::Internal,
                "The notification signals could not be subscribed to",
            )
            .with_platform_detail(error.to_string())
        };
        let rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .interface(INTERFACE)
            .map_err(fault)?
            .path(PATH)
            .map_err(fault)?
            .build();
        let held = Subscription::on_session(
            rule,
            KEPT,
            Box::new(|message| parse(message).is_some()),
            deadline,
        )?;
        Ok(Box::new(held))
    }
}

impl Held for Subscription {
    /// Waits until the budget ends, the stream ends, or nothing more arrived
    /// for `QUIET_AFTER_SIGNAL` after a first signal. The budget bounds the
    /// wait; the operation deadline never does.
    fn collect(mut self: Box<Self>, budget: Duration) -> Vec<Signal> {
        let started = Instant::now();
        let mut seen = Vec::new();
        loop {
            let left = budget.saturating_sub(started.elapsed());
            let wait = if seen.is_empty() {
                left
            } else {
                left.min(QUIET_AFTER_SIGNAL)
            };
            let Ok(deadline) = Deadline::detached_after(wait.as_millis() as u64) else {
                return seen;
            };
            if wait.is_zero() || self.wait(deadline).is_err() {
                return seen;
            }
            let fresh: Vec<Signal> = self.take().iter().filter_map(parse).collect();
            if fresh.is_empty() {
                return seen;
            }
            seen.extend(fresh);
        }
    }
}

fn parse(message: &zbus::Message) -> Option<Signal> {
    let header = message.header();
    match header.member()?.as_str() {
        "ActionInvoked" => {
            let (id, _key): (u32, String) = message.body().deserialize().ok()?;
            Some(Signal::ActionInvoked(id))
        }
        "NotificationClosed" => {
            let (id, _reason): (u32, u32) = message.body().deserialize().ok()?;
            Some(Signal::Closed(id))
        }
        _ => None,
    }
}

#[cfg(test)]
#[path = "signal_tests.rs"]
mod tests;
