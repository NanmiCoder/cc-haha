use super::{CursorOverlayConfig, CursorPhase};
use crate::{AdapterError, ErrorCode, Point, Rect};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CursorOverlayInstruction {
    destination: Point,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    drag_from: Option<Point>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    click: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<Rect>,
    #[serde(default)]
    phase: CursorPhase,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pointer: bool,
}

impl CursorOverlayInstruction {
    pub fn new(
        destination: Point,
        config: &CursorOverlayConfig,
        click: bool,
    ) -> Result<Self, AdapterError> {
        destination.validate()?;
        if !config.is_enabled() {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                "Agent cursor instruction requires enabled presentation",
            ));
        }
        Ok(Self {
            destination,
            drag_from: None,
            label: config.label().map(str::to_owned),
            click,
            target: None,
            phase: CursorPhase::Travel,
            pointer: false,
        })
    }

    pub const fn with_phase(mut self, phase: CursorPhase) -> Self {
        self.phase = phase;
        self
    }

    /// Arrive showing the pointer image: the travel ends on a pressable control.
    pub const fn with_pointer(mut self, pointer: bool) -> Self {
        self.pointer = pointer;
        self
    }

    pub const fn is_pointer(&self) -> bool {
        self.pointer
    }

    pub fn with_drag_from(mut self, drag_from: Option<Point>) -> Self {
        self.drag_from = drag_from;
        self
    }

    pub const fn drag_from(&self) -> Option<&Point> {
        self.drag_from.as_ref()
    }

    pub const fn phase(&self) -> CursorPhase {
        self.phase
    }

    pub fn with_target(mut self, target: Option<Rect>) -> Self {
        self.target =
            target.filter(|rect| rect.validate().is_ok() && rect.width > 0.0 && rect.height > 0.0);
        self
    }

    pub const fn target(&self) -> Option<&Rect> {
        self.target.as_ref()
    }

    pub fn validate(&self) -> Result<(), AdapterError> {
        self.destination.validate()?;
        if let Some(drag_from) = &self.drag_from {
            drag_from.validate()?;
        }
        Ok(())
    }

    pub fn destination(&self) -> &Point {
        &self.destination
    }

    pub fn label(&self) -> Option<&str> {
        self.label.as_deref()
    }

    pub const fn is_click(&self) -> bool {
        self.click
    }

    /// Whether this instruction sets the cursor off from `at` for somewhere
    /// else: a travel, or a drag from its origin, to a point
    /// [`CURSOR_SAME_POINT`](super::CURSOR_SAME_POINT) or more away. The agent's
    /// caret marks the field the cursor was typing in, so renderers clear it
    /// then and keep it for a travel that stays put, such as typing again into
    /// the same field.
    pub fn departs_from(&self, at: Option<&Point>) -> bool {
        let to = match self.phase {
            CursorPhase::Travel => &self.destination,
            CursorPhase::Drag => self.drag_from.as_ref().unwrap_or(&self.destination),
            _ => return false,
        };
        at.is_none_or(|at| (to.x - at.x).hypot(to.y - at.y) >= super::CURSOR_SAME_POINT)
    }
}

#[cfg(test)]
#[path = "instruction_tests.rs"]
mod instruction_tests;
