//! Armed-and-counted state shared by every physical release guard.
//!
//! A click guard, a drag guard, and a key-release guard differ only in what
//! corrective input they post on abort (and, for the key guard, in tracking
//! which of several held keys that correction covers) and how they phrase
//! the recovery hint; the state machine underneath - armed until the final
//! release posts, counting committed injections - is one behaviour, and the
//! delivery report it produces is a contract (`delivered_events`,
//! `emergency_release_posted`, `emergency_release_acknowledged`, and the
//! not-delivered versus delivered-unverified split). Kept in one place so a
//! guard added later inherits the report instead of restating it, and so
//! the guards cannot drift apart on what an interrupted sequence claims.
//!
//! Cleanup itself stays with each guard's `Drop`: only the guard knows
//! whether the corrective post is a button-up in place or a move back to the
//! origin first.

use agent_desktop_core::{AdapterError, DeliverySemantics};

#[derive(Default)]
pub(crate) struct ReleaseState {
    armed: bool,
    delivered: usize,
}

impl ReleaseState {
    pub(crate) fn arm(&mut self) {
        self.armed = true;
    }

    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }

    pub(crate) fn mark_delivered(&mut self) {
        self.delivered = self.delivered.saturating_add(1);
    }

    pub(crate) fn delivered_units(&self) -> usize {
        self.delivered
    }

    pub(crate) fn should_release(&self) -> bool {
        self.armed
    }

    /// Folds the delivery evidence into a public error.
    ///
    /// Nothing committed yet means the caller may retry freely; anything
    /// committed means the OS may have acted on it, so the error carries
    /// what was posted and never claims the corrective release was
    /// acknowledged - `SendInput` cannot report that (A9-3).
    pub(crate) fn enrich_error(&self, error: AdapterError, suggestion: &str) -> AdapterError {
        if self.delivered_units() == 0 {
            return error.with_disposition(DeliverySemantics::not_delivered());
        }
        let error = error.with_disposition(DeliverySemantics::delivered_unverified());
        let mut details = error
            .details
            .clone()
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(map) = details.as_object_mut() {
            map.insert("delivered_events".into(), self.delivered_units().into());
            if self.should_release() {
                map.insert("emergency_release_posted".into(), true.into());
                map.insert("emergency_release_acknowledged".into(), false.into());
            }
        }
        error.with_details(details).with_suggestion(suggestion)
    }
}

#[cfg(test)]
#[path = "release_state_tests.rs"]
mod tests;
