//! Where the label card is in its appearance.
//!
//! A card whose text has just changed is held back until the cursor has
//! finished travelling and then eased in. The reference reveals it after the
//! movement rather than during it, so the eye follows the cursor to its
//! destination and reads the caption once it arrives — a card fading in
//! alongside a moving cursor competes with it.
//!
//! Kept apart from the host so the rule can be driven directly. Every
//! transition here is reachable from a test, which the host's own paint path
//! is not.

use super::schedule;
use agent_desktop_core::CURSOR_LABEL_REVEAL_MS;
use std::time::Instant;

#[derive(Clone, Copy)]
pub(crate) enum Reveal {
    /// Nothing is appearing. A card, if there is one, is drawn in full.
    Settled,
    /// The text changed and the cursor has not arrived yet, so the card is
    /// not drawn at all.
    Pending,
    /// Easing in since this instant.
    Playing(Instant),
}

impl Reveal {
    /// What a label change means for the card: text arriving has to appear,
    /// text going away has nothing to appear.
    pub(crate) fn for_label(label: Option<&str>) -> Self {
        match label {
            Some(_) => Self::Pending,
            None => Self::Settled,
        }
    }

    /// Starts the ease, if a card is waiting to appear. Called once the
    /// cursor has landed.
    pub(crate) fn begin(&mut self) {
        if matches!(self, Self::Pending) {
            *self = Self::Playing(Instant::now());
        }
    }

    /// How opaque the card should be drawn right now.
    pub(crate) fn opacity(&self) -> f64 {
        match self {
            Self::Settled => 1.0,
            Self::Pending => 0.0,
            Self::Playing(started) => schedule::reveal_progress(
                started.elapsed().as_millis() as u64,
                CURSOR_LABEL_REVEAL_MS,
            ),
        }
    }

    /// Whether the ease is still running, so a caller knows to keep drawing
    /// frames rather than leaving the card half-arrived.
    pub(crate) fn is_playing(&self) -> bool {
        match self {
            Self::Playing(started) => {
                (started.elapsed().as_millis() as u64) < CURSOR_LABEL_REVEAL_MS
            }
            Self::Settled | Self::Pending => false,
        }
    }
}

#[cfg(test)]
#[path = "reveal_tests.rs"]
mod tests;
