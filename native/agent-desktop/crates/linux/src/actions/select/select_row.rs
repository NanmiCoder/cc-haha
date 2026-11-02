use agent_desktop_core::{ActionResult, AdapterError, Deadline};

use super::select_pointer::{Pointer, already_satisfied, by_pointer_result};
use super::select_search::Hit;
use super::select_verify::read_verification;
use crate::actions::click::{POLL_STEP, observed_of, poll_until};
use crate::actions::context::Target;
use crate::actions::select::SELECT_SETTLE;
use crate::tree::AtspiElement;

/// Clicks `row` unless it is selected already, then waits for its `selected`
/// state: the click is delivered, and verified only by that state.
fn click_until_selected(
    row: &AtspiElement,
    pointer: &dyn Pointer,
    deadline: Deadline,
    mut read: impl FnMut() -> Option<bool>,
) -> Result<ActionResult, AdapterError> {
    if read() == Some(true) {
        return Ok(already_satisfied());
    }
    let steps = pointer.click(row)?;
    let selected = poll_until(deadline, SELECT_SETTLE, POLL_STEP, read, |selected| {
        *selected == Some(true)
    });
    by_pointer_result(steps, observed_of(selected))
}

/// Selects a row of a list by clicking it. The row is the child of the list
/// that holds the match.
pub(in crate::actions) fn click_row(
    target: &Target<'_>,
    hit: &Hit<AtspiElement>,
    display_value: &str,
    pointer: &dyn Pointer,
) -> Result<ActionResult, AdapterError> {
    let row = hit.row.as_ref().unwrap_or(&hit.item);
    click_until_selected(row, pointer, target.deadline, || {
        read_verification(target.bus, target, row, display_value, None)
    })
}

#[cfg(test)]
#[path = "select_row_tests.rs"]
mod tests;
